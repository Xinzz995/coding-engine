import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertDelegatedLeaseShape,
  assertRebootQuarantineAuthority,
  acquireDelegatedFinalizeRecoveryControlled,
  installDelegatedFinalizeRecoveryControlled,
  readStableDelegatedOperation,
  type DelegatedOperationSnapshot,
} from './delegated-recovery.js';
import {
  finalizeDelegatedRecoveryControlled,
  type DelegatedRecoveryCompletion,
  type DelegatedRecoveryFinalizationHooks,
} from './delegated-recovery-finalize.js';
import { digestBytes, jsonBytes, pathExists, readExactFile } from './filesystem.js';
import { readFixedPlatformHelperBundle } from './fixed-platform-helper.js';
import { classifySameHostRebootIdentity, createIdentityProbe } from './identity.js';
import { parseActiveChildRecord, ACTIVE_CHILD_FILE } from './operation-records.js';
import {
  acquirePrestartRecoveryControlled,
  assertLeaseShape as assertPrestartLeaseShape,
  assertPrestartRebootQuarantineAuthority,
  inspectPrestartRecoveryEligibilityControlled,
  installPrestartRecoveryControlled,
  readStableSnapshot as readStablePrestartSnapshot,
  type PrestartOperationSnapshot,
} from './prestart-recovery.js';
import {
  finalizePrestartRecoveryControlled,
  type PrestartRecoveryCompletion,
  type PrestartRecoveryFinalizationHooks,
} from './prestart-recovery-finalize.js';
import {
  acquireRecoveryAttemptControlled,
  installRecoveryDomainControlled,
  type RecoveryAttemptHandle,
  type RecoveryDomainHooks,
  type RecoveryModeAuthority,
} from './recovery-attempt.js';
import {
  finalizeMechanicalEmptyRecoveryControlled,
  type MechanicalEmptyRecoveryCompletion,
  type RecoveryFinalizationHooks,
} from './recovery-finalize.js';
import {
  loadRecoveryContext,
  readRecoveryDomainAtPath,
  type RecoveryContext,
  type RecoveryDomain,
} from './recovery-domain.js';
import type { RecoveryRebootProof } from './recovery-records.js';
import {
  assertMechanicalEmptyEligibility,
  captureRecoverySourceFromRecords,
} from './recovery-source-snapshot.js';
import {
  assertExactContainmentQuarantine,
  isQuarantineStagingName,
  readQuarantinePresence,
  type ExactContainmentQuarantine,
  type QuarantineRecord,
} from './quarantine.js';
import {
  ACTIVE_LEASE_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  type IdentityVerdict,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  WorkspaceSafetyError,
} from './types.js';

export type SameHostRebootRecoveryMode = 'mechanical-empty' | 'prestart' | 'delegated-finalize';

export interface ControlledInspectSameHostRebootRecoveryOptions {
  readonly workspacePath: string;
  readonly now?: () => Date;
  readonly helperBytes?: Uint8Array;
}

export interface InspectSameHostRebootRecoveryOptions {
  readonly workspacePath: string;
}

export interface ControlledInstallSameHostRebootRecoveryOptions extends ControlledInspectSameHostRebootRecoveryOptions {
  readonly recoveryId?: string;
  readonly attemptId?: string;
  readonly hooks?: RecoveryDomainHooks;
  readonly beforeReceiptSourceUnlink?: () => void | Promise<void>;
  /** Dark crash/race barrier after read-only planning and before any recovery staging. */
  readonly beforeClaimInstall?: () => void | Promise<void>;
}

export interface InstallSameHostRebootRecoveryOptions {
  readonly workspacePath: string;
}

export interface ControlledAcquireSameHostRebootRecoveryOptions {
  readonly workspacePath: string;
  readonly attemptId?: string;
  readonly now?: () => Date;
  readonly helperBytes?: Uint8Array;
}

export interface AcquireSameHostRebootRecoveryOptions {
  readonly workspacePath: string;
}

export interface ControlledFinalizeSameHostRebootRecoveryOptions {
  readonly now?: () => Date;
  readonly hooks?:
    | RecoveryFinalizationHooks
    | PrestartRecoveryFinalizationHooks
    | DelegatedRecoveryFinalizationHooks;
  readonly finalRenameCommitCheck?: () => void;
}

export type FinalizeSameHostRebootRecoveryOptions = undefined;

export interface SameHostRebootRecoveryPlan {
  readonly mode: SameHostRebootRecoveryMode;
  readonly workspacePath: string;
  readonly identity: ProcessIdentitySnapshot;
  readonly proof: RecoveryRebootProof;
  readonly sourceOwnerDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly quarantine: ExactContainmentQuarantine;
  readonly delegatedSnapshot?: DelegatedOperationSnapshot;
  readonly prestartSnapshot?: PrestartOperationSnapshot;
  readonly helperBytes?: Buffer;
}

interface SameHostRebootRecoveryHandleOptions {
  readonly mode: SameHostRebootRecoveryMode;
  readonly attempt: RecoveryAttemptHandle;
  readonly proof: RecoveryRebootProof;
  readonly sourceOwnerDigest: string;
  readonly quarantine: ExactContainmentQuarantine;
  readonly helperBytes?: Buffer;
}

const SAME_HOST_REBOOT_HANDLE_AUTHORITY = Symbol('same-host-reboot-handle-authority');
const SAME_HOST_REBOOT_HANDLE_BINDINGS = new WeakMap<
  SameHostRebootRecoveryHandle,
  SameHostRebootRecoveryHandleOptions
>();

export class SameHostRebootRecoveryHandle {
  constructor(
    token: typeof SAME_HOST_REBOOT_HANDLE_AUTHORITY,
    options: SameHostRebootRecoveryHandleOptions,
  ) {
    if (token !== SAME_HOST_REBOOT_HANDLE_AUTHORITY) {
      throw new WorkspaceSafetyError(
        'invalid',
        'same-host reboot handle authority token is invalid',
      );
    }
    SAME_HOST_REBOOT_HANDLE_BINDINGS.set(this, {
      mode: options.mode,
      attempt: options.attempt,
      proof: { ...options.proof },
      sourceOwnerDigest: options.sourceOwnerDigest,
      quarantine: {
        bytes: Buffer.from(options.quarantine.bytes),
        digest: options.quarantine.digest,
      },
      ...(options.helperBytes ? { helperBytes: Buffer.from(options.helperBytes) } : {}),
    });
    Object.freeze(this);
  }
}

function sameHostRebootHandleBinding(
  handle: SameHostRebootRecoveryHandle,
): SameHostRebootRecoveryHandleOptions {
  const binding = SAME_HOST_REBOOT_HANDLE_BINDINGS.get(handle);
  if (!binding) {
    throw new WorkspaceSafetyError('invalid', 'same-host reboot handle is not engine-issued');
  }
  return {
    mode: binding.mode,
    attempt: binding.attempt,
    proof: { ...binding.proof },
    sourceOwnerDigest: binding.sourceOwnerDigest,
    quarantine: {
      bytes: Buffer.from(binding.quarantine.bytes),
      digest: binding.quarantine.digest,
    },
    ...(binding.helperBytes ? { helperBytes: Buffer.from(binding.helperBytes) } : {}),
  };
}

export type SameHostRebootRecoveryCompletion =
  MechanicalEmptyRecoveryCompletion | PrestartRecoveryCompletion | DelegatedRecoveryCompletion;

function isolated(message: string): WorkspaceSafetyError {
  return new WorkspaceSafetyError('isolated', `Same-host reboot recovery is isolated: ${message}`);
}

function unsupported(message: string): WorkspaceSafetyError {
  return new WorkspaceSafetyError(
    'unsupported',
    `Same-host reboot recovery is unavailable: ${message}`,
  );
}

function currentIdentity(): ProcessIdentitySnapshot {
  return createIdentityProbe().current();
}

function assertSameHostChangedBoot(
  sourceOwner: OwnerRecord,
  current: ProcessIdentitySnapshot,
): void {
  const verdict = classifySameHostRebootIdentity(sourceOwner, current);
  if (verdict !== 'same-host-boot-changed') {
    throw isolated(verdict);
  }
}

function createProof(
  sourceOwner: OwnerRecord,
  current: ProcessIdentitySnapshot,
  verifiedAt: Date,
): RecoveryRebootProof {
  assertSameHostChangedBoot(sourceOwner, current);
  return {
    schemaVersion: 1,
    kind: 'same-host-boot-changed-v1',
    hostId: current.hostId,
    previousBootIdentity: sourceOwner.bootIdentity,
    currentBootIdentity: current.bootIdentity,
    verifiedAt: verifiedAt.toISOString(),
  };
}

function sameProof(left: RecoveryRebootProof, right: RecoveryRebootProof): boolean {
  return jsonBytes(left).equals(jsonBytes(right));
}

function sourceOwnerProbe(sourceOwnerDigest: string): (owner: OwnerRecord) => IdentityVerdict {
  return (owner) => (digestBytes(jsonBytes(owner)) === sourceOwnerDigest ? 'dead' : 'unknown');
}

async function exactCanonicalContainment(
  containerPath: string,
  label: string,
): Promise<{ authority: ExactContainmentQuarantine; record: QuarantineRecord }> {
  const presence = await readQuarantinePresence(containerPath);
  const canonical = presence.canonical;
  if (!canonical || canonical.linkedSource) {
    throw isolated(`${label} lacks one complete canonical containment quarantine`);
  }
  if ((await readdir(containerPath)).some((name) => isQuarantineStagingName(name))) {
    throw isolated(`${label} retains quarantine staging`);
  }
  if (canonical.record.reason !== 'containment-unconfirmed') {
    throw isolated(canonical.record.reason);
  }
  const authority: ExactContainmentQuarantine = {
    bytes: Buffer.from(canonical.bytes),
    digest: digestBytes(canonical.bytes),
  };
  assertExactContainmentQuarantine(authority, canonical.bytes);
  return { authority, record: canonical.record };
}

async function sourceOwnerBytes(context: RecoveryContext): Promise<Buffer> {
  return await readExactFile(
    join(context.records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OWNER_FILE),
  );
}

async function inspectInitialSource(options: {
  readonly workspacePath: string;
  readonly identity: ProcessIdentitySnapshot;
  readonly helperBytes?: Uint8Array;
}): Promise<Omit<SameHostRebootRecoveryPlan, 'proof'>> {
  const context = await loadRecoveryContext(options.workspacePath);
  assertSameHostChangedBoot(context.sourceOwner, options.identity);
  if (await pathExists(context.recoveryPath)) {
    throw new WorkspaceSafetyError('conflict', 'a canonical recovery domain already exists');
  }
  const ownerBytes = await sourceOwnerBytes(context);
  const sourceOwnerDigest = digestBytes(ownerBytes);
  const leasePath = join(context.records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  const operationPath = join(leasePath, OPERATION_DIR);

  if (!(await pathExists(operationPath))) {
    const quarantine = await exactCanonicalContainment(leasePath, 'active lease');
    await assertMechanicalEmptyEligibility(
      context.records,
      context.sourceOwner,
      false,
      quarantine.authority,
    );
    return {
      mode: 'mechanical-empty',
      workspacePath: context.records.workspace.path,
      identity: options.identity,
      sourceOwnerDigest,
      sourceSnapshotDigest: await captureRecoverySourceFromRecords(context.records),
      quarantine: quarantine.authority,
    };
  }

  const active = parseActiveChildRecord(
    await readExactFile(join(operationPath, ACTIVE_CHILD_FILE)),
  );
  if (active.state !== 'armed') {
    if (!options.helperBytes) throw unsupported('prepared operations require fixed helper bytes');
    const helperBytes = Buffer.from(options.helperBytes);
    await assertPrestartLeaseShape(context);
    const snapshot = await readStablePrestartSnapshot(context);
    const quarantine = await exactCanonicalContainment(operationPath, 'prestart operation');
    const probes = {
      helperBytes,
      probeSourceOwner: sourceOwnerProbe(sourceOwnerDigest),
      probeSupervisor: () => 'dead' as const,
      expectedRebootQuarantine: quarantine.authority,
    };
    assertPrestartRebootQuarantineAuthority(snapshot, probes);
    const inspected = await inspectPrestartRecoveryEligibilityControlled(
      options.workspacePath,
      probes,
    );
    return {
      mode: 'prestart',
      workspacePath: context.records.workspace.path,
      identity: options.identity,
      sourceOwnerDigest,
      sourceSnapshotDigest: inspected.sourceSnapshotDigest,
      quarantine: quarantine.authority,
      prestartSnapshot: snapshot,
      helperBytes,
    };
  }
  await assertDelegatedLeaseShape(context);
  const snapshot = await readStableDelegatedOperation(context);
  const quarantine = await exactCanonicalContainment(operationPath, 'armed operation');
  assertRebootQuarantineAuthority(snapshot, {
    expectedRebootQuarantine: quarantine.authority,
  });
  return {
    mode: 'delegated-finalize',
    workspacePath: context.records.workspace.path,
    identity: options.identity,
    sourceOwnerDigest,
    sourceSnapshotDigest: await captureRecoverySourceFromRecords(context.records),
    quarantine: quarantine.authority,
    delegatedSnapshot: snapshot,
  };
}

export async function inspectSameHostRebootRecoveryControlled(
  options: ControlledInspectSameHostRebootRecoveryOptions,
): Promise<SameHostRebootRecoveryPlan> {
  const identity = currentIdentity();
  const inspected = await inspectInitialSource({
    workspacePath: options.workspacePath,
    identity,
    helperBytes: options.helperBytes,
  });
  const context = await loadRecoveryContext(options.workspacePath);
  const proof = createProof(context.sourceOwner, identity, (options.now ?? (() => new Date()))());
  return { ...inspected, proof };
}

function mechanicalRebootAuthority(plan: SameHostRebootRecoveryPlan): RecoveryModeAuthority {
  const probe = sourceOwnerProbe(plan.sourceOwnerDigest);
  return {
    mode: 'mechanical-empty',
    verifySource: async ({ context, domain, expectedSourceSnapshotDigest, phase }) => {
      if (probe(context.sourceOwner) !== 'dead') {
        throw isolated('source owner bytes changed');
      }
      assertSameHostChangedBoot(context.sourceOwner, plan.identity);
      if (domain) {
        if (!domain.claim.rebootProof || !sameProof(domain.claim.rebootProof, plan.proof)) {
          throw isolated('installed claim does not bind the exact reboot proof');
        }
      }
      await assertMechanicalEmptyEligibility(
        context.records,
        context.sourceOwner,
        domain !== undefined,
        plan.quarantine,
      );
      const actual = await captureRecoverySourceFromRecords(context.records);
      if (actual === expectedSourceSnapshotDigest) return;
      if (phase === 'before-install' || phase === 'before-commit') {
        throw new WorkspaceSafetyError('conflict', 'reboot source changed before claim commit');
      }
      throw new WorkspaceSafetyError('invalid', 'reboot source changed under recovery authority');
    },
  };
}

function delegatedProbes(plan: SameHostRebootRecoveryPlan) {
  return {
    probeSourceOwner: sourceOwnerProbe(plan.sourceOwnerDigest),
    probeSupervisor: () => 'dead' as const,
    probeContainment: () => 'empty' as const,
    expectedRebootQuarantine: plan.quarantine,
  };
}

function prestartProbes(plan: SameHostRebootRecoveryPlan) {
  if (!plan.helperBytes) throw unsupported('prestart recovery lost its fixed helper bytes');
  return {
    helperBytes: plan.helperBytes,
    probeSourceOwner: sourceOwnerProbe(plan.sourceOwnerDigest),
    probeSupervisor: () => 'dead' as const,
    expectedRebootQuarantine: plan.quarantine,
  };
}

function rebootSystemAuthority(plan: SameHostRebootRecoveryPlan): () => Promise<void> {
  return async () => {
    const current = currentIdentity();
    if (!jsonBytes(current).equals(jsonBytes(plan.identity))) {
      throw isolated('reboot coordinator system identity changed');
    }
    const context = await loadRecoveryContext(plan.workspacePath);
    assertSameHostChangedBoot(context.sourceOwner, current);
    if (digestBytes(await sourceOwnerBytes(context)) !== plan.sourceOwnerDigest) {
      throw isolated('reboot coordinator source owner changed');
    }
    if (
      plan.proof.hostId !== current.hostId ||
      plan.proof.previousBootIdentity !== context.sourceOwner.bootIdentity ||
      plan.proof.currentBootIdentity !== current.bootIdentity
    ) {
      throw isolated('reboot coordinator proof no longer matches the current system');
    }
  };
}

export async function installSameHostRebootRecoveryControlled(
  options: ControlledInstallSameHostRebootRecoveryOptions,
): Promise<SameHostRebootRecoveryHandle> {
  const plan = await inspectSameHostRebootRecoveryControlled(options);
  const verifySystemAuthority = rebootSystemAuthority(plan);
  await options.beforeClaimInstall?.();
  let attempt: RecoveryAttemptHandle;
  if (plan.mode === 'mechanical-empty') {
    attempt = await installRecoveryDomainControlled(
      {
        workspacePath: plan.workspacePath,
        expectedSourceSnapshotDigest: plan.sourceSnapshotDigest,
        recoveryId: options.recoveryId,
        attemptId: options.attemptId,
        identity: plan.identity,
        mode: 'mechanical-empty',
        rebootProof: plan.proof,
        now: options.now,
        probeSourceOwner: sourceOwnerProbe(plan.sourceOwnerDigest),
        hooks: options.hooks,
        verifySystemAuthority,
      },
      mechanicalRebootAuthority(plan),
    );
  } else if (plan.mode === 'prestart') {
    attempt = await installPrestartRecoveryControlled({
      workspacePath: plan.workspacePath,
      recoveryId: options.recoveryId,
      attemptId: options.attemptId,
      identity: plan.identity,
      rebootProof: plan.proof,
      now: options.now,
      hooks: options.hooks,
      ...prestartProbes(plan),
      verifySystemAuthority,
    });
  } else {
    attempt = await installDelegatedFinalizeRecoveryControlled({
      workspacePath: plan.workspacePath,
      recoveryId: options.recoveryId,
      attemptId: options.attemptId,
      identity: plan.identity,
      rebootProof: plan.proof,
      now: options.now,
      hooks: options.hooks,
      beforeReceiptSourceUnlink: options.beforeReceiptSourceUnlink,
      ...delegatedProbes(plan),
      verifySystemAuthority,
    });
  }
  return new SameHostRebootRecoveryHandle(SAME_HOST_REBOOT_HANDLE_AUTHORITY, {
    mode: plan.mode,
    attempt,
    proof: plan.proof,
    sourceOwnerDigest: plan.sourceOwnerDigest,
    quarantine: plan.quarantine,
    ...(plan.helperBytes ? { helperBytes: plan.helperBytes } : {}),
  });
}

async function inspectContinuation(
  options: ControlledAcquireSameHostRebootRecoveryOptions,
): Promise<{ plan: SameHostRebootRecoveryPlan; domain: RecoveryDomain }> {
  const identity = currentIdentity();
  const context = await loadRecoveryContext(options.workspacePath);
  const domain = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  const proof = domain.claim.rebootProof;
  if (!proof) throw unsupported('canonical recovery claim has no reboot proof');
  assertSameHostChangedBoot(context.sourceOwner, identity);
  if (
    proof.hostId !== identity.hostId ||
    proof.currentBootIdentity !== identity.bootIdentity ||
    proof.previousBootIdentity !== context.sourceOwner.bootIdentity
  ) {
    throw isolated('current attempt does not match the canonical reboot proof');
  }
  const ownerBytes = await sourceOwnerBytes(context);
  const sourceOwnerDigest = digestBytes(ownerBytes);

  if (domain.claim.mode === 'delegated-finalize') {
    const snapshot = await readStableDelegatedOperation(
      context,
      domain.claim.delegatedOperation ?? undefined,
      domain,
    );
    const quarantine = await exactCanonicalContainment(
      snapshot.operationPath,
      'delegated recovery operation',
    );
    const plan: SameHostRebootRecoveryPlan = {
      mode: 'delegated-finalize',
      workspacePath: context.records.workspace.path,
      identity,
      proof,
      sourceOwnerDigest,
      sourceSnapshotDigest: domain.claim.sourceSnapshotDigest,
      quarantine: quarantine.authority,
      delegatedSnapshot: snapshot,
    };
    assertRebootQuarantineAuthority(snapshot, delegatedProbes(plan), domain);
    return { plan, domain };
  }
  if (domain.claim.mode === 'mechanical-empty' && domain.claim.prestartOperation !== null) {
    if (!options.helperBytes) throw unsupported('prestart recovery requires fixed helper bytes');
    const helperBytes = Buffer.from(options.helperBytes);
    const snapshot = await readStablePrestartSnapshot(
      context,
      domain.claim.prestartOperation,
      domain,
    );
    const quarantine = await exactCanonicalContainment(
      snapshot.operationPath,
      'prestart recovery operation',
    );
    const plan: SameHostRebootRecoveryPlan = {
      mode: 'prestart',
      workspacePath: context.records.workspace.path,
      identity,
      proof,
      sourceOwnerDigest,
      sourceSnapshotDigest: domain.claim.sourceSnapshotDigest,
      quarantine: quarantine.authority,
      prestartSnapshot: snapshot,
      helperBytes,
    };
    assertPrestartRebootQuarantineAuthority(snapshot, prestartProbes(plan), domain);
    return { plan, domain };
  }
  if (domain.claim.mode !== 'mechanical-empty') {
    throw unsupported(`${domain.claim.mode} is not a reboot recovery mode`);
  }
  const leasePath = join(context.records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  const quarantine = await exactCanonicalContainment(leasePath, 'mechanical recovery lease');
  const plan: SameHostRebootRecoveryPlan = {
    mode: 'mechanical-empty',
    workspacePath: context.records.workspace.path,
    identity,
    proof,
    sourceOwnerDigest,
    sourceSnapshotDigest: domain.claim.sourceSnapshotDigest,
    quarantine: quarantine.authority,
  };
  await mechanicalRebootAuthority(plan).verifySource({
    context,
    domain,
    expectedSourceSnapshotDigest: domain.claim.sourceSnapshotDigest,
    phase: 'attempt-acquire',
  });
  return { plan, domain };
}

export async function acquireSameHostRebootRecoveryControlled(
  options: ControlledAcquireSameHostRebootRecoveryOptions,
): Promise<SameHostRebootRecoveryHandle> {
  const { plan } = await inspectContinuation(options);
  const verifySystemAuthority = rebootSystemAuthority(plan);
  const common = {
    workspacePath: plan.workspacePath,
    attemptId: options.attemptId,
    identity: plan.identity,
    now: options.now,
    probeSourceOwner: sourceOwnerProbe(plan.sourceOwnerDigest),
    verifySystemAuthority,
  };
  const attempt =
    plan.mode === 'mechanical-empty'
      ? await acquireRecoveryAttemptControlled(common, mechanicalRebootAuthority(plan))
      : plan.mode === 'prestart'
        ? await acquirePrestartRecoveryControlled({ ...common, ...prestartProbes(plan) })
        : await acquireDelegatedFinalizeRecoveryControlled({ ...common, ...delegatedProbes(plan) });
  return new SameHostRebootRecoveryHandle(SAME_HOST_REBOOT_HANDLE_AUTHORITY, {
    mode: plan.mode,
    attempt,
    proof: plan.proof,
    sourceOwnerDigest: plan.sourceOwnerDigest,
    quarantine: plan.quarantine,
    ...(plan.helperBytes ? { helperBytes: plan.helperBytes } : {}),
  });
}

export async function finalizeSameHostRebootRecoveryControlled(
  handle: SameHostRebootRecoveryHandle,
  options: ControlledFinalizeSameHostRebootRecoveryOptions = {},
): Promise<SameHostRebootRecoveryCompletion> {
  const binding = sameHostRebootHandleBinding(handle);
  const common = {
    now: options.now,
    probeSourceOwner: sourceOwnerProbe(binding.sourceOwnerDigest),
    finalRenameCommitCheck: options.finalRenameCommitCheck,
    verifySystemAuthority: rebootSystemAuthority({
      mode: binding.mode,
      workspacePath: binding.attempt.workspacePath,
      identity: currentIdentity(),
      proof: binding.proof,
      sourceOwnerDigest: binding.sourceOwnerDigest,
      sourceSnapshotDigest: '',
      quarantine: binding.quarantine,
      ...(binding.helperBytes ? { helperBytes: binding.helperBytes } : {}),
    }),
  };
  if (binding.mode === 'mechanical-empty') {
    return await finalizeMechanicalEmptyRecoveryControlled(binding.attempt, {
      ...common,
      hooks: options.hooks,
      expectedRebootQuarantine: binding.quarantine,
    });
  }
  if (binding.mode === 'prestart') {
    if (!binding.helperBytes) throw unsupported('prestart recovery lost its fixed helper bytes');
    return await finalizePrestartRecoveryControlled(binding.attempt, {
      ...common,
      helperBytes: binding.helperBytes,
      probeSupervisor: () => 'dead',
      expectedRebootQuarantine: binding.quarantine,
      hooks: options.hooks,
    });
  }
  return await finalizeDelegatedRecoveryControlled(binding.attempt, {
    ...common,
    hooks: options.hooks,
    probeSupervisor: () => 'dead',
    probeContainment: () => 'empty',
    expectedRebootQuarantine: binding.quarantine,
  });
}

export async function inspectSameHostRebootRecovery(
  options: InspectSameHostRebootRecoveryOptions,
): Promise<SameHostRebootRecoveryPlan> {
  return await inspectSameHostRebootRecoveryControlled({
    workspacePath: options.workspacePath,
    helperBytes: readFixedPlatformHelperBundle(),
  });
}

export async function installSameHostRebootRecovery(
  options: InstallSameHostRebootRecoveryOptions,
): Promise<SameHostRebootRecoveryHandle> {
  return await installSameHostRebootRecoveryControlled({
    workspacePath: options.workspacePath,
    helperBytes: readFixedPlatformHelperBundle(),
  });
}

export async function acquireSameHostRebootRecovery(
  options: AcquireSameHostRebootRecoveryOptions,
): Promise<SameHostRebootRecoveryHandle> {
  return await acquireSameHostRebootRecoveryControlled({
    workspacePath: options.workspacePath,
    helperBytes: readFixedPlatformHelperBundle(),
  });
}

export async function finalizeSameHostRebootRecovery(
  handle: SameHostRebootRecoveryHandle,
): Promise<SameHostRebootRecoveryCompletion> {
  return await finalizeSameHostRebootRecoveryControlled(handle);
}

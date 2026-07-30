import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DelegatedSemanticCandidate } from '../contracts/delegated-operation-contract.js';
import {
  captureDelegatedBaseline,
  evaluateDelegatedDelta,
  type DelegatedBaseline,
  type DeltaEvaluation,
} from './baseline.js';
import {
  assertExactFile,
  createStagingDirectory,
  digestBytes,
  installDirectoryNoReplace,
  installFileNoReplace,
  jsonBytes,
  moveDirectoryNoReplace,
  pathExists,
  readExactFile,
  replaceFileFromStaging,
  writeNewFile,
} from './filesystem.js';
import type { WorkspaceLeaseHandle } from './lease.js';
import {
  createQuarantineRecordBytes,
  installQuarantineNoReplace,
  parseQuarantineRecord,
  QUARANTINE_FILE,
  type QuarantineRecord,
} from './quarantine.js';
import {
  ABORT_STAGING_PREFIX,
  ACTIVE_CHILD_SCHEMA_VERSION,
  ACTIVE_CHILD_FILE,
  ACTIVE_STAGING_PREFIX,
  DELEGATED_BASELINE_FILE,
  DRAINED_RECEIPT_FILE,
  NEVER,
  OPERATION_STAGING_PATTERN,
  PRESTART_ABORT_FILE,
  PRESTART_ABORT_SCHEMA_VERSION,
  RECEIPT_STAGING_PREFIX,
  SETTLED_OPERATIONS_DIR,
  assertOrdinaryDirectory,
  captureStableFrozenSafetyTree,
  delegationScope,
  descriptorFromActive,
  ensureSettledDirectory,
  invalid,
  parseActiveChildRecord,
  parseDelegatedBaselineRecord,
  parseDelegation,
  parseKind,
  parsePlatform,
  parsePrestartAbortRecord,
  sameDelegationContract,
  settledOperationDirectoryName,
  timestamp,
  uuid,
  type ActiveChildRecord,
  type ArmedActiveChild,
  type ArmedSettlementFacts,
  type OperationHandleState,
  type OperationHooksControlled,
  type PreparedActiveChild,
  type PreparedBoundActiveChild,
  type PrestartAbortFacts,
  type PrestartAbortRecord,
  type PrepareWorkspaceOperationOptionsControlled,
} from './operation-records.js';
import type { WorkspaceSession } from './session.js';
import {
  SupervisorProtocol,
  parseContainmentDescriptor,
  parseDrainedReceipt,
  parseSupervisorDrained,
  parseSupervisorPrestartDrained,
  type ArmedSafetyBinding,
  type BoundSupervisorDescriptor,
  type ContainmentDescriptor,
  type DrainedReceipt,
  type PreparedBoundSafetyBinding,
} from './supervisor-protocol.js';
import {
  ACTIVE_LEASE_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  type QuarantineReason,
  WorkspaceSafetyError,
} from './types.js';

export {
  ACTIVE_CHILD_FILE,
  DELEGATED_BASELINE_FILE,
  DRAINED_RECEIPT_FILE,
  PRESTART_ABORT_FILE,
  SETTLED_OPERATIONS_DIR,
  delegationContractForOperation,
  parseActiveChildRecord,
  parseDelegatedBaselineRecord,
  parsePrestartAbortRecord,
} from './operation-records.js';
export type {
  ActiveChildRecord,
  ArmedActiveChild,
  ArmedSettlementFacts,
  OperationDelegation,
  OperationDelegationScope,
  OperationKind,
  PreparedActiveChild,
  PreparedBoundActiveChild,
  PrestartAbortFacts,
  PrestartAbortRecord,
} from './operation-records.js';

export interface WorkspaceOperationSettlement {
  readonly settledPath: string;
  readonly candidate?: DelegatedSemanticCandidate;
}

const OPERATION_HANDLE_AUTHORITY = Symbol('workspace-operation-handle-authority');

/**
 * Low-level operation state machine. Only the fixed platform coordinators may consume this handle
 * in production; destructive tests receive it through operation-authority-test-seam.ts.
 */
export class WorkspaceOperationHandleControlled {
  readonly operationId: string;
  readonly operationPath: string;
  readonly workspacePath: string;

  #state: OperationHandleState;
  #tail: Promise<void> = Promise.resolve();
  #active: ActiveChildRecord;
  #activeBytes: Buffer;
  #abortBytes: Buffer | undefined;
  #receiptBytes: Buffer | undefined;

  constructor(
    authority: typeof OPERATION_HANDLE_AUTHORITY,
    private readonly lease: WorkspaceLeaseHandle,
    private readonly ownerBytes: Buffer,
    private readonly protocolBytes: Buffer,
    private readonly baseline: DelegatedBaseline,
    private readonly baselineBytes: Buffer,
    private readonly helperBytes: Buffer,
    private readonly frozenSafetyTreeDigest: string,
    active: ActiveChildRecord,
    activeBytes: Buffer,
    private readonly settledRoot: string,
    private readonly now: () => Date,
    private readonly hooks: OperationHooksControlled,
  ) {
    if (authority !== OPERATION_HANDLE_AUTHORITY) {
      invalid('operation handle authority token is invalid');
    }
    this.operationId = active.operationId;
    this.workspacePath = lease.workspace.path;
    this.operationPath = join(
      this.workspacePath,
      PROTOCOL_ROOT_DIR,
      ACTIVE_LEASE_DIR,
      OPERATION_DIR,
    );
    this.#state = active.state;
    this.#active = active;
    this.#activeBytes = Buffer.from(activeBytes);
  }

  get state(): OperationHandleState {
    return this.#state;
  }

  get activeState(): ActiveChildRecord['state'] {
    return this.#active.state;
  }

  get settled(): boolean {
    return this.#state === 'settled';
  }

  get quarantined(): boolean {
    return this.#state === 'quarantined';
  }

  get receiptInstalled(): boolean {
    return this.#receiptBytes !== undefined;
  }

  #step<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (this.#state === 'failed') invalid('operation handle is failed');
      if (this.#state === 'quarantined') {
        throw new WorkspaceSafetyError('isolated', 'workspace operation is quarantined');
      }
      if (this.#state === 'settled') {
        throw new WorkspaceSafetyError('closed', 'workspace operation is already settled');
      }
      try {
        return await action();
      } catch (error) {
        if (!this.quarantined) this.#state = 'failed';
        throw error;
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #closeoutStep<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (this.#state === 'quarantined') {
        throw new WorkspaceSafetyError('isolated', 'workspace operation is quarantined');
      }
      if (this.#state === 'settled') {
        throw new WorkspaceSafetyError('closed', 'workspace operation is already settled');
      }
      try {
        return await action();
      } catch (error) {
        if (!this.quarantined) this.#state = 'failed';
        throw error;
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertQuarantineBinding(record: QuarantineRecord, reason: QuarantineReason): void {
    if (
      record.ownerId !== this.lease.owner.ownerId ||
      record.operationId !== this.operationId ||
      record.activeChildDigest !== digestBytes(this.#activeBytes) ||
      record.delegatedBaselineDigest !== digestBytes(this.baselineBytes) ||
      record.creator.kind !== 'owner' ||
      record.creator.id !== this.lease.owner.ownerId ||
      record.creator.recordDigest !== digestBytes(this.ownerBytes) ||
      record.reason !== reason ||
      record.priorQuarantineDigest !== null
    ) {
      invalid('operation quarantine authority binding mismatch');
    }
  }

  async #installQuarantineNow(reason: QuarantineReason): Promise<void> {
    await this.#verifyCore();
    const bytes = createQuarantineRecordBytes({
      ownerId: this.lease.owner.ownerId,
      operationId: this.operationId,
      activeChildDigest: digestBytes(this.#activeBytes),
      delegatedBaselineDigest: digestBytes(this.baselineBytes),
      creator: {
        kind: 'owner',
        id: this.lease.owner.ownerId,
        recordDigest: digestBytes(this.ownerBytes),
      },
      reason,
      priorQuarantineDigest: null,
      createdAt: this.now(),
    });
    this.#assertQuarantineBinding(parseQuarantineRecord(bytes), reason);
    try {
      const installed = await installQuarantineNoReplace({
        containerPath: this.operationPath,
        recordBytes: bytes,
        verifyAuthority: async () => {
          await this.#verifyCore();
        },
      });
      this.#assertQuarantineBinding(installed, reason);
    } catch (error) {
      if (error instanceof WorkspaceSafetyError && error.code === 'conflict') {
        invalid('operation quarantine was already present before owner installation');
      }
      throw error;
    }
    const installed = parseQuarantineRecord(
      await readExactFile(join(this.operationPath, QUARANTINE_FILE)),
    );
    this.#assertQuarantineBinding(installed, reason);
    this.#state = 'quarantined';
  }

  installQuarantineControlled(reason: QuarantineReason): Promise<void> {
    const result = this.#tail.then(async () => {
      if (this.#state === 'settled') {
        throw new WorkspaceSafetyError('closed', 'settled operation cannot be quarantined');
      }
      if (this.#state === 'quarantined') return;
      await this.#installQuarantineNow(reason);
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #verifyCore(): Promise<void> {
    await this.lease.verify();
    await assertOrdinaryDirectory(this.operationPath, 'canonical operation');
    await assertExactFile(join(this.operationPath, DELEGATED_BASELINE_FILE), this.baselineBytes);
    await assertExactFile(join(this.operationPath, ACTIVE_CHILD_FILE), this.#activeBytes);
    await assertExactFile(
      join(this.lease.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OWNER_FILE),
      this.ownerBytes,
    );
    await assertExactFile(
      join(this.lease.workspace.path, PROTOCOL_ROOT_DIR, PROTOCOL_FILE),
      this.protocolBytes,
    );
    if (
      (await captureStableFrozenSafetyTree(join(this.lease.workspace.path, PROTOCOL_ROOT_DIR))) !==
      this.frozenSafetyTreeDigest
    ) {
      invalid('frozen safety paths changed during delegated operation');
    }
    await this.lease.verify();
  }

  async #commitActive(next: ActiveChildRecord): Promise<void> {
    const nextBytes = jsonBytes(next);
    const parsed = parseActiveChildRecord(nextBytes);
    const staging = join(this.operationPath, `${ACTIVE_STAGING_PREFIX}${randomUUID()}.json`);
    await writeNewFile(staging, nextBytes);
    await assertExactFile(staging, nextBytes);
    await this.hooks.beforeActiveCommit?.(next.state, staging);
    await this.#verifyCore();
    await replaceFileFromStaging(staging, join(this.operationPath, ACTIVE_CHILD_FILE));
    await assertExactFile(join(this.operationPath, ACTIVE_CHILD_FILE), nextBytes);
    this.#active = parsed;
    this.#activeBytes = nextBytes;
    this.#state = parsed.state;
    await this.hooks.afterActiveCommitted?.(parsed.state);
  }

  bindSupervisorControlled(supervisor: BoundSupervisorDescriptor): Promise<void> {
    return this.#step(async () => {
      if (this.#state !== 'prepared' || this.#active.state !== 'prepared') {
        invalid(`supervisor binding is not allowed from state ${this.#state}`);
      }
      // Constructor performs the strict descriptor and cross-platform isolation validation.
      new SupervisorProtocol({
        ownerId: this.lease.owner.ownerId,
        operationId: this.operationId,
        supervisor,
      });
      if (
        supervisor.platform !== this.#active.platform ||
        supervisor.helperDigest !== this.#active.helperDigest
      ) {
        invalid('bound supervisor does not match prepared platform/helper');
      }
      const next: PreparedBoundActiveChild = {
        ...this.#active,
        state: 'prepared-bound',
        supervisorPid: supervisor.supervisorPid,
        supervisorIdentity: supervisor.supervisorIdentity,
        signalIsolation: supervisor.signalIsolation,
        updatedAt: this.now().toISOString(),
      };
      await this.#commitActive(next);
    });
  }

  armContainmentControlled(containment: ContainmentDescriptor): Promise<void> {
    return this.#step(async () => {
      if (this.#state !== 'prepared-bound' || this.#active.state !== 'prepared-bound') {
        invalid(`containment arming is not allowed from state ${this.#state}`);
      }
      const parsed = parseContainmentDescriptor(containment);
      if (parsed.platform !== this.#active.platform) invalid('containment platform mismatch');
      await this.#verifyCore();
      await this.#assertAcceptedDelta(true, 'workspace changed before containment arming');
      const next: ArmedActiveChild = {
        ...this.#active,
        state: 'armed',
        containment: parsed,
        containmentDigest: digestBytes(jsonBytes(parsed)),
        updatedAt: this.now().toISOString(),
      };
      await this.#commitActive(next);
    });
  }

  async #readBinding(
    helperBytes: Uint8Array,
    requireUnchanged: boolean,
  ): Promise<PreparedBoundSafetyBinding | ArmedSafetyBinding> {
    await this.#verifyCore();
    if (requireUnchanged) {
      await this.#assertAcceptedDelta(
        true,
        'workspace changed before delegated execution authorization',
      );
    }
    const currentHelperDigest = digestBytes(helperBytes);
    if (
      currentHelperDigest !== this.#active.helperDigest ||
      !Buffer.from(helperBytes).equals(this.helperBytes)
    ) {
      invalid('helper bytes changed before authorization');
    }
    if (this.#active.state === 'prepared') invalid('supervisor is not bound');
    const common: PreparedBoundSafetyBinding = {
      ownerId: this.#active.ownerId,
      operationId: this.#active.operationId,
      ownerRecordDigest: digestBytes(this.ownerBytes),
      protocolDigest: digestBytes(this.protocolBytes),
      activeChildDigest: digestBytes(this.#activeBytes),
      delegatedBaselineDigest: digestBytes(this.baselineBytes),
      delegationContractDigest: this.baseline.contractDigest,
      helperDigest: currentHelperDigest,
      supervisor: descriptorFromActive(this.#active),
    };
    if (this.#active.state === 'prepared-bound') return common;
    if (this.#active.containmentDigest !== digestBytes(jsonBytes(this.#active.containment))) {
      invalid('containment digest changed before START');
    }
    return {
      ...common,
      containmentDigest: this.#active.containmentDigest,
      containment: structuredClone(this.#active.containment),
    };
  }

  readPreparedBoundBindingControlled(helperBytes: Uint8Array): Promise<PreparedBoundSafetyBinding> {
    return this.#step(async () => {
      if (this.#state !== 'prepared-bound') invalid('DATA requires canonical prepared-bound state');
      const binding = await this.#readBinding(helperBytes, true);
      if ('containmentDigest' in binding)
        invalid('prepared-bound binding unexpectedly contains containment');
      return binding;
    });
  }

  readArmedBindingControlled(helperBytes: Uint8Array): Promise<ArmedSafetyBinding> {
    return this.#step(async () => {
      if (this.#state !== 'armed' || this.#active.state !== 'armed') {
        invalid('START requires canonical armed state');
      }
      const binding = await this.#readBinding(helperBytes, true);
      if (!('containmentDigest' in binding)) invalid('armed binding is missing containment');
      return binding;
    });
  }

  #assertReceiptBinding(receipt: DrainedReceipt, binding: ArmedSafetyBinding): void {
    if (
      receipt.ownerId !== binding.ownerId ||
      receipt.operationId !== binding.operationId ||
      receipt.ownerRecordDigest !== binding.ownerRecordDigest ||
      receipt.protocolDigest !== binding.protocolDigest ||
      receipt.activeChildDigest !== binding.activeChildDigest ||
      receipt.delegatedBaselineDigest !== binding.delegatedBaselineDigest ||
      receipt.delegationContractDigest !== binding.delegationContractDigest ||
      receipt.containmentDigest !== binding.containmentDigest ||
      receipt.helperDigest !== binding.helperDigest ||
      receipt.supervisorIdentity !== binding.supervisor.supervisorIdentity
    ) {
      invalid('drained receipt safety binding mismatch');
    }
  }

  async #validateDrainedReceipt(
    receiptBuffer: Buffer,
    messageBuffer: Buffer,
  ): Promise<DrainedReceipt> {
    const receipt = parseDrainedReceipt(receiptBuffer);
    const message = parseSupervisorDrained(messageBuffer);
    const binding = await this.#readBinding(this.helperBytes, false);
    if (!('containmentDigest' in binding)) invalid('receipt requires armed containment');
    this.#assertReceiptBinding(receipt, binding);
    if (
      message.operationId !== binding.operationId ||
      message.receiptDigest !== digestBytes(receiptBuffer) ||
      message.proof !== receipt.proof
    ) {
      invalid('drained receipt safety binding mismatch');
    }
    if (
      (binding.supervisor.platform === 'posix-process-group-v1' &&
        receipt.proof === 'windows-job-zero-and-pipes-eof-v1') ||
      (binding.supervisor.platform === 'windows-job-v1' &&
        receipt.proof === 'posix-group-empty-and-pipes-eof-v1')
    ) {
      invalid('drained receipt proof does not match platform');
    }
    return receipt;
  }

  installDrainedReceiptControlled(
    receiptBytes: Uint8Array,
    drainedMessageBytes: Uint8Array,
  ): Promise<void> {
    return this.#step(async () => {
      if (this.#state !== 'armed' || this.#active.state !== 'armed') {
        invalid(`drained receipt is not allowed from state ${this.#state}`);
      }
      const receiptBuffer = Buffer.from(receiptBytes);
      const messageBuffer = Buffer.from(drainedMessageBytes);
      await this.#validateDrainedReceipt(receiptBuffer, messageBuffer);
      const staging = join(this.operationPath, `${RECEIPT_STAGING_PREFIX}${randomUUID()}.json`);
      await writeNewFile(staging, receiptBuffer);
      await assertExactFile(staging, receiptBuffer);
      await this.hooks.beforeReceiptInstall?.(staging);
      await this.#verifyCore();
      await installFileNoReplace(staging, join(this.operationPath, DRAINED_RECEIPT_FILE));
      await assertExactFile(join(this.operationPath, DRAINED_RECEIPT_FILE), receiptBuffer);
      this.#receiptBytes = receiptBuffer;
      this.#state = 'receipt-installed';
      await this.hooks.afterReceiptInstalled?.();
    });
  }

  acceptInstalledDrainedReceiptControlled(
    drainedMessageBytes: Uint8Array,
  ): Promise<DrainedReceipt> {
    return this.#step(async () => {
      if (this.#state !== 'armed' || this.#active.state !== 'armed') {
        invalid(`installed drained receipt is not allowed from state ${this.#state}`);
      }
      await this.#verifyCore();
      const receiptBuffer = await readExactFile(join(this.operationPath, DRAINED_RECEIPT_FILE));
      const receipt = await this.#validateDrainedReceipt(
        receiptBuffer,
        Buffer.from(drainedMessageBytes),
      );
      this.#receiptBytes = receiptBuffer;
      this.#state = 'receipt-installed';
      return receipt;
    });
  }

  abortPrestartControlled(facts: PrestartAbortFacts): Promise<WorkspaceOperationSettlement> {
    return this.#closeoutStep(async () => {
      if (this.#active.state === 'armed' || this.#state === 'receipt-installed') {
        throw new WorkspaceSafetyError(
          'isolated',
          'armed operation cannot be downgraded to parent-authored prestart abort',
        );
      }
      if (this.#active.state !== 'prepared' && this.#active.state !== 'prepared-bound') {
        invalid(`prestart abort is not allowed from state ${this.#state}`);
      }
      await this.#verifyCore();
      let prestartDrainedDigest: string | null = null;
      if (this.#active.state === 'prepared') {
        if (
          facts.proof !== 'supervisor-never-bound-v1' ||
          (facts.supervisor !== 'never-created' && facts.supervisor !== 'dead') ||
          facts.containment !== 'not-created'
        ) {
          invalid('prepared abort requires supervisor-never-bound proof');
        }
      } else {
        if (facts.proof !== 'supervisor-prestart-empty-v1') {
          invalid('prepared-bound abort requires prestart-empty proof');
        }
        const drained = parseSupervisorPrestartDrained(facts.prestartDrainedBytes);
        if (
          drained.operationId !== this.operationId ||
          drained.supervisorPid !== this.#active.supervisorPid ||
          drained.supervisorIdentity !== this.#active.supervisorIdentity ||
          facts.supervisor !== 'dead' ||
          facts.containment !== 'empty'
        ) {
          invalid('prestart drained fact binding mismatch');
        }
        prestartDrainedDigest = digestBytes(facts.prestartDrainedBytes);
      }
      const record: PrestartAbortRecord = {
        schemaVersion: PRESTART_ABORT_SCHEMA_VERSION,
        ownerId: this.#active.ownerId,
        operationId: this.#active.operationId,
        activeChildDigest: digestBytes(this.#activeBytes),
        delegatedBaselineDigest: digestBytes(this.baselineBytes),
        reason: facts.reason,
        proof: facts.proof,
        prestartDrainedDigest,
        abortedAt: this.now().toISOString(),
      };
      const bytes = jsonBytes(record);
      parsePrestartAbortRecord(bytes);
      const staging = join(this.operationPath, `${ABORT_STAGING_PREFIX}${randomUUID()}.json`);
      await writeNewFile(staging, bytes);
      await assertExactFile(staging, bytes);
      await this.hooks.beforeAbortInstall?.(staging);
      await this.#verifyCore();
      await installFileNoReplace(staging, join(this.operationPath, PRESTART_ABORT_FILE));
      await assertExactFile(join(this.operationPath, PRESTART_ABORT_FILE), bytes);
      this.#abortBytes = bytes;
      await this.hooks.afterAbortInstalled?.();
      return this.#settle(true, 'prestart abort refused because the delegated baseline changed');
    });
  }

  settleArmedControlled(facts: ArmedSettlementFacts): Promise<WorkspaceOperationSettlement> {
    return this.#step(async () => {
      if (
        this.#state !== 'receipt-installed' ||
        this.#active.state !== 'armed' ||
        !this.#receiptBytes
      ) {
        invalid('armed settlement requires an installed receipt');
      }
      if (facts.supervisor !== 'dead' || facts.containment !== 'empty') {
        throw new WorkspaceSafetyError(
          'isolated',
          'armed settlement requires exact dead/empty facts',
        );
      }
      const receipt = parseDrainedReceipt(this.#receiptBytes);
      return this.#settle(
        receipt.proof === 'never-started-containment-empty-v1',
        'armed settlement refused because the semantic delta was not accepted',
      );
    });
  }

  async #assertAcceptedDelta(
    requireUnchanged: boolean,
    failureMessage: string,
  ): Promise<Extract<DeltaEvaluation, { accepted: true }>> {
    await this.#verifyCore();
    let delta: DeltaEvaluation;
    try {
      delta = evaluateDelegatedDelta(this.lease.workspace.path, this.baseline, {
        requireUnchanged,
      });
    } catch (error) {
      await this.#installQuarantineNow('workspace-integrity-violation');
      const isolated = new WorkspaceSafetyError('isolated', failureMessage);
      Object.defineProperty(isolated, 'cause', { value: error, enumerable: false });
      throw isolated;
    }
    if (!delta.accepted) {
      await this.#installQuarantineNow('workspace-integrity-violation');
      throw new WorkspaceSafetyError('isolated', failureMessage);
    }
    return delta;
  }

  async #verifySettlementFacts(): Promise<[string, Buffer][]> {
    await this.#verifyCore();
    if ((this.#abortBytes === undefined) === (this.#receiptBytes === undefined)) {
      invalid('operation settlement requires exactly one abort or receipt fact');
    }
    const expectedNames = [DELEGATED_BASELINE_FILE, ACTIVE_CHILD_FILE];
    const authorityFiles: [string, Buffer][] = [
      [DELEGATED_BASELINE_FILE, this.baselineBytes],
      [ACTIVE_CHILD_FILE, this.#activeBytes],
    ];
    if (this.#abortBytes) {
      if (this.#active.state === 'armed')
        invalid('armed operation cannot settle with prestart abort');
      await assertExactFile(join(this.operationPath, PRESTART_ABORT_FILE), this.#abortBytes);
      const abort = parsePrestartAbortRecord(this.#abortBytes);
      if (
        abort.ownerId !== this.#active.ownerId ||
        abort.operationId !== this.#active.operationId ||
        abort.activeChildDigest !== digestBytes(this.#activeBytes) ||
        abort.delegatedBaselineDigest !== digestBytes(this.baselineBytes)
      ) {
        invalid('prestart abort safety binding mismatch at settlement');
      }
      expectedNames.push(PRESTART_ABORT_FILE);
      authorityFiles.push([PRESTART_ABORT_FILE, this.#abortBytes]);
    }
    if (this.#receiptBytes) {
      if (this.#active.state !== 'armed') invalid('receipt settlement requires armed active-child');
      await assertExactFile(join(this.operationPath, DRAINED_RECEIPT_FILE), this.#receiptBytes);
      const binding = await this.#readBinding(this.helperBytes, false);
      if (!('containmentDigest' in binding)) invalid('receipt settlement lost armed containment');
      this.#assertReceiptBinding(parseDrainedReceipt(this.#receiptBytes), binding);
      expectedNames.push(DRAINED_RECEIPT_FILE);
      authorityFiles.push([DRAINED_RECEIPT_FILE, this.#receiptBytes]);
    }
    const actualNames = (await readdir(this.operationPath)).sort((left, right) =>
      left.localeCompare(right, 'en'),
    );
    expectedNames.sort((left, right) => left.localeCompare(right, 'en'));
    if (
      actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index])
    ) {
      invalid('operation directory contains unknown, staged, or conflicting facts');
    }
    return authorityFiles;
  }

  async #settle(
    requireUnchanged: boolean,
    deltaFailureMessage: string,
  ): Promise<WorkspaceOperationSettlement> {
    await this.#assertAcceptedDelta(requireUnchanged, deltaFailureMessage);
    const authorityFiles = await this.#verifySettlementFacts();
    await assertOrdinaryDirectory(this.settledRoot, SETTLED_OPERATIONS_DIR);
    const target = join(
      this.settledRoot,
      settledOperationDirectoryName(this.operationId, authorityFiles),
    );
    await this.hooks.beforeSettle?.(target);
    const finalDelta = await this.#assertAcceptedDelta(requireUnchanged, deltaFailureMessage);
    await this.#verifySettlementFacts();
    await moveDirectoryNoReplace(this.operationPath, target);
    this.#state = 'settled';
    return !requireUnchanged && finalDelta.candidate
      ? { settledPath: target, candidate: finalDelta.candidate }
      : { settledPath: target };
  }
}

async function prepareWorkspaceOperation(
  lease: WorkspaceLeaseHandle,
  options: PrepareWorkspaceOperationOptionsControlled,
): Promise<WorkspaceOperationHandleControlled> {
  const kind = parseKind(options.kind);
  const delegation = parseDelegation(options.delegation);
  const platform = parsePlatform(options.platform);
  const scope = delegationScope(
    kind,
    delegation,
    options.storyId,
    options.requestId,
    options.acceptanceHash,
    options.checkCount,
    options.gitHead,
  );
  const operationId = options.operationId ?? scope.requestId ?? randomUUID();
  uuid(operationId, 'operationId');
  if (scope.requestId !== undefined && operationId !== scope.requestId) {
    invalid('validator operationId must equal requestId');
  }
  const helperBytes = Buffer.from(options.helperBytes);
  if (helperBytes.length === 0) invalid('fixed helper bytes cannot be empty');
  await lease.verify();
  const baseline = captureDelegatedBaseline(
    lease.workspace.path,
    lease.owner.ownerId,
    operationId,
    scope.contract,
    options.baselineHooks,
  );
  const baselineBytes = jsonBytes(baseline);
  if (
    baseline.ownerId !== lease.owner.ownerId ||
    baseline.operationId !== operationId ||
    baseline.workspaceIdentity !== lease.workspace.identity ||
    baseline.contract.version !== delegation
  ) {
    invalid('delegated baseline owner/operation/contract binding mismatch');
  }
  if (!sameDelegationContract(baseline.contract, scope.contract)) {
    invalid('delegated baseline contract does not match the canonical operation scope');
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  timestamp(startedAt, 'operation.startedAt');
  const active: PreparedActiveChild = {
    schemaVersion: ACTIVE_CHILD_SCHEMA_VERSION,
    ownerId: lease.owner.ownerId,
    operationId,
    state: 'prepared',
    kind,
    delegation,
    platform,
    helperDigest: digestBytes(helperBytes),
    delegatedBaselineDigest: digestBytes(baselineBytes),
    delegationContractDigest: baseline.contractDigest,
    startedAt,
    updatedAt: startedAt,
  };
  const activeBytes = jsonBytes(active);
  parseActiveChildRecord(activeBytes);

  await lease.verify();
  const activeLease = join(lease.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  const settledRoot = await ensureSettledDirectory(activeLease);
  const ownerBytes = await readExactFile(join(activeLease, OWNER_FILE));
  const protocolBytes = await readExactFile(
    join(lease.workspace.path, PROTOCOL_ROOT_DIR, PROTOCOL_FILE),
  );
  await lease.verify();

  const staging = await createStagingDirectory(activeLease, 'operation.prepare-', operationId);
  if (!OPERATION_STAGING_PATTERN.test(staging.slice(activeLease.length + 1))) {
    invalid('operation staging name is not canonical');
  }
  await writeNewFile(join(staging, DELEGATED_BASELINE_FILE), baselineBytes);
  await writeNewFile(join(staging, ACTIVE_CHILD_FILE), activeBytes);
  await assertExactFile(join(staging, DELEGATED_BASELINE_FILE), baselineBytes);
  await assertExactFile(join(staging, ACTIVE_CHILD_FILE), activeBytes);
  parseDelegatedBaselineRecord(await readExactFile(join(staging, DELEGATED_BASELINE_FILE)));
  parseActiveChildRecord(await readExactFile(join(staging, ACTIVE_CHILD_FILE)));
  await options.hooks?.beforeOperationInstall?.(staging);
  await lease.verify();
  const preinstallDelta = evaluateDelegatedDelta(lease.workspace.path, baseline, {
    requireUnchanged: true,
  });
  if (!preinstallDelta.accepted) {
    invalid('workspace changed between baseline capture and operation install');
  }
  const canonical = join(activeLease, OPERATION_DIR);
  await installDirectoryNoReplace(staging, canonical);
  await assertExactFile(join(canonical, DELEGATED_BASELINE_FILE), baselineBytes);
  await assertExactFile(join(canonical, ACTIVE_CHILD_FILE), activeBytes);
  const frozenSafetyTreeDigest = await captureStableFrozenSafetyTree(
    join(lease.workspace.path, PROTOCOL_ROOT_DIR),
  );
  await options.hooks?.afterOperationInstalled?.(canonical);

  return new WorkspaceOperationHandleControlled(
    OPERATION_HANDLE_AUTHORITY,
    lease,
    ownerBytes,
    protocolBytes,
    baseline,
    baselineBytes,
    helperBytes,
    frozenSafetyTreeDigest,
    active,
    activeBytes,
    settledRoot,
    now,
    options.hooks ?? {},
  );
}

export function runWorkspaceOperationControlled<T>(
  session: WorkspaceSession,
  options: PrepareWorkspaceOperationOptionsControlled,
  action: (operation: WorkspaceOperationHandleControlled) => Promise<T>,
): Promise<T> {
  let resolvePublic!: (value: T | PromiseLike<T>) => void;
  let rejectPublic!: (reason?: unknown) => void;
  let publicFinished = false;
  const publicResult = new Promise<T>((resolve, reject) => {
    resolvePublic = resolve;
    rejectPublic = reject;
  });
  const resolveOnce = (value: T): void => {
    if (publicFinished) return;
    publicFinished = true;
    resolvePublic(value);
  };
  const rejectOnce = (error: unknown): void => {
    if (publicFinished) return;
    publicFinished = true;
    rejectPublic(error);
  };

  const exclusive = session.withExclusiveAction(async (lease) => {
    let operation: WorkspaceOperationHandleControlled | undefined;
    try {
      operation = await prepareWorkspaceOperation(lease, options);
      const result = await action(operation);
      if (!operation.settled) {
        throw new WorkspaceSafetyError(
          'isolated',
          'operation callback returned without an atomic settled commit',
        );
      }
      resolveOnce(result);
    } catch (error) {
      rejectOnce(error);
      const canonical = join(
        lease.workspace.path,
        PROTOCOL_ROOT_DIR,
        ACTIVE_LEASE_DIR,
        OPERATION_DIR,
      );
      if (
        !(error instanceof WorkspaceSafetyError && error.code === 'lease-lost') &&
        !operation?.settled &&
        (await pathExists(canonical))
      ) {
        // A canonical unfinished operation is an intentional write fence. The public call fails,
        // while this exclusive action remains pending so queued parent writes/release cannot pass it.
        return NEVER;
      }
      throw error;
    }
  });
  void exclusive.catch(rejectOnce);
  return publicResult;
}

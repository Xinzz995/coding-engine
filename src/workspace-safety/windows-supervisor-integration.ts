import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestBytes, jsonBytes } from './filesystem.js';
import { createSystemIdentityAdapter } from './identity.js';
import { DRAINED_RECEIPT_FILE, type WorkspaceOperationHandleControlled } from './operation.js';
import {
  encodeSupervisorAcknowledgement,
  encodeSupervisorAbortBeforeStart,
  encodeSupervisorData,
  encodeSupervisorStart,
  encodeSupervisorTerminate,
  parseDrainedReceipt,
  parseSupervisorDrained,
  parseSupervisorPrestartDrained,
  type BoundSupervisorDescriptor,
  type SupervisorTerminationReason,
} from './supervisor-protocol.js';
import {
  WINDOWS_SUPERVISOR_SCRIPT,
  createWindowsSupervisorLaunch,
  readWindowsSupervisorAssets,
  resolveWindowsSupervisorTimeouts,
  spawnWindowsJobSupervisor,
} from './windows-supervisor-launch.js';
import {
  WindowsSupervisorProcess,
  protocolInvalid,
  protocolIsolated,
  type RunDarkWindowsSupervisedOperationOptions,
  type WindowsArmedEvent,
  type WindowsBoundEvent,
  type WindowsContainment,
  type WindowsDrainedEvent,
  type WindowsInvocationOutcome,
  type WindowsResultEvent,
  type WindowsStartedEvent,
} from './windows-supervisor-protocol.js';
import { WorkspaceSafetyError } from './types.js';

function fixedWindowsAssetRoot(): string {
  const candidates = [
    dirname(
      fileURLToPath(new URL('./workspace-safety/windows-job-supervisor.ps1', import.meta.url)),
    ),
    fileURLToPath(new URL('../../assets/workspace-safety', import.meta.url)),
  ];
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, WINDOWS_SUPERVISOR_SCRIPT)),
  );
  if (!root) {
    throw new WorkspaceSafetyError('unsupported', 'Fixed Windows supervisor assets are missing');
  }
  return root;
}

export function readDarkWindowsHelperBundle(): Buffer {
  if (process.platform !== 'win32') {
    throw new WorkspaceSafetyError('unsupported', 'Windows Job supervisor is unavailable here');
  }
  return readWindowsSupervisorAssets(fixedWindowsAssetRoot()).helperBytes;
}

function exactProcessIdentity(pid: number): string {
  const observed = createSystemIdentityAdapter().readProcessIdentity(pid);
  if (observed.status !== 'found')
    protocolIsolated(`process identity is unavailable for pid ${pid}`);
  return observed.value;
}

function assertExactProcessDeath(pid: number, identity: string, label: string): void {
  const observed = createSystemIdentityAdapter().readProcessIdentity(pid);
  if (observed.status === 'unknown') protocolIsolated(`${label} death identity is unknown`);
  if (observed.status === 'found' && observed.value === identity) {
    protocolIsolated(`${label} remains exact-live after completion`);
  }
}

function validateWindowsBound(
  processHandle: WindowsSupervisorProcess,
  event: WindowsBoundEvent,
  helperDigest: string,
): BoundSupervisorDescriptor {
  if (
    event.supervisorPid !== processHandle.pid ||
    event.supervisorIdentity !== exactProcessIdentity(processHandle.pid) ||
    event.helperDigest !== helperDigest
  ) {
    protocolInvalid('BOUND does not match the spawned fixed supervisor');
  }
  return {
    platform: 'windows-job-v1',
    supervisorPid: event.supervisorPid,
    supervisorIdentity: event.supervisorIdentity,
    signalIsolation: 'windows-new-process-group-ctrl-c-ignore-v1',
    helperDigest,
  };
}

function validateWindowsContainment(event: WindowsArmedEvent): WindowsContainment {
  const containment = event.containment;
  if (containment.platform !== 'windows-job-v1')
    protocolInvalid('ARMED is not Windows containment');
  if (exactProcessIdentity(containment.targetPid) !== containment.targetIdentity) {
    protocolInvalid('ARMED target identity does not match the suspended process');
  }
  return containment;
}

interface TerminationTrigger {
  readonly promise: Promise<SupervisorTerminationReason>;
  readonly reason: SupervisorTerminationReason | undefined;
  startCommandTimer(): void;
  rootCompleted(): void;
  dispose(): void;
}

function createTerminationTrigger(
  commandTimeoutMs: number | undefined,
  termination: RunDarkWindowsSupervisedOperationOptions['termination'],
): TerminationTrigger {
  if (
    commandTimeoutMs !== undefined &&
    (!Number.isSafeInteger(commandTimeoutMs) ||
      commandTimeoutMs < 1 ||
      commandTimeoutMs > 0x7fff_ffff)
  ) {
    protocolInvalid('commandTimeoutMs is outside the supported range');
  }
  let frozenReason: SupervisorTerminationReason | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let resolveTrigger: (reason: SupervisorTerminationReason) => void = () => undefined;
  const promise = new Promise<SupervisorTerminationReason>((resolvePromise) => {
    resolveTrigger = resolvePromise;
  });
  const freeze = (reason: SupervisorTerminationReason): void => {
    if (frozenReason !== undefined) return;
    frozenReason = reason;
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    resolveTrigger(reason);
  };
  const onAbort = (): void => freeze(termination!.reason);
  if (termination) {
    termination.signal.addEventListener('abort', onAbort, { once: true });
    if (termination.signal.aborted) freeze(termination.reason);
  }
  return {
    promise,
    get reason() {
      return frozenReason;
    },
    startCommandTimer() {
      if (commandTimeoutMs !== undefined && frozenReason === undefined) {
        timeout = setTimeout(() => freeze('timeout'), commandTimeoutMs);
      }
    },
    rootCompleted() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    },
    dispose() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      termination?.signal.removeEventListener('abort', onAbort);
    },
  };
}

function embeddedEnvelope(type: string, messageBytes: Buffer): Record<string, unknown> {
  return { schemaVersion: 1, type, messageBase64: messageBytes.toString('base64') };
}

type PrestartAbortReason = 'setup-failed' | 'capability-unavailable' | 'user-interrupt';

function prestartAbortReason(
  error: unknown,
  terminationReason: SupervisorTerminationReason | undefined,
): PrestartAbortReason {
  if (terminationReason !== undefined) return 'user-interrupt';
  return error instanceof WorkspaceSafetyError && error.code === 'unsupported'
    ? 'capability-unavailable'
    : 'setup-failed';
}

function throwIfPrestartInterrupted(trigger: TerminationTrigger): void {
  if (trigger.reason === undefined) return;
  throw new WorkspaceSafetyError(
    'isolated',
    `Windows operation was interrupted before START: ${trigger.reason}`,
  );
}

async function abortPreparedWindowsOperation(
  operation: WorkspaceOperationHandleControlled,
  processHandle: WindowsSupervisorProcess | undefined,
  supervisorIdentity: string | undefined,
  reason: PrestartAbortReason,
): Promise<void> {
  if (processHandle) {
    if (!supervisorIdentity) protocolIsolated('spawned supervisor identity was never established');
    await processHandle.abort();
    assertExactProcessDeath(processHandle.pid, supervisorIdentity, 'supervisor');
  }
  await operation.abortPrestartControlled({
    reason,
    proof: 'supervisor-never-bound-v1',
    supervisor: processHandle ? 'dead' : 'never-created',
    containment: 'not-created',
  });
}

async function abortPreparedBoundWindowsOperation(
  operation: WorkspaceOperationHandleControlled,
  processHandle: WindowsSupervisorProcess,
  descriptor: BoundSupervisorDescriptor,
  timeoutMs: number,
  reason: PrestartAbortReason,
): Promise<void> {
  processHandle.expectCleanExit();
  await processHandle.send(
    embeddedEnvelope('ABORT_BEFORE_START', encodeSupervisorAbortBeforeStart(operation.operationId)),
  );
  const event = await processHandle.next('PRESTART_DRAINED');
  const drained = parseSupervisorPrestartDrained(event.messageBytes);
  if (
    drained.operationId !== operation.operationId ||
    drained.supervisorPid !== processHandle.pid ||
    drained.supervisorIdentity !== descriptor.supervisorIdentity
  ) {
    protocolInvalid('PRESTART_DRAINED does not bind the prepared-bound supervisor');
  }
  await processHandle.waitForPrestartExit(timeoutMs);
  assertExactProcessDeath(processHandle.pid, descriptor.supervisorIdentity, 'supervisor');
  await operation.abortPrestartControlled({
    reason,
    proof: 'supervisor-prestart-empty-v1',
    supervisor: 'dead',
    containment: 'empty',
    prestartDrainedBytes: event.messageBytes,
  });
}

async function quarantineUnfinishedWindowsOperation(
  operation: WorkspaceOperationHandleControlled,
  reason: 'containment-unconfirmed' | 'operation-proof-missing',
): Promise<void> {
  if (!operation.settled && !operation.quarantined) {
    await operation.installQuarantineControlled(reason);
  }
}

export async function runDarkWindowsSupervisedOperation(
  operation: WorkspaceOperationHandleControlled,
  options: RunDarkWindowsSupervisedOperationOptions,
): Promise<WindowsInvocationOutcome> {
  let terminationTrigger: TerminationTrigger | undefined;
  let processHandle: WindowsSupervisorProcess | undefined;
  let supervisorIdentity: string | undefined;
  let descriptor: BoundSupervisorDescriptor | undefined;
  let terminationAttempted = false;
  let completed = false;
  try {
    terminationTrigger = createTerminationTrigger(options.commandTimeoutMs, options.termination);
    throwIfPrestartInterrupted(terminationTrigger);
    if (process.platform !== 'win32') {
      throw new WorkspaceSafetyError('unsupported', 'Windows Job supervisor is unavailable here');
    }
    if (!isAbsolute(options.target.executable) || !isAbsolute(options.target.cwd)) {
      protocolInvalid('target executable and cwd must be absolute');
    }
    const launch = createWindowsSupervisorLaunch({
      assetRoot: fixedWindowsAssetRoot(),
      timeouts: options.timeouts,
    });
    const timeouts = resolveWindowsSupervisorTimeouts(options.timeouts);
    processHandle = new WindowsSupervisorProcess(
      spawnWindowsJobSupervisor(launch),
      timeouts.handshakeMs,
    );
    supervisorIdentity = exactProcessIdentity(processHandle.pid);
    throwIfPrestartInterrupted(terminationTrigger);
    const boundEvent = await processHandle.next('BOUND');
    descriptor = validateWindowsBound(processHandle, boundEvent, launch.assets.helperDigest);
    await options.hooks?.onBound?.({
      supervisorPid: processHandle.pid,
      supervisorIdentity: descriptor.supervisorIdentity,
    });
    throwIfPrestartInterrupted(terminationTrigger);
    await operation.bindSupervisorControlled(descriptor);
    await operation.readPreparedBoundBindingControlled(launch.assets.helperBytes);
    throwIfPrestartInterrupted(terminationTrigger);

    const dataBytes = encodeSupervisorData({
      operationId: operation.operationId,
      target: options.target,
    });
    await processHandle.send({
      schemaVersion: 1,
      type: 'DATA',
      workspacePath: operation.workspacePath,
      messageBase64: dataBytes.toString('base64'),
    });
    const armedEvent = await processHandle.next('ARMED');
    const containment = validateWindowsContainment(armedEvent);
    throwIfPrestartInterrupted(terminationTrigger);
    await operation.armContainmentControlled(containment);
    const armedBinding = await operation.readArmedBindingControlled(launch.assets.helperBytes);
    await options.hooks?.onArmed?.({ supervisorPid: processHandle.pid, containment });

    let startSent = false;
    let terminationSent: SupervisorTerminationReason | undefined;
    let started: WindowsStartedEvent | undefined;
    let result: WindowsResultEvent | undefined;
    let drained: WindowsDrainedEvent | undefined;
    const runningSupervisor = processHandle;
    const sendTermination = async (reason: SupervisorTerminationReason): Promise<void> => {
      if (terminationSent !== undefined) return;
      terminationSent = reason;
      terminationAttempted = true;
      await runningSupervisor.send(
        embeddedEnvelope('TERMINATE', encodeSupervisorTerminate(operation.operationId, reason)),
      );
      await options.hooks?.onTerminating?.({
        supervisorPid: runningSupervisor.pid,
        containment,
        reason,
      });
    };

    if (terminationTrigger.reason !== undefined) {
      await sendTermination(terminationTrigger.reason);
    } else {
      await processHandle.send(
        embeddedEnvelope(
          'START',
          encodeSupervisorStart(operation.operationId, armedBinding.activeChildDigest),
        ),
      );
      startSent = true;
      terminationTrigger.startCommandTimer();
    }

    let pendingEvent = processHandle.nextAny(['STARTED', 'RESULT', 'DRAINED'] as const, null);
    while (!drained) {
      if (terminationSent === undefined && terminationTrigger.reason !== undefined) {
        await sendTermination(terminationTrigger.reason);
      }
      const next =
        terminationSent === undefined
          ? await Promise.race([
              pendingEvent.then((event) => ({ kind: 'event' as const, event })),
              terminationTrigger.promise.then((reason) => ({
                kind: 'termination' as const,
                reason,
              })),
            ])
          : { kind: 'event' as const, event: await pendingEvent };
      if (next.kind === 'termination') {
        await sendTermination(next.reason);
        continue;
      }
      const event = next.event;
      if (event.type === 'STARTED') {
        if (started || result) protocolInvalid('STARTED is duplicated or follows RESULT');
        if (event.targetPid !== containment.targetPid) {
          protocolInvalid('STARTED target does not match ARMED containment');
        }
        started = event;
        await options.hooks?.onStarted?.({
          supervisorPid: processHandle.pid,
          containment,
          targetPid: event.targetPid,
        });
      } else if (event.type === 'RESULT') {
        if (!started || result) protocolInvalid('RESULT is duplicated or precedes STARTED');
        result = event;
        terminationTrigger.rootCompleted();
        await options.hooks?.onRootResult?.({
          supervisorPid: processHandle.pid,
          containment,
          code: event.code,
          signal: null,
        });
      } else {
        drained = event;
      }
      if (!drained) {
        pendingEvent = processHandle.nextAny(['STARTED', 'RESULT', 'DRAINED'] as const, null);
      }
    }

    terminationTrigger.dispose();
    const drainedMessage = parseSupervisorDrained(drained.messageBytes);
    const receipt = await operation.acceptInstalledDrainedReceiptControlled(drained.messageBytes);
    const receiptBytes = readFileSync(join(operation.operationPath, DRAINED_RECEIPT_FILE));
    parseDrainedReceipt(receiptBytes);
    if (
      drainedMessage.operationId !== operation.operationId ||
      drainedMessage.receiptDigest !== digestBytes(receiptBytes) ||
      receipt.containmentDigest !== digestBytes(jsonBytes(containment)) ||
      receipt.supervisorIdentity !== descriptor.supervisorIdentity
    ) {
      protocolInvalid('DRAINED receipt/containment/identity chain is inconsistent');
    }
    const externallyTerminated =
      receipt.drainReason === 'timeout' ||
      receipt.drainReason === 'user-interrupt' ||
      receipt.drainReason === 'parent-shutdown';
    if (
      ((receipt.drainReason === 'natural' || receipt.drainReason === 'process-tree-not-empty') &&
        (!startSent || !started || !result)) ||
      (receipt.proof === 'never-started-containment-empty-v1' &&
        (startSent || started !== undefined || result !== undefined)) ||
      (receipt.proof !== 'never-started-containment-empty-v1' &&
        receipt.proof !== 'windows-job-zero-and-pipes-eof-v1') ||
      (receipt.proof !== 'never-started-containment-empty-v1' && !startSent) ||
      (externallyTerminated &&
        (terminationSent === undefined || terminationSent !== receipt.drainReason))
    ) {
      protocolInvalid('receipt proof/reason does not match observed Windows events');
    }
    await options.hooks?.onDrained?.({ supervisorPid: processHandle.pid, containment, receipt });
    processHandle.expectCleanExit();
    await processHandle.send(
      embeddedEnvelope(
        'ACK',
        encodeSupervisorAcknowledgement(operation.operationId, drainedMessage.receiptDigest),
      ),
    );
    await processHandle.waitForCleanExit(timeouts.ackMs);
    assertExactProcessDeath(containment.targetPid, containment.targetIdentity, 'target process');
    assertExactProcessDeath(processHandle.pid, descriptor.supervisorIdentity, 'supervisor');
    const settlement = await operation.settleArmedControlled({
      supervisor: 'dead',
      containment: 'empty',
    });
    completed = true;
    const leftover = receipt.drainReason === 'process-tree-not-empty';
    const terminationReason = externallyTerminated ? receipt.drainReason : null;
    return {
      verdict: leftover
        ? 'process-tree-not-empty'
        : terminationReason
          ? 'terminated'
          : result?.code === 0
            ? 'completed'
            : 'root-failed',
      code: result?.code ?? null,
      signal: null,
      stdout: Buffer.concat(processHandle.stdout),
      stderr: Buffer.concat(processHandle.stderr),
      leftover,
      terminationReason,
      receipt,
      settledPath: settlement.settledPath,
      ...(settlement.candidate ? { candidate: settlement.candidate } : {}),
      supervisorPid: processHandle.pid,
      containment,
    };
  } catch (error) {
    let closeoutError: unknown;
    try {
      if (!operation.settled && !operation.quarantined) {
        const reason = prestartAbortReason(error, terminationTrigger?.reason);
        if (operation.activeState === 'prepared') {
          await abortPreparedWindowsOperation(operation, processHandle, supervisorIdentity, reason);
        } else if (operation.activeState === 'prepared-bound') {
          if (!processHandle || !descriptor) {
            protocolIsolated('prepared-bound operation lost its supervisor binding in memory');
          }
          const timeouts = resolveWindowsSupervisorTimeouts(options.timeouts);
          await abortPreparedBoundWindowsOperation(
            operation,
            processHandle,
            descriptor,
            timeouts.ackMs,
            reason,
          );
        } else {
          await quarantineUnfinishedWindowsOperation(
            operation,
            terminationAttempted || operation.receiptInstalled
              ? 'containment-unconfirmed'
              : 'operation-proof-missing',
          );
        }
      }
    } catch (failure) {
      closeoutError = failure;
      if (!operation.settled && !operation.quarantined) {
        try {
          await operation.installQuarantineControlled('containment-unconfirmed');
        } catch (quarantineError) {
          closeoutError = quarantineError;
        }
      }
    }
    throw closeoutError ?? error;
  } finally {
    terminationTrigger?.dispose();
    if (!completed && processHandle) await processHandle.abort();
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestBytes, jsonBytes } from './filesystem.js';
import { MonotonicDeadline } from './deadline.js';
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
  WINDOWS_SUPERVISOR_EXECUTABLE,
  createWindowsSupervisorLaunch,
  readWindowsSupervisorAssets,
  resolveWindowsSupervisorTimeouts,
  spawnWindowsJobSupervisor,
  type WindowsSupervisorTimeouts,
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
      fileURLToPath(new URL('./workspace-safety/coding-x-windows-supervisor.exe', import.meta.url)),
    ),
    fileURLToPath(new URL('../../assets/workspace-safety', import.meta.url)),
  ];
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, WINDOWS_SUPERVISOR_EXECUTABLE)),
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

function windowsDeadlineError(label: string): WorkspaceSafetyError {
  return new WorkspaceSafetyError(
    'isolated',
    `Windows supervisor did not prove completion before the ${label} deadline`,
  );
}

interface OperationDeadlineState {
  timedOut: boolean;
}

async function runOperationStepBefore<T>(
  deadline: MonotonicDeadline,
  state: OperationDeadlineState,
  label: string,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  let started = false;
  let finished = false;
  try {
    return await deadline.run(
      async () => {
        started = true;
        try {
          return await operation();
        } finally {
          finished = true;
        }
      },
      () => windowsDeadlineError(label),
    );
  } catch (error) {
    if (started && !finished && deadline.expired) state.timedOut = true;
    throw error;
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
  readonly commandDeadline: MonotonicDeadline | undefined;
  startCommandTimer(): void;
  commandDeadlineExpired(): boolean;
  rootCompleted(): void;
  failOutput(): void;
  dispose(): void;
}

export function createTerminationTrigger(
  commandTimeoutMs: number | undefined,
  termination: RunDarkWindowsSupervisedOperationOptions['termination'],
  outputFailureSignal?: AbortSignal,
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
  let commandDeadline: MonotonicDeadline | undefined;
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
  const onOutputFailure = (): void => freeze('output-failure');
  if (termination) {
    termination.signal.addEventListener('abort', onAbort, { once: true });
    if (termination.signal.aborted) freeze(termination.reason);
  }
  if (outputFailureSignal) {
    outputFailureSignal.addEventListener('abort', onOutputFailure, { once: true });
    if (outputFailureSignal.aborted) freeze('output-failure');
  }
  return {
    promise,
    get reason() {
      return frozenReason;
    },
    get commandDeadline() {
      return commandDeadline;
    },
    startCommandTimer() {
      if (commandTimeoutMs !== undefined && frozenReason === undefined) {
        commandDeadline = MonotonicDeadline.after(commandTimeoutMs);
        timeout = setTimeout(() => freeze('timeout'), commandDeadline.remainingMs());
      }
    },
    commandDeadlineExpired() {
      if (!commandDeadline?.expired) return false;
      freeze('timeout');
      return frozenReason === 'timeout';
    },
    rootCompleted() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      commandDeadline = undefined;
    },
    failOutput() {
      freeze('output-failure');
    },
    dispose() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      termination?.signal.removeEventListener('abort', onAbort);
      outputFailureSignal?.removeEventListener('abort', onOutputFailure);
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
  operationDeadline: OperationDeadlineState,
  deadline: MonotonicDeadline,
): Promise<void> {
  if (processHandle) {
    if (!supervisorIdentity) protocolIsolated('spawned supervisor identity was never established');
    await processHandle.abort(deadline);
    assertExactProcessDeath(processHandle.pid, supervisorIdentity, 'supervisor');
  }
  await runOperationStepBefore(deadline, operationDeadline, 'prestart settlement', () =>
    operation.abortPrestartControlled({
      reason,
      proof: 'supervisor-never-bound-v1',
      supervisor: processHandle ? 'dead' : 'never-created',
      containment: 'not-created',
    }),
  );
}

async function abortPreparedBoundWindowsOperation(
  operation: WorkspaceOperationHandleControlled,
  processHandle: WindowsSupervisorProcess,
  descriptor: BoundSupervisorDescriptor,
  reason: PrestartAbortReason,
  operationDeadline: OperationDeadlineState,
  deadline: MonotonicDeadline,
): Promise<void> {
  processHandle.expectCleanExit();
  await processHandle.sendBefore(
    embeddedEnvelope('ABORT_BEFORE_START', encodeSupervisorAbortBeforeStart(operation.operationId)),
    deadline,
    'prestart abort delivery',
  );
  const event = await processHandle.nextBefore(['PRESTART_DRAINED'], deadline, 'prestart drain');
  const drained = parseSupervisorPrestartDrained(event.messageBytes);
  if (
    drained.operationId !== operation.operationId ||
    drained.supervisorPid !== processHandle.pid ||
    drained.supervisorIdentity !== descriptor.supervisorIdentity
  ) {
    protocolInvalid('PRESTART_DRAINED does not bind the prepared-bound supervisor');
  }
  await processHandle.waitForPrestartExit(deadline);
  assertExactProcessDeath(processHandle.pid, descriptor.supervisorIdentity, 'supervisor');
  await runOperationStepBefore(deadline, operationDeadline, 'prestart settlement', () =>
    operation.abortPrestartControlled({
      reason,
      proof: 'supervisor-prestart-empty-v1',
      supervisor: 'dead',
      containment: 'empty',
      prestartDrainedBytes: event.messageBytes,
    }),
  );
}

async function quarantineUnfinishedWindowsOperation(
  operation: WorkspaceOperationHandleControlled,
  reason: 'containment-unconfirmed' | 'operation-proof-missing',
  deadline: MonotonicDeadline,
  operationDeadline: OperationDeadlineState,
): Promise<void> {
  if (!deadline.expired && !operation.settled && !operation.quarantined) {
    await runOperationStepBefore(deadline, operationDeadline, 'quarantine installation', () =>
      operation.installQuarantineControlled(reason),
    );
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
  let resolvedTimeouts: WindowsSupervisorTimeouts | undefined;
  let failureCloseoutDeadline: MonotonicDeadline | undefined;
  const operationDeadline: OperationDeadlineState = { timedOut: false };
  try {
    terminationTrigger = createTerminationTrigger(
      options.commandTimeoutMs,
      options.termination,
      options.outputFailureSignal,
    );
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
    resolvedTimeouts = timeouts;
    const prepareDeadline = MonotonicDeadline.after(timeouts.handshakeMs);
    processHandle = new WindowsSupervisorProcess(
      spawnWindowsJobSupervisor(launch),
      timeouts.handshakeMs,
      {
        ...(options.onOutput ? { onOutput: options.onOutput } : {}),
        onFailure: () => terminationTrigger!.failOutput(),
      },
      operation.operationId,
    );
    supervisorIdentity = exactProcessIdentity(processHandle.pid);
    throwIfPrestartInterrupted(terminationTrigger);
    const boundEvent = await processHandle.nextBefore(['BOUND'], prepareDeadline, 'prepare');
    descriptor = validateWindowsBound(processHandle, boundEvent, launch.assets.helperDigest);
    await prepareDeadline.run(
      () =>
        options.hooks?.onBound?.({
          supervisorPid: processHandle!.pid,
          supervisorIdentity: descriptor!.supervisorIdentity,
        }),
      () => windowsDeadlineError('prepare hook'),
    );
    throwIfPrestartInterrupted(terminationTrigger);
    await runOperationStepBefore(prepareDeadline, operationDeadline, 'prepare binding', () =>
      operation.bindSupervisorControlled(descriptor!),
    );
    await runOperationStepBefore(prepareDeadline, operationDeadline, 'prepare authority read', () =>
      operation.readPreparedBoundBindingControlled(launch.assets.helperBytes),
    );
    throwIfPrestartInterrupted(terminationTrigger);

    const dataBytes = encodeSupervisorData({
      operationId: operation.operationId,
      target: options.target,
    });
    await processHandle.sendBefore(
      {
        schemaVersion: 1,
        type: 'DATA',
        workspacePath: operation.workspacePath,
        messageBase64: dataBytes.toString('base64'),
      },
      prepareDeadline,
      'DATA delivery',
    );
    const armedEvent = await processHandle.nextBefore(['ARMED'], prepareDeadline, 'prepare');
    const containment = validateWindowsContainment(armedEvent);
    throwIfPrestartInterrupted(terminationTrigger);
    await runOperationStepBefore(
      prepareDeadline,
      operationDeadline,
      'prepare containment binding',
      () => operation.armContainmentControlled(containment),
    );
    const armedBinding = await runOperationStepBefore(
      prepareDeadline,
      operationDeadline,
      'prepare armed authority read',
      () => operation.readArmedBindingControlled(launch.assets.helperBytes),
    );
    await prepareDeadline.run(
      () => options.hooks?.onArmed?.({ supervisorPid: processHandle!.pid, containment }),
      () => windowsDeadlineError('prepare hook'),
    );

    let startSent = false;
    let terminationSent: SupervisorTerminationReason | undefined;
    let started: WindowsStartedEvent | undefined;
    let result: WindowsResultEvent | undefined;
    let drained: WindowsDrainedEvent | undefined;
    let closeoutDeadline: MonotonicDeadline | undefined;
    let outputDiscarded = false;
    const runningSupervisor = processHandle;
    const sendTermination = async (reason: SupervisorTerminationReason): Promise<void> => {
      if (terminationSent !== undefined) return;
      if (closeoutDeadline) closeoutDeadline.tightenAfter(timeouts.terminateMs);
      else closeoutDeadline = MonotonicDeadline.after(timeouts.terminateMs);
      failureCloseoutDeadline = closeoutDeadline;
      terminationSent = reason;
      terminationAttempted = true;
      if (!outputDiscarded) {
        try {
          options.onOutputDiscard?.();
        } catch {
          // Releasing downstream backpressure must not replace mechanical termination.
        }
        runningSupervisor.discardOutput();
        outputDiscarded = true;
      }
      await runningSupervisor.sendBefore(
        embeddedEnvelope('TERMINATE', encodeSupervisorTerminate(operation.operationId, reason)),
        closeoutDeadline,
        'termination delivery',
      );
      await closeoutDeadline.run(
        () =>
          options.hooks?.onTerminating?.({
            supervisorPid: runningSupervisor.pid,
            containment,
            reason,
          }),
        () => windowsDeadlineError('termination hook'),
      );
    };

    if (terminationTrigger.reason !== undefined) {
      await sendTermination(terminationTrigger.reason);
    } else {
      await processHandle.sendBefore(
        embeddedEnvelope(
          'START',
          encodeSupervisorStart(operation.operationId, armedBinding.activeChildDigest),
        ),
        prepareDeadline,
        'START delivery',
      );
      startSent = true;
      terminationTrigger.startCommandTimer();
    }

    let pendingEvent = processHandle.nextAny(['STARTED', 'RESULT', 'DRAINED'] as const, null);
    while (!drained) {
      if (terminationSent === undefined && terminationTrigger.reason !== undefined) {
        await sendTermination(terminationTrigger.reason);
      }
      const next = closeoutDeadline
        ? await processHandle.racePendingBefore(
            pendingEvent,
            closeoutDeadline,
            'termination and drain',
            terminationSent === undefined ? terminationTrigger.promise : undefined,
          )
        : await Promise.race([
            pendingEvent.then((event) => ({ kind: 'event' as const, event })),
            terminationTrigger.promise.then((reason) => ({
              kind: 'termination' as const,
              reason,
            })),
          ]);
      if (next.kind === 'termination') {
        await sendTermination(next.reason);
        continue;
      }
      const event = next.event;
      if (terminationSent === undefined && terminationTrigger.commandDeadlineExpired()) {
        await sendTermination('timeout');
      }
      if (event.type === 'STARTED') {
        if (started || result) protocolInvalid('STARTED is duplicated or follows RESULT');
        if (event.targetPid !== containment.targetPid) {
          protocolInvalid('STARTED target does not match ARMED containment');
        }
        started = event;
        if (options.hooks?.onStarted && terminationSent === undefined) {
          const startedHook = () =>
            options.hooks!.onStarted!({
              supervisorPid: processHandle!.pid,
              containment,
              targetPid: event.targetPid,
            });
          if (terminationTrigger.commandDeadline) {
            await terminationTrigger.commandDeadline.run(startedHook, () =>
              windowsDeadlineError('command hook'),
            );
          } else {
            await startedHook();
          }
        }
      } else if (event.type === 'RESULT') {
        if (!started || result) protocolInvalid('RESULT is duplicated or precedes STARTED');
        result = event;
        terminationTrigger.rootCompleted();
        closeoutDeadline ??= MonotonicDeadline.after(
          terminationTrigger.reason === undefined
            ? timeouts.naturalDrainMs + timeouts.terminateMs
            : timeouts.terminateMs,
        );
        failureCloseoutDeadline = closeoutDeadline;
        await closeoutDeadline.run(
          () =>
            options.hooks?.onRootResult?.({
              supervisorPid: processHandle!.pid,
              containment,
              code: event.code,
              signal: null,
            }),
          () => windowsDeadlineError('natural drain hook'),
        );
      } else {
        if (!result && terminationSent === undefined) {
          protocolInvalid('DRAINED without RESULT requires a bound external termination');
        }
        drained = event;
      }
      if (!drained) {
        pendingEvent = processHandle.nextAny(['STARTED', 'RESULT', 'DRAINED'] as const, null);
      }
    }

    terminationTrigger.dispose();
    if (!outputDiscarded) {
      await processHandle.waitForOutputConsumption(
        closeoutDeadline ?? MonotonicDeadline.after(timeouts.naturalDrainMs),
      );
    }
    const ackExitDeadline = MonotonicDeadline.after(timeouts.ackMs);
    failureCloseoutDeadline = ackExitDeadline;
    const drainedMessage = parseSupervisorDrained(drained.messageBytes);
    const receipt = await runOperationStepBefore(
      ackExitDeadline,
      operationDeadline,
      'receipt acceptance',
      () => operation.acceptInstalledDrainedReceiptControlled(drained.messageBytes),
    );
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
      receipt.drainReason === 'parent-shutdown' ||
      receipt.drainReason === 'output-failure';
    if (
      ((receipt.drainReason === 'natural' || receipt.drainReason === 'process-tree-not-empty') &&
        (!startSent || !started || !result)) ||
      (receipt.proof === 'never-started-containment-empty-v1' &&
        (startSent || started !== undefined || result !== undefined)) ||
      (receipt.proof !== 'never-started-containment-empty-v1' &&
        receipt.proof !== 'windows-job-zero-pipes-eof-output-settled-v2') ||
      (receipt.proof !== 'never-started-containment-empty-v1' && !startSent) ||
      (externallyTerminated &&
        (terminationSent === undefined || terminationSent !== receipt.drainReason))
    ) {
      protocolInvalid('receipt proof/reason does not match observed Windows events');
    }
    await ackExitDeadline.run(
      () => options.hooks?.onDrained?.({ supervisorPid: processHandle!.pid, containment, receipt }),
      () => windowsDeadlineError('post-drain hook'),
    );
    processHandle.expectCleanExit();
    await processHandle.sendBefore(
      embeddedEnvelope(
        'ACK',
        encodeSupervisorAcknowledgement(operation.operationId, drainedMessage.receiptDigest),
      ),
      ackExitDeadline,
      'ACK delivery',
    );
    await processHandle.waitForCleanExit(ackExitDeadline);
    assertExactProcessDeath(containment.targetPid, containment.targetIdentity, 'target process');
    assertExactProcessDeath(processHandle.pid, descriptor.supervisorIdentity, 'supervisor');
    const settlement = await runOperationStepBefore(
      ackExitDeadline,
      operationDeadline,
      'final settlement',
      () =>
        operation.settleArmedControlled({
          supervisor: 'dead',
          containment: 'empty',
        }),
    );
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
      code: terminationReason ? null : (result?.code ?? null),
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
    const failureTimeouts = resolvedTimeouts ?? resolveWindowsSupervisorTimeouts(options.timeouts);
    failureCloseoutDeadline ??= MonotonicDeadline.after(
      operationDeadline.timedOut ? 0 : failureTimeouts.terminateMs + failureTimeouts.ackMs,
    );
    try {
      if (!operationDeadline.timedOut && !operation.settled && !operation.quarantined) {
        const reason = prestartAbortReason(error, terminationTrigger?.reason);
        if (operation.activeState === 'prepared') {
          await abortPreparedWindowsOperation(
            operation,
            processHandle,
            supervisorIdentity,
            reason,
            operationDeadline,
            failureCloseoutDeadline,
          );
        } else if (operation.activeState === 'prepared-bound') {
          if (!processHandle || !descriptor) {
            protocolIsolated('prepared-bound operation lost its supervisor binding in memory');
          }
          await abortPreparedBoundWindowsOperation(
            operation,
            processHandle,
            descriptor,
            reason,
            operationDeadline,
            failureCloseoutDeadline,
          );
        } else {
          await quarantineUnfinishedWindowsOperation(
            operation,
            terminationAttempted || operation.receiptInstalled
              ? 'containment-unconfirmed'
              : 'operation-proof-missing',
            failureCloseoutDeadline,
            operationDeadline,
          );
        }
      }
    } catch (failure) {
      closeoutError = failure;
      if (!operationDeadline.timedOut && !operation.settled && !operation.quarantined) {
        try {
          await quarantineUnfinishedWindowsOperation(
            operation,
            'containment-unconfirmed',
            failureCloseoutDeadline,
            operationDeadline,
          );
        } catch (quarantineError) {
          closeoutError = quarantineError;
        }
      }
    }
    throw closeoutError ?? error;
  } finally {
    terminationTrigger?.dispose();
    if (!completed && processHandle) {
      await processHandle.abort(failureCloseoutDeadline ?? MonotonicDeadline.after(0));
    }
  }
}

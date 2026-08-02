import { join } from 'node:path';
import {
  acquireBootstrapRecoveryAttempt,
  captureBootstrapRecoverySourceSnapshotDigest,
  installBootstrapRecoveryDomain,
} from './bootstrap-recovery.js';
import {
  acquireDelegatedFinalizeRecovery,
  installDelegatedFinalizeRecovery,
} from './delegated-recovery.js';
import {
  evaluateWorkspaceSafetyDisk,
  type WorkspaceSafetyDiskEvaluation,
  type WorkspaceSafetyDiskReason,
} from './disk-evaluator.js';
import { pathExists } from './filesystem.js';
import { readCanonicalMutationDomain, type MutationDomain } from './mutation-domain.js';
import {
  acquireMutationRecoveryAttempt,
  installMutationRecoveryDomain,
} from './mutation-recovery.js';
import { acquirePrestartRecovery, installPrestartRecovery } from './prestart-recovery.js';
import {
  acquireSameHostRebootRecovery,
  inspectSameHostRebootRecovery,
  installSameHostRebootRecovery,
  type SameHostRebootRecoveryMode,
} from './reboot-recovery.js';
import {
  acquireRecoveryAttempt,
  captureRecoverySourceSnapshotDigest,
  installRecoveryDomain,
  loadRecoveryContext,
  readRecoveryDomain,
} from './recovery.js';
import {
  createBootstrapRecoverySession,
  createDelegatedRecoverySession,
  createMutationRecoverySession,
  createPrestartRecoverySession,
  createRecoverySession,
  createSameHostRebootRecoverySession,
  type RecoverySession,
  type RecoverySessionCompletion,
} from './recovery-session.js';
import {
  ACTIVE_LEASE_DIR,
  MUTATION_DIR,
  PROTOCOL_ROOT_DIR,
  type WorkspaceSafetyClassification,
  WorkspaceSafetyError,
} from './types.js';

export type WorkspaceRecoveryCommand = 'recover' | 'resume-mutation';

export type WorkspaceRecoveryMode =
  | 'bootstrap-complete'
  | 'mechanical-empty'
  | 'prestart'
  | 'delegated-finalize'
  | 'same-host-reboot'
  | 'mutation-resume';

export type WorkspaceRecoveryFailureCode =
  | 'uninitialized'
  | 'already-ready'
  | 'active-owner'
  | 'insufficient-evidence'
  | 'invalid-records'
  | 'legacy-workspace'
  | 'wrong-command'
  | 'ambiguous-mode'
  | 'recovery-conflict'
  | 'recovery-failed';

export interface WorkspaceRecoverySuccess {
  readonly ok: true;
  readonly exitCode: 0 | 7;
  readonly command: WorkspaceRecoveryCommand;
  readonly mode: WorkspaceRecoveryMode;
  readonly message: string;
  readonly workspacePath: string;
  readonly targetArchive: string;
  readonly archivePath: string;
  readonly rebootMode?: SameHostRebootRecoveryMode;
  readonly runtimeMode?: 'formal' | 'shadow';
}

export interface WorkspaceRecoveryFailure {
  readonly ok: false;
  readonly exitCode: 2;
  readonly command: WorkspaceRecoveryCommand;
  readonly code: WorkspaceRecoveryFailureCode;
  readonly message: string;
  readonly classification: WorkspaceSafetyClassification;
  readonly reason: WorkspaceSafetyDiskReason;
  readonly detail?: string;
}

export type WorkspaceRecoveryResult = WorkspaceRecoverySuccess | WorkspaceRecoveryFailure;

export interface WorkspaceRecoveryOptions {
  readonly workspacePath: string;
  readonly termination?: {
    readonly signal: AbortSignal;
  };
}

type RecoveryCompletion = {
  readonly workspacePath: string;
  readonly targetArchive: string;
  readonly archivePath: string;
};

const SUCCESS_MESSAGE: Record<WorkspaceRecoveryCommand, string> = {
  recover: 'Workspace 恢复完成。',
  'resume-mutation': 'Workspace mutation 恢复完成。',
};

function success(
  command: WorkspaceRecoveryCommand,
  mode: WorkspaceRecoveryMode,
  completion: RecoveryCompletion,
  rebootMode?: SameHostRebootRecoveryMode,
  runtimeMode?: 'formal' | 'shadow',
): WorkspaceRecoverySuccess {
  return {
    ok: true,
    exitCode: runtimeMode === 'shadow' ? 7 : 0,
    command,
    mode,
    message: SUCCESS_MESSAGE[command],
    workspacePath: completion.workspacePath,
    targetArchive: completion.targetArchive,
    archivePath: completion.archivePath,
    ...(rebootMode ? { rebootMode } : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
  };
}

function rejectionFor(
  command: WorkspaceRecoveryCommand,
  evaluation: WorkspaceSafetyDiskEvaluation,
): WorkspaceRecoveryFailure {
  const base = {
    ok: false as const,
    exitCode: 2 as const,
    command,
    classification: evaluation.classification,
    reason: evaluation.reason,
  };
  switch (evaluation.classification) {
    case 'uninitialized-empty':
      return {
        ...base,
        code: 'uninitialized',
        message: 'Workspace 尚未初始化，没有可恢复记录。',
      };
    case 'ready':
      return {
        ...base,
        code: 'already-ready',
        message: 'Workspace 已就绪，没有可恢复记录。',
      };
    case 'active':
      return {
        ...base,
        code: 'active-owner',
        message: 'Workspace 仍有活动持有者，不能恢复。',
      };
    case 'isolated':
      return {
        ...base,
        code: 'insufficient-evidence',
        message: 'Workspace 恢复证据不足，已保持隔离。',
      };
    case 'invalid':
      return {
        ...base,
        code: 'invalid-records',
        message: 'Workspace 安全记录无效，不能恢复。',
      };
    case 'legacy':
      return {
        ...base,
        code: 'legacy-workspace',
        message: '旧版 Workspace 不支持安全恢复。',
      };
    case 'recoverable':
    case 'recovering':
      return {
        ...base,
        code: 'ambiguous-mode',
        message: 'Workspace 没有唯一可执行的恢复模式。',
      };
  }
}

function wrongCommand(
  command: WorkspaceRecoveryCommand,
  evaluation: WorkspaceSafetyDiskEvaluation,
  message: string,
): WorkspaceRecoveryFailure {
  return {
    ok: false,
    exitCode: 2,
    command,
    code: 'wrong-command',
    message,
    classification: evaluation.classification,
    reason: evaluation.reason,
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interruptError(): WorkspaceSafetyError {
  return new WorkspaceSafetyError('closed', 'Workspace 恢复已在安全边界收到用户中断');
}

function throwIfInterrupted(options: WorkspaceRecoveryOptions): void {
  if (options.termination?.signal.aborted) throw interruptError();
}

async function finalizeWithCommandSignal<Completion extends RecoverySessionCompletion>(
  session: RecoverySession<Completion, unknown>,
  options: WorkspaceRecoveryOptions,
): Promise<Completion> {
  const signal = options.termination?.signal;
  let interruptPromise: Promise<unknown> | undefined;
  const requestInterrupt = (): void => {
    interruptPromise ??= session.requestInterrupt();
  };
  signal?.addEventListener('abort', requestInterrupt, { once: true });
  if (signal?.aborted) requestInterrupt();
  try {
    return await session.finalize();
  } finally {
    signal?.removeEventListener('abort', requestInterrupt);
    if (signal?.aborted) requestInterrupt();
    await interruptPromise;
  }
}

function recoveryError(
  command: WorkspaceRecoveryCommand,
  evaluation: WorkspaceSafetyDiskEvaluation,
  error: unknown,
): WorkspaceRecoveryFailure {
  const conflict =
    error instanceof WorkspaceSafetyError &&
    (error.code === 'conflict' || error.code === 'lease-lost' || error.code === 'closed');
  return {
    ok: false,
    exitCode: 2,
    command,
    code: conflict ? 'recovery-conflict' : 'recovery-failed',
    message: conflict
      ? 'Workspace 恢复未取得唯一执行权，已停止。'
      : 'Workspace 恢复未能安全完成，已停止。',
    classification: evaluation.classification,
    reason: evaluation.reason,
    detail: errorDetail(error),
  };
}

function evaluationError(
  command: WorkspaceRecoveryCommand,
  error: unknown,
): WorkspaceRecoveryFailure {
  return {
    ok: false,
    exitCode: 2,
    command,
    code: 'invalid-records',
    message: 'Workspace 安全状态无法可靠读取，不能恢复。',
    classification: 'invalid',
    reason: 'invalid-safety-record',
    detail: errorDetail(error),
  };
}

async function canonicalMutation(workspacePath: string): Promise<MutationDomain | null> {
  const context = await loadRecoveryContext(workspacePath);
  const mutationPath = join(
    context.records.workspace.path,
    PROTOCOL_ROOT_DIR,
    ACTIVE_LEASE_DIR,
    MUTATION_DIR,
  );
  if (!(await pathExists(mutationPath))) return null;
  return await readCanonicalMutationDomain({
    workspace: context.records.workspace,
    expectedOwner: context.sourceOwner,
  });
}

function mutationRuntimeMode(domain: MutationDomain): 'formal' | 'shadow' | undefined {
  if (domain.state.kind === 'apply-prd-shadow-v1') return 'shadow';
  return domain.state.kind === 'apply-prd-v1' ? 'formal' : undefined;
}

function isPotentialSameHostReboot(evaluation: WorkspaceSafetyDiskEvaluation): boolean {
  return (
    evaluation.classification === 'isolated' &&
    evaluation.reason === 'containment-unconfirmed' &&
    evaluation.facts.quarantine === 'containment-unconfirmed' &&
    evaluation.facts.canonical === 'valid' &&
    evaluation.facts.recovery === 'absent' &&
    evaluation.facts.recoveryInputs === 'valid' &&
    evaluation.facts.lease === 'valid' &&
    evaluation.facts.owner === 'dead' &&
    !evaluation.facts.foreignHost &&
    !evaluation.facts.bootstrapLease
  );
}

async function continueInstalledRecover(
  options: WorkspaceRecoveryOptions,
  evaluation: WorkspaceSafetyDiskEvaluation,
): Promise<WorkspaceRecoveryResult> {
  const { workspacePath } = options;
  if (evaluation.facts.bootstrapLease) {
    throwIfInterrupted(options);
    const handle = await acquireBootstrapRecoveryAttempt({ workspacePath });
    return success(
      'recover',
      'bootstrap-complete',
      await finalizeWithCommandSignal(createBootstrapRecoverySession(handle), options),
    );
  }

  const domain = await readRecoveryDomain(workspacePath);
  if (domain.claim.mode === 'mutation-resume') {
    return wrongCommand(
      'recover',
      evaluation,
      '检测到 mutation 恢复；请使用 workspace resume-mutation。',
    );
  }
  if (domain.claim.mode === 'bootstrap-complete') {
    return {
      ...rejectionFor('recover', evaluation),
      code: 'ambiguous-mode',
      message: '普通 Workspace 中出现了 bootstrap 恢复记录，不能继续。',
    };
  }
  if (domain.claim.rebootProof) {
    throwIfInterrupted(options);
    const handle = await acquireSameHostRebootRecovery({ workspacePath });
    const rebootMode: SameHostRebootRecoveryMode =
      domain.claim.mode === 'delegated-finalize'
        ? 'delegated-finalize'
        : domain.claim.prestartOperation
          ? 'prestart'
          : 'mechanical-empty';
    return success(
      'recover',
      'same-host-reboot',
      await finalizeWithCommandSignal(createSameHostRebootRecoverySession(handle), options),
      rebootMode,
    );
  }
  if (domain.claim.mode === 'delegated-finalize') {
    throwIfInterrupted(options);
    const handle = await acquireDelegatedFinalizeRecovery({ workspacePath });
    return success(
      'recover',
      'delegated-finalize',
      await finalizeWithCommandSignal(createDelegatedRecoverySession(handle), options),
    );
  }
  if (domain.claim.prestartOperation) {
    throwIfInterrupted(options);
    const handle = await acquirePrestartRecovery({ workspacePath });
    return success(
      'recover',
      'prestart',
      await finalizeWithCommandSignal(createPrestartRecoverySession(handle), options),
    );
  }
  throwIfInterrupted(options);
  const handle = await acquireRecoveryAttempt({ workspacePath });
  return success(
    'recover',
    'mechanical-empty',
    await finalizeWithCommandSignal(createRecoverySession(handle), options),
  );
}

async function startRecoverable(
  options: WorkspaceRecoveryOptions,
  evaluation: WorkspaceSafetyDiskEvaluation,
): Promise<WorkspaceRecoveryResult> {
  const { workspacePath } = options;
  if (evaluation.facts.bootstrapLease) {
    const expectedSourceSnapshotDigest =
      await captureBootstrapRecoverySourceSnapshotDigest(workspacePath);
    throwIfInterrupted(options);
    const handle = await installBootstrapRecoveryDomain({
      workspacePath,
      expectedSourceSnapshotDigest,
    });
    return success(
      'recover',
      'bootstrap-complete',
      await finalizeWithCommandSignal(createBootstrapRecoverySession(handle), options),
    );
  }
  if ((await canonicalMutation(workspacePath)) !== null) {
    return wrongCommand(
      'recover',
      evaluation,
      '检测到 mutation 恢复；请使用 workspace resume-mutation。',
    );
  }
  if (evaluation.operationState === 'prepared' || evaluation.operationState === 'prepared-bound') {
    throwIfInterrupted(options);
    const handle = await installPrestartRecovery({ workspacePath });
    return success(
      'recover',
      'prestart',
      await finalizeWithCommandSignal(createPrestartRecoverySession(handle), options),
    );
  }
  if (evaluation.operationState === 'armed') {
    throwIfInterrupted(options);
    const handle = await installDelegatedFinalizeRecovery({ workspacePath });
    return success(
      'recover',
      'delegated-finalize',
      await finalizeWithCommandSignal(createDelegatedRecoverySession(handle), options),
    );
  }
  const expectedSourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspacePath);
  throwIfInterrupted(options);
  const handle = await installRecoveryDomain({
    workspacePath,
    expectedSourceSnapshotDigest,
  });
  return success(
    'recover',
    'mechanical-empty',
    await finalizeWithCommandSignal(createRecoverySession(handle), options),
  );
}

/**
 * Selects one recovery route from stable disk evidence and then delegates all writes to that
 * route's public recovery API. This module never edits or removes safety records itself.
 */
export async function runWorkspaceRecover(
  options: WorkspaceRecoveryOptions,
): Promise<WorkspaceRecoveryResult> {
  let evaluation: WorkspaceSafetyDiskEvaluation;
  try {
    evaluation = await evaluateWorkspaceSafetyDisk({
      workspacePath: options.workspacePath,
    });
  } catch (error) {
    return evaluationError('recover', error);
  }
  try {
    throwIfInterrupted(options);
    if (evaluation.classification === 'recovering') {
      return await continueInstalledRecover(options, evaluation);
    }
    if (evaluation.classification === 'recoverable') {
      return await startRecoverable(options, evaluation);
    }
    if (isPotentialSameHostReboot(evaluation)) {
      const plan = await inspectSameHostRebootRecovery({
        workspacePath: options.workspacePath,
      });
      throwIfInterrupted(options);
      const handle = await installSameHostRebootRecovery({
        workspacePath: options.workspacePath,
      });
      return success(
        'recover',
        'same-host-reboot',
        await finalizeWithCommandSignal(createSameHostRebootRecoverySession(handle), options),
        plan.mode,
      );
    }
    return rejectionFor('recover', evaluation);
  } catch (error) {
    return recoveryError('recover', evaluation, error);
  }
}

async function continueMutation(
  options: WorkspaceRecoveryOptions,
  evaluation: WorkspaceSafetyDiskEvaluation,
): Promise<WorkspaceRecoveryResult> {
  const { workspacePath } = options;
  if (evaluation.facts.bootstrapLease) {
    return wrongCommand(
      'resume-mutation',
      evaluation,
      '检测到普通恢复；请使用 workspace recover。',
    );
  }
  const domain = await readRecoveryDomain(workspacePath);
  if (domain.claim.mode !== 'mutation-resume') {
    return wrongCommand(
      'resume-mutation',
      evaluation,
      '当前记录不是 mutation 恢复；请使用 workspace recover。',
    );
  }
  const mutation = await canonicalMutation(workspacePath);
  if (mutation === null) {
    return wrongCommand(
      'resume-mutation',
      evaluation,
      '当前记录不是 mutation 恢复；请使用 workspace recover。',
    );
  }
  throwIfInterrupted(options);
  const handle = await acquireMutationRecoveryAttempt({ workspacePath });
  return success(
    'resume-mutation',
    'mutation-resume',
    await finalizeWithCommandSignal(createMutationRecoverySession(handle), options),
    undefined,
    mutationRuntimeMode(mutation),
  );
}

/**
 * Resumes only a strictly validated fixed mutation. Other recovery modes remain owned by
 * runWorkspaceRecover so the two commands cannot accidentally authorize one another.
 */
export async function runWorkspaceResumeMutation(
  options: WorkspaceRecoveryOptions,
): Promise<WorkspaceRecoveryResult> {
  let evaluation: WorkspaceSafetyDiskEvaluation;
  try {
    evaluation = await evaluateWorkspaceSafetyDisk({
      workspacePath: options.workspacePath,
    });
  } catch (error) {
    return evaluationError('resume-mutation', error);
  }
  try {
    throwIfInterrupted(options);
    if (evaluation.classification === 'recovering') {
      return await continueMutation(options, evaluation);
    }
    if (evaluation.classification === 'recoverable') {
      const mutation = await canonicalMutation(options.workspacePath);
      if (mutation === null) {
        return wrongCommand(
          'resume-mutation',
          evaluation,
          '当前记录不是 mutation 恢复；请使用 workspace recover。',
        );
      }
      throwIfInterrupted(options);
      const handle = await installMutationRecoveryDomain({
        workspacePath: options.workspacePath,
      });
      return success(
        'resume-mutation',
        'mutation-resume',
        await finalizeWithCommandSignal(createMutationRecoverySession(handle), options),
        undefined,
        mutationRuntimeMode(mutation),
      );
    }
    return rejectionFor('resume-mutation', evaluation);
  } catch (error) {
    return recoveryError('resume-mutation', evaluation, error);
  }
}

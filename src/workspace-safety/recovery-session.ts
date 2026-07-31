import type { BootstrapRecoveryAttemptHandle } from './bootstrap-recovery.js';
import {
  finalizeBootstrapRecoveryControlled,
  type BootstrapRecoveryCompletion,
} from './bootstrap-recovery-finalize.js';
import {
  finalizeDelegatedRecoveryControlled,
  type DelegatedRecoveryCompletion,
} from './delegated-recovery-finalize.js';
import { readFixedPlatformHelperBundle } from './fixed-platform-helper.js';
import { captureExactCurrentIdentityAuthority } from './identity.js';
import {
  resumeMutationRecoveryControlled,
  type MutationRecoveryCompletion,
} from './mutation-recovery.js';
import {
  finalizePrestartRecoveryControlled,
  type PrestartRecoveryCompletion,
} from './prestart-recovery-finalize.js';
import type { RecoveryAttemptHandle } from './recovery-attempt.js';
import {
  finalizeMechanicalEmptyRecoveryControlled,
  type ControlledFinalizeMechanicalEmptyRecoveryOptions,
  type MechanicalEmptyRecoveryCompletion,
} from './recovery-finalize.js';
import {
  finalizeSameHostRebootRecoveryControlled,
  type SameHostRebootRecoveryCompletion,
  type SameHostRebootRecoveryHandle,
} from './reboot-recovery.js';
import { WorkspaceSafetyError } from './types.js';

export type RecoverySessionState =
  'open' | 'finalizing' | 'committing' | 'preserved' | 'ready' | 'failed';

export type RecoveryInterruptReason = 'user-interrupt';

export interface RecoverySessionCompletion {
  readonly workspacePath: string;
  readonly targetArchive: string;
  readonly archivePath: string;
}

export type RecoveryInterruptResult<
  Completion extends RecoverySessionCompletion = MechanicalEmptyRecoveryCompletion,
> =
  | {
      readonly status: 'preserved';
      readonly reason: RecoveryInterruptReason;
    }
  | {
      readonly status: 'ready';
      readonly reason: RecoveryInterruptReason;
      readonly completion: Completion;
    };

export type ControlledRecoverySessionOptions = Omit<
  ControlledFinalizeMechanicalEmptyRecoveryOptions,
  | 'probeSourceOwner'
  | 'expectedRebootQuarantine'
  | 'verifySystemAuthority'
  | 'finalRenameCommitCheck'
>;

type RecoveryFinalizer<Completion extends RecoverySessionCompletion> = (
  finalRenameCommitCheck: () => void,
) => Promise<Completion>;

const RECOVERY_SESSION_AUTHORITY = Symbol('recovery-session-authority');

function mechanicalFinalizer(
  attempt: RecoveryAttemptHandle,
  options: ControlledRecoverySessionOptions,
): RecoveryFinalizer<MechanicalEmptyRecoveryCompletion> {
  return async (finalRenameCommitCheck) => {
    const system = captureExactCurrentIdentityAuthority();
    return await finalizeMechanicalEmptyRecoveryControlled(attempt, {
      ...options,
      attemptIdentity: system.identity,
      probeSourceOwner: system.probeOwner,
      verifySystemAuthority: system.verifyCurrent,
      finalRenameCommitCheck,
    });
  };
}

/**
 * The one recovery coordinator that serializes the first supported user interrupt with the final
 * active-lease rename. Mode-specific factories below supply the only trusted finalizer callback.
 */
export class RecoverySession<
  Completion extends RecoverySessionCompletion = MechanicalEmptyRecoveryCompletion,
  Attempt = RecoveryAttemptHandle,
> {
  #state: RecoverySessionState = 'open';
  #interruptReason: RecoveryInterruptReason | undefined;
  #interruptPromise: Promise<RecoveryInterruptResult<Completion>> | undefined;
  #finalizePromise: Promise<Completion> | undefined;
  #completion: Completion | undefined;
  readonly #finalizer: RecoveryFinalizer<Completion>;

  constructor(
    token: typeof RECOVERY_SESSION_AUTHORITY,
    readonly attempt: Attempt,
    options: ControlledRecoverySessionOptions,
    finalizer?: RecoveryFinalizer<Completion>,
  ) {
    if (token !== RECOVERY_SESSION_AUTHORITY) {
      throw new WorkspaceSafetyError('invalid', 'recovery session authority token is invalid');
    }
    this.#finalizer =
      finalizer ??
      (mechanicalFinalizer(
        attempt as unknown as RecoveryAttemptHandle,
        options,
      ) as unknown as RecoveryFinalizer<Completion>);
  }

  get state(): RecoverySessionState {
    return this.#state;
  }

  finalize(): Promise<Completion> {
    if (this.#finalizePromise) return this.#finalizePromise;
    if (this.#state !== 'open') {
      return Promise.reject(
        new WorkspaceSafetyError('closed', 'recovery session 已停止，不能再次开始 finalization'),
      );
    }

    this.#state = 'finalizing';
    const running = this.#finalizer(() => {
      if (this.#interruptReason) {
        this.#state = 'preserved';
        throw new WorkspaceSafetyError(
          'closed',
          'recovery finalization 在最终 rename 前收到用户中断',
        );
      }
      this.#state = 'committing';
    });
    this.#finalizePromise = running.then(
      (completion) => {
        this.#completion = completion;
        this.#state = 'ready';
        return completion;
      },
      (error: unknown) => {
        if (this.#state !== 'preserved') this.#state = 'failed';
        throw error;
      },
    );
    return this.#finalizePromise;
  }

  requestInterrupt(
    reason: RecoveryInterruptReason = 'user-interrupt',
  ): Promise<RecoveryInterruptResult<Completion>> {
    if (this.#interruptPromise) return this.#interruptPromise;
    this.#interruptReason = reason;

    if (this.#state === 'ready' && this.#completion) {
      this.#interruptPromise = Promise.resolve({
        status: 'ready',
        reason,
        completion: this.#completion,
      });
      return this.#interruptPromise;
    }
    if (this.#state === 'open') {
      this.#state = 'preserved';
      this.#interruptPromise = Promise.resolve({ status: 'preserved', reason });
      return this.#interruptPromise;
    }
    if (this.#state === 'preserved' || this.#state === 'failed') {
      this.#interruptPromise = Promise.resolve({ status: 'preserved', reason });
      return this.#interruptPromise;
    }

    const finalization = this.#finalizePromise;
    if (!finalization) {
      throw new WorkspaceSafetyError('invalid', 'recovery session finalization 状态不完整');
    }
    this.#interruptPromise = finalization.then(
      (completion): RecoveryInterruptResult<Completion> => ({
        status: 'ready',
        reason,
        completion,
      }),
      (): RecoveryInterruptResult<Completion> => ({ status: 'preserved', reason }),
    );
    return this.#interruptPromise;
  }
}

export function createRecoverySession(
  attempt: RecoveryAttemptHandle,
): RecoverySession<MechanicalEmptyRecoveryCompletion> {
  return new RecoverySession(RECOVERY_SESSION_AUTHORITY, attempt, {});
}

export function createBootstrapRecoverySession(
  attempt: BootstrapRecoveryAttemptHandle,
): RecoverySession<BootstrapRecoveryCompletion, BootstrapRecoveryAttemptHandle> {
  return new RecoverySession(RECOVERY_SESSION_AUTHORITY, attempt, {}, async (commitCheck) => {
    const system = captureExactCurrentIdentityAuthority();
    return await finalizeBootstrapRecoveryControlled(attempt, {
      attemptIdentity: system.identity,
      probeSourceOwner: system.probeOwner,
      verifySystemAuthority: system.verifyCurrent,
      finalRenameCommitCheck: commitCheck,
    });
  });
}

export function createDelegatedRecoverySession(
  attempt: RecoveryAttemptHandle,
): RecoverySession<DelegatedRecoveryCompletion> {
  return new RecoverySession(RECOVERY_SESSION_AUTHORITY, attempt, {}, async (commitCheck) => {
    const system = captureExactCurrentIdentityAuthority();
    return await finalizeDelegatedRecoveryControlled(attempt, {
      attemptIdentity: system.identity,
      probeSourceOwner: system.probeOwner,
      verifySystemAuthority: system.verifyCurrent,
      finalRenameCommitCheck: commitCheck,
    });
  });
}

export function createPrestartRecoverySession(
  attempt: RecoveryAttemptHandle,
): RecoverySession<PrestartRecoveryCompletion> {
  return new RecoverySession(RECOVERY_SESSION_AUTHORITY, attempt, {}, async (commitCheck) => {
    const system = captureExactCurrentIdentityAuthority();
    return await finalizePrestartRecoveryControlled(attempt, {
      attemptIdentity: system.identity,
      helperBytes: readFixedPlatformHelperBundle(),
      probeSourceOwner: system.probeOwner,
      verifySystemAuthority: system.verifyCurrent,
      finalRenameCommitCheck: commitCheck,
    });
  });
}

export function createSameHostRebootRecoverySession(
  attempt: SameHostRebootRecoveryHandle,
): RecoverySession<SameHostRebootRecoveryCompletion, SameHostRebootRecoveryHandle> {
  return new RecoverySession(
    RECOVERY_SESSION_AUTHORITY,
    attempt,
    {},
    async (commitCheck) =>
      await finalizeSameHostRebootRecoveryControlled(attempt, {
        finalRenameCommitCheck: commitCheck,
      }),
  );
}

export function createMutationRecoverySession(
  attempt: RecoveryAttemptHandle,
): RecoverySession<MutationRecoveryCompletion> {
  return new RecoverySession(RECOVERY_SESSION_AUTHORITY, attempt, {}, async (commitCheck) => {
    const system = captureExactCurrentIdentityAuthority();
    return await resumeMutationRecoveryControlled(attempt, {
      attemptIdentity: system.identity,
      probeSourceOwner: system.probeOwner,
      verifySystemAuthority: system.verifyCurrent,
      finalRenameCommitCheck: commitCheck,
    });
  });
}

/** @internal Deterministic coordinator seam. */
export function createRecoverySessionControlled(
  attempt: RecoveryAttemptHandle,
  options: ControlledRecoverySessionOptions = {},
): RecoverySession<MechanicalEmptyRecoveryCompletion> {
  return new RecoverySession(RECOVERY_SESSION_AUTHORITY, attempt, options);
}

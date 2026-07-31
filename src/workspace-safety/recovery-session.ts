import {
  finalizeMechanicalEmptyRecoveryControlled,
  type ControlledFinalizeMechanicalEmptyRecoveryOptions,
  type MechanicalEmptyRecoveryCompletion,
} from './recovery-finalize.js';
import { captureExactCurrentIdentityAuthority } from './identity.js';
import type { RecoveryAttemptHandle } from './recovery-attempt.js';
import { WorkspaceSafetyError } from './types.js';

export type RecoverySessionState =
  'open' | 'finalizing' | 'committing' | 'preserved' | 'ready' | 'failed';

export type RecoveryInterruptReason = 'user-interrupt';

export type RecoveryInterruptResult =
  | {
      readonly status: 'preserved';
      readonly reason: RecoveryInterruptReason;
    }
  | {
      readonly status: 'ready';
      readonly reason: RecoveryInterruptReason;
      readonly completion: MechanicalEmptyRecoveryCompletion;
    };

export type ControlledRecoverySessionOptions = Omit<
  ControlledFinalizeMechanicalEmptyRecoveryOptions,
  | 'probeSourceOwner'
  | 'expectedRebootQuarantine'
  | 'verifySystemAuthority'
  | 'finalRenameCommitCheck'
>;

const RECOVERY_SESSION_AUTHORITY = Symbol('recovery-session-authority');

/**
 * Dark-only recovery coordinator. It is intentionally not connected to the CLI until the full
 * recovery activation PR can route signals and every recovery writer through this one owner.
 */
export class RecoverySession {
  #state: RecoverySessionState = 'open';
  #interruptReason: RecoveryInterruptReason | undefined;
  #interruptPromise: Promise<RecoveryInterruptResult> | undefined;
  #finalizePromise: Promise<MechanicalEmptyRecoveryCompletion> | undefined;
  #completion: MechanicalEmptyRecoveryCompletion | undefined;
  readonly #options: ControlledRecoverySessionOptions;

  constructor(
    token: typeof RECOVERY_SESSION_AUTHORITY,
    readonly attempt: RecoveryAttemptHandle,
    options: ControlledRecoverySessionOptions,
  ) {
    if (token !== RECOVERY_SESSION_AUTHORITY) {
      throw new WorkspaceSafetyError('invalid', 'recovery session authority token is invalid');
    }
    this.#options = options;
  }

  get state(): RecoverySessionState {
    return this.#state;
  }

  finalize(): Promise<MechanicalEmptyRecoveryCompletion> {
    if (this.#finalizePromise) return this.#finalizePromise;
    if (this.#state !== 'open') {
      return Promise.reject(
        new WorkspaceSafetyError('closed', 'recovery session 已停止，不能再次开始 finalization'),
      );
    }

    this.#state = 'finalizing';
    const system = captureExactCurrentIdentityAuthority();
    const running = finalizeMechanicalEmptyRecoveryControlled(this.attempt, {
      ...this.#options,
      probeSourceOwner: system.probeOwner,
      verifySystemAuthority: system.verifyCurrent,
      finalRenameCommitCheck: () => {
        if (this.#interruptReason) {
          this.#state = 'preserved';
          throw new WorkspaceSafetyError(
            'closed',
            'recovery finalization 在最终 rename 前收到用户中断',
          );
        }
        this.#state = 'committing';
      },
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
  ): Promise<RecoveryInterruptResult> {
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
      (completion): RecoveryInterruptResult => ({ status: 'ready', reason, completion }),
      (): RecoveryInterruptResult => ({ status: 'preserved', reason }),
    );
    return this.#interruptPromise;
  }
}

export function createRecoverySession(attempt: RecoveryAttemptHandle): RecoverySession {
  return new RecoverySession(RECOVERY_SESSION_AUTHORITY, attempt, {});
}

/** @internal Deterministic coordinator seam. */
export function createRecoverySessionControlled(
  attempt: RecoveryAttemptHandle,
  options: ControlledRecoverySessionOptions = {},
): RecoverySession {
  return new RecoverySession(RECOVERY_SESSION_AUTHORITY, attempt, options);
}

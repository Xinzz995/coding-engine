import { observeCurrentReviewRunnerVersion } from '../review/runner-version-observation.js';
import type { RunnerVersionObservation } from '../review/currentness.js';
import { readFinalReviewState } from '../review/state.js';
import { ReviewTemporaryDirectory } from '../review/temporary-directory.js';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession, type WorkspaceSession } from '../workspace-safety/session.js';
import { inspectWorkspaceSafetyStatus } from '../workspace-safety/status.js';

const TRANSIENT_SAFETY_PREFIX = 'coding-x-status-runner-';

type RunnerVersionObserver = typeof observeCurrentReviewRunnerVersion;

interface StatusRunnerVersionObservationAdapter {
  readonly observe: RunnerVersionObserver;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeTransientSession(
  temporary: ReviewTemporaryDirectory,
  session: WorkspaceSession | undefined,
  managedUseStarted: boolean,
): Promise<string | null> {
  const path = temporary.root;
  const retain = (reason: string): string => {
    const retained = temporary.retain(reason);
    return `临时安全域已保留 ${retained.path}：${retained.reason}`;
  };
  if (session !== undefined) {
    if (session.state === 'open') {
      try {
        await session.close();
      } catch (error) {
        return retain(`session 无法安全关闭：${errorMessage(error)}`);
      }
    }
    if (session.state !== 'closed') {
      return retain(`session 处于 ${session.state}`);
    }
  } else {
    let safety;
    try {
      safety = await inspectWorkspaceSafetyStatus(path);
    } catch (error) {
      return retain(`无法完成无写入者核验：${errorMessage(error)}`);
    }
    if (safety.status !== 'ready' && safety.status !== 'uninitialized') {
      return retain(`未证明无活动写入者（${safety.status}）`);
    }
  }

  if (managedUseStarted) {
    try {
      temporary.confirmManagedUseSettled();
    } catch (error) {
      const cleanup = temporary.cleanup();
      return cleanup.status === 'retained'
        ? `临时安全域身份核对失败，已保留 ${cleanup.path}：${errorMessage(error)}；${cleanup.reason}`
        : `临时安全域身份核对失败：${errorMessage(error)}`;
    }
  }

  try {
    const cleanup = temporary.cleanup();
    return cleanup.status === 'removed'
      ? null
      : `临时安全域清理失败，已保留 ${cleanup.path}：${cleanup.reason}`;
  } catch (error) {
    return `临时安全域清理失败，已保留 ${path}：${errorMessage(error)}`;
  }
}

/** @internal Deterministic observer seam; production always fixes the supervised observer. */
export async function observeStatusRunnerVersionControlled(
  options: { readonly workspace: string; readonly projectRoot: string },
  adapter: StatusRunnerVersionObservationAdapter,
): Promise<RunnerVersionObservation> {
  const review = readFinalReviewState(options.workspace);
  if (review.status !== 'ready') return { status: 'not-required' };
  const runner = review.state.binding.runner;
  let temporary: ReviewTemporaryDirectory | undefined;
  try {
    temporary = ReviewTemporaryDirectory.create({
      prefix: TRANSIENT_SAFETY_PREFIX,
      projectRoot: options.projectRoot,
    });
    temporary.sealSafeTree();
  } catch (error) {
    const cleanup = temporary?.cleanup();
    return {
      status: 'unverifiable',
      runner,
      message:
        `无法创建 Runner 版本观察的临时安全域：${errorMessage(error)}` +
        (cleanup === undefined
          ? ''
          : cleanup.status === 'retained'
            ? `；现场已保留 ${cleanup.path}：${cleanup.reason}`
            : '；初始化现场已安全清理'),
    };
  }
  const safetyPath = temporary.root;
  let session: WorkspaceSession | undefined;
  let managedUseStarted = false;
  let observation: RunnerVersionObservation;
  try {
    await bootstrapWorkspace({ workspacePath: safetyPath });
    const lease = await acquireWorkspaceLease({ workspacePath: safetyPath, command: 'report' });
    session = createWorkspaceSession(lease);
    temporary.prepareManagedUse();
    temporary.beginManagedUse();
    managedUseStarted = true;
    observation = await adapter.observe({
      workspace: options.workspace,
      projectRoot: options.projectRoot,
      session,
    });
  } catch (error) {
    observation = {
      status: 'unverifiable',
      runner,
      message: `Runner 版本观察未完成：${errorMessage(error)}`,
    };
  }

  const cleanupError = await closeTransientSession(temporary, session, managedUseStarted);
  if (cleanupError !== null) {
    const observationFailure =
      observation.status === 'unverifiable' ? `${observation.message}；` : '';
    return {
      status: 'unverifiable',
      runner,
      message: `${observationFailure}${cleanupError}`,
    };
  }
  return observation;
}

export async function observeStatusRunnerVersion(options: {
  readonly workspace: string;
  readonly projectRoot: string;
}): Promise<RunnerVersionObservation> {
  return await observeStatusRunnerVersionControlled(options, {
    observe: observeCurrentReviewRunnerVersion,
  });
}

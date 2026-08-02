import { observeCurrentReviewRunnerVersion } from '../review/runner-version-observation.js';
import type { RunnerVersionObservation } from '../review/currentness.js';
import { readFinalReviewState } from '../review/state.js';
import {
  describeReviewTemporaryRetention,
  ReviewTemporaryDirectory,
} from '../review/temporary-directory.js';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession, type WorkspaceSession } from '../workspace-safety/session.js';
import { inspectWorkspaceSafetyStatus } from '../workspace-safety/status.js';
import { type StoryValidationObservation } from '../review/story-validation-observation.js';
import {
  collectManagedStatusQuality,
  type ManagedStatusQualityResult,
} from '../review/managed-status.js';
import type { CurrentReviewStatus } from '../review/currentness.js';

const TRANSIENT_SAFETY_PREFIX = 'coding-x-status-runner-';

type RunnerVersionObserver = typeof observeCurrentReviewRunnerVersion;

interface StatusRunnerVersionObservationAdapter {
  readonly observe: RunnerVersionObserver;
}

interface TransientStatusObservation<T> {
  readonly observe: (session: WorkspaceSession) => Promise<T>;
}

type TransientStatusObservationResult<T> =
  { status: 'ready'; value: T } | { status: 'unverifiable'; message: string; value?: T };

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
    return `临时安全域${describeReviewTemporaryRetention(retained)}：${retained.reason}`;
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
      return cleanup.status !== 'removed'
        ? `临时安全域身份核对失败，现场${describeReviewTemporaryRetention(cleanup)}：${errorMessage(error)}；${cleanup.reason}`
        : `临时安全域身份核对失败：${errorMessage(error)}`;
    }
  }

  try {
    const cleanup = temporary.cleanup();
    return cleanup.status === 'removed'
      ? null
      : `临时安全域清理失败，现场${describeReviewTemporaryRetention(cleanup)}：${cleanup.reason}`;
  } catch (error) {
    return `临时安全域清理失败，保留位置无法验证（候选路径：${path}）：${errorMessage(error)}`;
  }
}

async function observeInTransientStatusSession<T>(
  options: { readonly projectRoot: string },
  adapter: TransientStatusObservation<T>,
): Promise<TransientStatusObservationResult<T>> {
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
      message:
        `无法创建状态观察的临时安全域：${errorMessage(error)}` +
        (cleanup === undefined
          ? ''
          : cleanup.status !== 'removed'
            ? `；现场${describeReviewTemporaryRetention(cleanup)}：${cleanup.reason}`
            : '；初始化现场已安全清理'),
    };
  }
  const safetyPath = temporary.root;
  let session: WorkspaceSession | undefined;
  let managedUseStarted = false;
  let observation: T | undefined;
  let observationError: string | null = null;
  try {
    await bootstrapWorkspace({ workspacePath: safetyPath });
    const lease = await acquireWorkspaceLease({ workspacePath: safetyPath, command: 'report' });
    session = createWorkspaceSession(lease);
    temporary.prepareManagedUse();
    temporary.beginManagedUse();
    managedUseStarted = true;
    observation = await adapter.observe(session);
  } catch (error) {
    observationError = `状态观察未完成：${errorMessage(error)}`;
  }

  const cleanupError = await closeTransientSession(temporary, session, managedUseStarted);
  if (cleanupError !== null) {
    return {
      status: 'unverifiable',
      message: `${observationError === null ? '' : `${observationError}；`}${cleanupError}`,
      ...(observation === undefined ? {} : { value: observation }),
    };
  }
  if (observationError !== null || observation === undefined) {
    return {
      status: 'unverifiable',
      message: observationError ?? '状态观察没有返回结果',
    };
  }
  return { status: 'ready', value: observation };
}

/** @internal Deterministic observer seam; production always fixes the supervised observer. */
export async function observeStatusRunnerVersionControlled(
  options: { readonly workspace: string; readonly projectRoot: string },
  adapter: StatusRunnerVersionObservationAdapter,
): Promise<RunnerVersionObservation> {
  const review = readFinalReviewState(options.workspace);
  if (review.status !== 'ready') return { status: 'not-required' };
  const runner = review.state.binding.runner;
  const observed = await observeInTransientStatusSession(options, {
    observe: async (session) =>
      await adapter.observe({
        workspace: options.workspace,
        projectRoot: options.projectRoot,
        session,
      }),
  });
  return observed.status === 'ready'
    ? observed.value
    : {
        status: 'unverifiable',
        runner,
        message:
          observed.value?.status === 'unverifiable'
            ? `${observed.value.message}；${observed.message}`
            : observed.message,
      };
}

export async function observeStatusRunnerVersion(options: {
  readonly workspace: string;
  readonly projectRoot: string;
}): Promise<RunnerVersionObservation> {
  return await observeStatusRunnerVersionControlled(options, {
    observe: observeCurrentReviewRunnerVersion,
  });
}

export interface StatusQualityObservation {
  storyValidation: StoryValidationObservation | null;
  runnerVersionObservation: RunnerVersionObservation;
  finalReview: CurrentReviewStatus;
  error: string | null;
}

interface StatusQualityObservationAdapter {
  readonly collect: (options: {
    session: WorkspaceSession;
    workspace: string;
    projectRoot: string;
    refreshRemote: boolean;
  }) => Promise<ManagedStatusQualityResult>;
}

/** @internal 共用一次临时安全域观察 Story 当前性与可选 Runner 版本。 */
export async function observeStatusQualityControlled(
  options: {
    readonly workspace: string;
    readonly projectRoot: string;
    readonly refreshRemote?: boolean;
  },
  adapter: StatusQualityObservationAdapter,
): Promise<StatusQualityObservation> {
  const observed = await observeInTransientStatusSession(options, {
    observe: async (session) =>
      await adapter.collect({
        session,
        workspace: options.workspace,
        projectRoot: options.projectRoot,
        refreshRemote: options.refreshRemote ?? false,
      }),
  });
  if (observed.status === 'ready') return { ...observed.value, error: null };
  const read = readFinalReviewState(options.workspace);
  return {
    storyValidation: null,
    runnerVersionObservation:
      read.status === 'ready'
        ? {
            status: 'unverifiable',
            runner: read.state.binding.runner,
            message: observed.message,
          }
        : { status: 'not-required' },
    finalReview: {
      read,
      current: false,
      staleReasons: read.status === 'ready' ? [observed.message] : [],
    },
    error: observed.message,
  };
}

export async function observeStatusQuality(options: {
  readonly workspace: string;
  readonly projectRoot: string;
  readonly refreshRemote?: boolean;
}): Promise<StatusQualityObservation> {
  return await observeStatusQualityControlled(options, {
    collect: collectManagedStatusQuality,
  });
}

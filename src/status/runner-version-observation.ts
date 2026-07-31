import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { observeCurrentReviewRunnerVersion } from '../review/runner-version-observation.js';
import type { RunnerVersionObservation } from '../review/currentness.js';
import { readFinalReviewState } from '../review/state.js';
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

function noSuchPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { readonly code?: unknown }).code) === 'ENOENT'
  );
}

async function removeOwnedTransientSafetyDirectory(path: string): Promise<void> {
  const canonicalParent = await realpath(tmpdir());
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if (noSuchPath(error)) return;
    throw error;
  }
  const name = basename(canonical);
  if (
    dirname(canonical) !== canonicalParent ||
    !name.startsWith(TRANSIENT_SAFETY_PREFIX) ||
    name.length === TRANSIENT_SAFETY_PREFIX.length
  ) {
    throw new Error(`拒绝清理非 status Runner 临时安全域：${canonical}`);
  }
  await rm(canonical, { recursive: true, force: false, maxRetries: 2, retryDelay: 10 });
}

async function closeTransientSession(
  path: string,
  session: WorkspaceSession | undefined,
): Promise<string | null> {
  if (session !== undefined) {
    if (session.state === 'open') {
      try {
        await session.close();
      } catch (error) {
        return `临时安全域无法安全关闭，已保留 ${path}：${errorMessage(error)}`;
      }
    }
    if (session.state !== 'closed') {
      return `临时安全域处于 ${session.state}，已保留 ${path}`;
    }
  } else {
    let safety;
    try {
      safety = await inspectWorkspaceSafetyStatus(path);
    } catch (error) {
      return `临时安全域无法完成无写入者核验，已保留 ${path}：${errorMessage(error)}`;
    }
    if (safety.status !== 'ready' && safety.status !== 'uninitialized') {
      return `临时安全域未证明无活动写入者，已保留 ${path}（${safety.status}）`;
    }
  }

  try {
    await removeOwnedTransientSafetyDirectory(path);
    return null;
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
  let safetyPath: string;
  try {
    safetyPath = await mkdtemp(join(tmpdir(), TRANSIENT_SAFETY_PREFIX));
  } catch (error) {
    return {
      status: 'unverifiable',
      runner,
      message: `无法创建 Runner 版本观察的临时安全域：${errorMessage(error)}`,
    };
  }
  let session: WorkspaceSession | undefined;
  let observation: RunnerVersionObservation;
  try {
    await bootstrapWorkspace({ workspacePath: safetyPath });
    const lease = await acquireWorkspaceLease({ workspacePath: safetyPath, command: 'report' });
    session = createWorkspaceSession(lease);
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

  const cleanupError = await closeTransientSession(safetyPath, session);
  if (cleanupError !== null) {
    return {
      status: 'unverifiable',
      runner,
      message: cleanupError,
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

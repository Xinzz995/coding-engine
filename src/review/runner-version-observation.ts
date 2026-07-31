import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import type { RunnerVersionObservation } from './currentness.js';
import { readRunnerVersion } from './runner.js';
import { readFinalReviewState } from './state.js';

function pathIsWithin(parent: string, candidate: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

/**
 * Observe the Runner version through the existing whole-process-tree supervisor.
 *
 * This module is intentionally managed-only: it depends on the Review state, currentness types,
 * Runner supervisor and workspace session, but never on the no-session status/preflight entrypoint.
 */
export async function observeCurrentReviewRunnerVersion(options: {
  workspace: string;
  projectRoot: string;
  session: WorkspaceSession;
  timeoutMs?: number;
  /** @internal Test seam; production always uses the supervised readRunnerVersion. */
  readVersion?: typeof readRunnerVersion;
}): Promise<RunnerVersionObservation> {
  const read = readFinalReviewState(options.workspace);
  if (read.status !== 'ready') return { status: 'not-required' };
  const runner = read.state.binding.runner;
  try {
    const projectRoot = realpathSync(resolve(options.projectRoot));
    const sourceWorkspace = realpathSync(resolve(options.workspace));
    const safetyWorkspace = realpathSync(resolve(options.session.writer.workspacePath));
    if (pathIsWithin(projectRoot, safetyWorkspace) || safetyWorkspace === sourceWorkspace) {
      return {
        status: 'unverifiable',
        runner,
        message: 'Runner 版本观察必须使用项目外的临时安全域',
      };
    }
    const version = await (options.readVersion ?? readRunnerVersion)({
      session: options.session,
      runner,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return { status: 'ready', runner, version };
  } catch (error) {
    return {
      status: 'unverifiable',
      runner,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

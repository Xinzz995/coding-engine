import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tryReadPrd, type StoryDifficulty } from '../engine/prd.js';
import {
  evaluateStoryValidationDisplay,
  readDisplayState,
  mergedStories,
  type StoryView,
  type StoryValidationDisplayCurrentness,
} from '../engine/state.js';
import { readGitHead } from '../engine/validation-protocol.js';
import { readProgress } from '../engine/progress.js';
import {
  readModelRouting,
  type ModelRouteSource,
  type ModelRoutingReadResult,
} from '../engine/models.js';
import type { AgentKind } from '../engine/agent.js';
import {
  inspectWorkspaceSafetyStatus,
  type WorkspaceSafetyStatusSnapshot,
} from '../workspace-safety/status.js';
import { readFinalReviewState, type ReviewStateRead } from '../review/state.js';
import { REVIEW_RULES_DIGEST } from '../review/rules.js';
import {
  readWorkingQualityContractAuthority,
  type StoryValidationObservation,
} from '../review/story-validation-observation.js';
import { REVIEW_RULES_VERSION } from '../review/types.js';

export type Phase =
  'idle' | 'developing' | 'gating' | 'validating' | 'done' | 'blocked' | 'shadow' | 'error';

export interface DashboardReviewCompletion {
  current: boolean;
  reason: string | null;
}

/**
 * Dashboard-only local completion check. It does not claim full remote Review currentness; it only
 * prevents a completed runtime from outliving its exact HEAD, Story receipt-set and rule binding.
 */
export function evaluateDashboardReviewCompletion(
  read: ReviewStateRead,
  currentGitHead: string | null,
  storyValidationDigest: string | null,
): DashboardReviewCompletion {
  if (read.status === 'missing') return { current: false, reason: '最终 Review 尚未完成' };
  if (read.status === 'invalid') {
    return { current: false, reason: `最终 Review 状态不可读取：${read.error}` };
  }
  if (!currentGitHead) return { current: false, reason: '当前 Git HEAD 不可读取' };
  if (!storyValidationDigest) {
    return { current: false, reason: '当前 Story 验收凭证集合无法验证' };
  }
  const review = read.state;
  if (review.binding.headSha !== currentGitHead) {
    return { current: false, reason: '最终 Review 对应的提交已变化' };
  }
  if (review.binding.storyValidationDigest !== storyValidationDigest) {
    return { current: false, reason: '最终 Review 对应的 Story 验收凭证集合已变化' };
  }
  if (
    review.binding.reviewRulesVersion !== REVIEW_RULES_VERSION ||
    review.binding.reviewRulesDigest !== REVIEW_RULES_DIGEST
  ) {
    return { current: false, reason: '最终 Review 使用的规则已变化' };
  }
  if (review.status !== 'passed' || review.deliveryStatus !== 'ready' || review.shadow) {
    return { current: false, reason: '本次运行的最终 Review 尚未完成' };
  }
  return { current: true, reason: null };
}

interface State {
  iteration: number;
  maxIterations: number;
  phase: Phase;
  currentStory: string | null;
  /** 当前阶段所用模型（未配置路由时为 null） */
  model: string | null;
  routeSource: ModelRouteSource | null;
  storyDifficulty: StoryDifficulty | null;
  runner: AgentKind | null;
  startedAt: number | null;
}

const state: State = {
  iteration: 0,
  maxIterations: 50,
  phase: 'idle',
  currentStory: null,
  model: null,
  routeSource: null,
  storyDifficulty: null,
  runner: null,
  startedAt: null,
};
let workspaceDir = '.workspace';
let projectRootDir = process.cwd();
let observeStoryValidation: (() => Promise<StoryValidationObservation>) | null = null;

export function configureWorkspace(
  workspace: string,
  maxIterations: number,
  projectRoot = process.cwd(),
  storyValidationObserver: (() => Promise<StoryValidationObservation>) | null = null,
): void {
  workspaceDir = workspace;
  projectRootDir = projectRoot;
  observeStoryValidation = storyValidationObserver;
  state.maxIterations = maxIterations;
  state.iteration = 0;
  state.phase = 'idle';
  state.currentStory = null;
  state.model = null;
  state.routeSource = null;
  state.storyDifficulty = null;
  state.runner = null;
  state.startedAt = Date.now();
}

export function setState(patch: {
  iteration?: number;
  phase?: Phase;
  currentStory?: string | null;
  model?: string | null;
  routeSource?: ModelRouteSource | null;
  storyDifficulty?: StoryDifficulty | null;
  runner?: AgentKind | null;
}): void {
  if (patch.iteration !== undefined) state.iteration = patch.iteration;
  if (patch.phase !== undefined) state.phase = patch.phase;
  if (patch.currentStory !== undefined) state.currentStory = patch.currentStory;
  if (patch.model !== undefined) state.model = patch.model;
  if (patch.routeSource !== undefined) state.routeSource = patch.routeSource;
  if (patch.storyDifficulty !== undefined) state.storyDifficulty = patch.storyDifficulty;
  if (patch.runner !== undefined) state.runner = patch.runner;
}

export interface ApiResponse {
  runtime: {
    iteration: number;
    max_iterations: number;
    phase: Phase;
    current_story: string | null;
    elapsed: number;
    model: string | null;
    route_source: ModelRouteSource | null;
    story_difficulty: StoryDifficulty | null;
    runner: AgentKind | null;
  };
  project: string;
  branchName: string;
  sourcePrd: string;
  stories: StoryView[];
  /** state.json 存在但损坏；stories 已按未验证状态 fail-closed。 */
  stateCorrupted: boolean;
  storyValidation: StoryValidationDisplayCurrentness;
  /** 仅核对本地完成结果与当前 HEAD/Story 凭证集合；完整远端当前性由 status/report 展示。 */
  reviewCompletion: DashboardReviewCompletion;
  modelRouting: ModelRoutingReadResult;
  logs: string;
  /** 只读安全观察；null 仅供尚未迁移的同步测试/调用方兼容。 */
  workspaceSafety: WorkspaceSafetyStatusSnapshot | null;
}

function buildApiResponseForWorkspace(
  workspace: string,
  workspaceSafety: WorkspaceSafetyStatusSnapshot | null,
  projectRoot: string,
  observed: StoryValidationObservation | null = null,
  observationError: string | null = null,
): ApiResponse {
  const elapsed = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  const prd = tryReadPrd(join(workspace, 'prd.json'));
  const displayState = prd ? readDisplayState(join(workspace, 'state.json'), prd) : null;
  const fallbackHead = readGitHead(projectRoot);
  const observationMatchesWorkspace =
    observed !== null && resolve(observed.workspacePath) === resolve(workspace);
  const observationMatchesPrd =
    observationMatchesWorkspace &&
    observed.prd !== null &&
    prd !== null &&
    isDeepStrictEqual(observed.prd, prd);
  const observationMatchesState =
    observationMatchesPrd &&
    observed.status === 'ready' &&
    displayState !== null &&
    isDeepStrictEqual(
      evaluateStoryValidationDisplay(
        prd,
        displayState.state,
        observed.headSha,
        observed.storyValidationEnvironmentDigest,
      ),
      observed.display,
    );
  const observationMatchesHead = observationMatchesState && observed.headSha === fallbackHead;
  const currentContract = observationMatchesHead
    ? readWorkingQualityContractAuthority(projectRoot)
    : null;
  const observationMatchesContract =
    observationMatchesHead &&
    currentContract?.status === 'ready' &&
    observed.workingContractDigest === currentContract.digest;
  const currentGitHead = fallbackHead;
  const failedStoryValidation =
    prd && displayState
      ? (() => {
          const failed = evaluateStoryValidationDisplay(
            prd,
            displayState.state,
            currentGitHead,
            null,
          );
          const message =
            observationError ??
            (observed === null
              ? 'Dashboard 未获得活跃受管 Story 当前性观察'
              : !observationMatchesWorkspace
                ? 'Story 当前性观察来自其他 workspace'
                : !observationMatchesPrd
                  ? 'Story 当前性观察后 prd.json 已变化'
                  : observed.status === 'unverifiable'
                    ? observed.message
                    : !observationMatchesState
                      ? 'Story 当前性观察后 state.json 已变化'
                      : !observationMatchesHead
                        ? 'Story 当前性观察后 Git HEAD 已变化'
                        : !observationMatchesContract
                          ? 'Story 当前性观察后工作树质量契约已变化或不可读取'
                          : 'Story 当前性观察无法绑定 Dashboard 状态');
          return {
            ...failed,
            currentness: {
              ...failed.currentness,
              current: false,
              configurationError: failed.currentness.configurationError ?? message,
            },
          };
        })()
      : null;
  const storyValidation =
    observationMatchesContract && observed.status === 'ready'
      ? observed.display
      : failedStoryValidation;
  const currentState = storyValidation?.state ?? null;
  const reviewCompletion = evaluateDashboardReviewCompletion(
    readFinalReviewState(workspace),
    currentGitHead,
    observationMatchesContract && observed.status === 'ready'
      ? observed.storyValidationDigest
      : null,
  );
  const logs = readProgress(join(workspace, 'progress.md'));
  return {
    runtime: {
      iteration: state.iteration,
      max_iterations: state.maxIterations,
      phase: state.phase,
      current_story: state.currentStory,
      elapsed,
      model: state.model,
      route_source: state.routeSource,
      story_difficulty: state.storyDifficulty,
      runner: state.runner,
    },
    project: prd?.project ?? '',
    branchName: prd?.branchName ?? '',
    sourcePrd: prd?.sourcePrd ?? '',
    stories: prd && currentState ? mergedStories(prd, currentState) : [],
    stateCorrupted: displayState?.stateCorrupted ?? false,
    storyValidation: storyValidation?.currentness ?? {
      gitHead: currentGitHead,
      current: false,
      invalidStoryIds: [],
      configurationError: 'prd.json 缺失或无法解析，Story 验收无法验证',
    },
    reviewCompletion,
    modelRouting: readModelRouting(prd),
    logs,
    workspaceSafety,
  };
}

/** Existing synchronous view remains byte-for-byte read-only and exposes no guessed safety state. */
export function buildApiResponse(): ApiResponse {
  return buildApiResponseForWorkspace(workspaceDir, null, projectRootDir);
}

/** Production dashboard view; captures one workspace path and reads its real safety state. */
export async function buildApiResponseWithWorkspaceSafety(): Promise<ApiResponse> {
  const workspace = workspaceDir;
  const projectRoot = projectRootDir;
  const workspaceSafety = await inspectWorkspaceSafetyStatus(workspace);
  let observed: StoryValidationObservation | null = null;
  let observationError: string | null = null;
  if (observeStoryValidation !== null) {
    try {
      observed = await observeStoryValidation();
    } catch (error) {
      observationError = error instanceof Error ? error.message : String(error);
    }
  }
  return buildApiResponseForWorkspace(
    workspace,
    workspaceSafety,
    projectRoot,
    observed,
    observationError,
  );
}

function defaultPublicDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'public');
}

export function start(opts: {
  workspace: string;
  maxIterations: number;
  projectRoot?: string;
  port?: number;
  publicDir?: string;
  storyValidationObserver?: () => Promise<StoryValidationObservation>;
}): { close(): void; address(): { port: number }; ready: Promise<{ port: number }> } {
  configureWorkspace(
    opts.workspace,
    opts.maxIterations,
    opts.projectRoot,
    opts.storyValidationObserver ?? null,
  );
  const publicDir = opts.publicDir ?? defaultPublicDir();
  const requestedPort = opts.port ?? 7331;

  const serveHtml = (res: import('node:http').ServerResponse, file: string) => {
    try {
      const html = readFileSync(join(publicDir, file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      console.error(`dashboard asset error: ${e instanceof Error ? e.message : String(e)}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/api/state') {
      void buildApiResponseWithWorkspaceSafety()
        .then((response) => {
          const body = JSON.stringify(response);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
        });
    } else if (path === '/' || path === '/index.html') {
      serveHtml(res, 'dashboard.html');
    } else if (path === '/p' || path === '/p.html') {
      serveHtml(res, 'dashboard-p.html');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const ready = new Promise<{ port: number }>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('dashboard server did not expose a TCP port'));
        return;
      }
      const bound = { port: address.port };
      const url = `http://localhost:${bound.port}`;
      console.log(`🖥️  Dashboard: ${url}`);
      resolve(bound);
    });
  });

  server.on('error', (err) => {
    console.error(`dashboard server error: ${err.message}`);
  });

  // Port 0 delegates ephemeral-port allocation to the OS. Choosing a random
  // number in user space races every other process on the runner.
  server.listen(requestedPort, '127.0.0.1');

  return {
    close: () => server.close(),
    address: () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('dashboard server is not listening');
      }
      return { port: address.port };
    },
    ready,
  };
}

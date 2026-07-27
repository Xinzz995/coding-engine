import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tryReadPrd, type StoryDifficulty } from '../engine/prd.js';
import { readDisplayState, mergedStories, type StoryView } from '../engine/state.js';
import { readProgress } from '../engine/progress.js';
import { readModelRouting, type ModelRouteSource, type ModelRoutingReadResult } from '../engine/models.js';
import type { AgentKind } from '../engine/agent.js';

export type Phase = 'idle' | 'developing' | 'gating' | 'validating' | 'done' | 'error';

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
  iteration: 0, maxIterations: 50, phase: 'idle', currentStory: null, model: null,
  routeSource: null, storyDifficulty: null, runner: null, startedAt: null,
};
let workspaceDir = '.workspace';

export function configureWorkspace(workspace: string, maxIterations: number): void {
  workspaceDir = workspace;
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
  iteration?: number; phase?: Phase; currentStory?: string | null; model?: string | null;
  routeSource?: ModelRouteSource | null; storyDifficulty?: StoryDifficulty | null;
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
    iteration: number; max_iterations: number; phase: Phase;
    current_story: string | null; elapsed: number; model: string | null;
    route_source: ModelRouteSource | null; story_difficulty: StoryDifficulty | null;
    runner: AgentKind | null;
  };
  project: string;
  branchName: string;
  sourcePrd: string;
  stories: StoryView[];
  /** state.json 存在但损坏；stories 已按未验证状态 fail-closed。 */
  stateCorrupted: boolean;
  modelRouting: ModelRoutingReadResult;
  logs: string;
}

export function buildApiResponse(): ApiResponse {
  const elapsed = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  const prd = tryReadPrd(join(workspaceDir, 'prd.json'));
  const displayState = prd ? readDisplayState(join(workspaceDir, 'state.json'), prd) : null;
  const logs = readProgress(join(workspaceDir, 'progress.md'));
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
    stories: prd && displayState ? mergedStories(prd, displayState.state) : [],
    stateCorrupted: displayState?.stateCorrupted ?? false,
    modelRouting: readModelRouting(prd),
    logs,
  };
}

function defaultPublicDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'public');
}

/**
 * Pure mapping from platform → the shell command that opens a URL in the user's
 * default browser. Exported so tests can assert behavior without spawning.
 */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

export function start(opts: {
  workspace: string;
  maxIterations: number;
  port?: number;
  publicDir?: string;
  openBrowser?: boolean;
}): { close(): void; address(): { port: number }; ready: Promise<{ port: number }> } {
  configureWorkspace(opts.workspace, opts.maxIterations);
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
      const body = JSON.stringify(buildApiResponse());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
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
      // Restore the original Python harness behavior: pop the dashboard open in the
      // user's default browser unless explicitly suppressed (opts.openBrowser === false).
      // The opener is best-effort — a missing `open`/`xdg-open` must never crash the harness.
      if (opts.openBrowser !== false) {
        try {
          const { cmd, args } = browserOpenCommand(process.platform, url);
          const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
          // spawn reports a missing binary (ENOENT — e.g. no `xdg-open` on a headless
          // box) as an asynchronous 'error' event, which the surrounding try/catch
          // does NOT catch. With no 'error' listener Node throws an uncaught
          // exception and crashes the harness — so swallow it here.
          child.on('error', () => {
            /* opener missing or failed — non-fatal */
          });
          child.unref();
        } catch {
          // swallow — browser launch failures are non-fatal
        }
      }
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

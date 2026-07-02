import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tryReadPrd } from '../engine/prd.js';
import { readProgress } from '../engine/progress.js';

export type Phase = 'idle' | 'developing' | 'validating' | 'done' | 'error';

interface State {
  iteration: number;
  maxIterations: number;
  phase: Phase;
  currentStory: string | null;
  startedAt: number | null;
}

const state: State = {
  iteration: 0, maxIterations: 50, phase: 'idle', currentStory: null, startedAt: null,
};
let workspaceDir = '.workspace';

export function configureWorkspace(workspace: string, maxIterations: number): void {
  workspaceDir = workspace;
  state.maxIterations = maxIterations;
  state.startedAt = Date.now();
}

export function setState(patch: {
  iteration?: number; phase?: Phase; currentStory?: string | null;
}): void {
  if (patch.iteration !== undefined) state.iteration = patch.iteration;
  if (patch.phase !== undefined) state.phase = patch.phase;
  if (patch.currentStory !== undefined) state.currentStory = patch.currentStory;
}

export interface ApiResponse {
  runtime: {
    iteration: number; max_iterations: number; phase: Phase;
    current_story: string | null; elapsed: number;
  };
  project: string;
  branchName: string;
  sourcePrd: string;
  stories: unknown[];
  logs: string;
}

export function buildApiResponse(): ApiResponse {
  const elapsed = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  const prd = tryReadPrd(join(workspaceDir, 'prd.json'));
  const logs = readProgress(join(workspaceDir, 'progress.md'));
  return {
    runtime: {
      iteration: state.iteration,
      max_iterations: state.maxIterations,
      phase: state.phase,
      current_story: state.currentStory,
      elapsed,
    },
    project: prd?.project ?? '',
    branchName: prd?.branchName ?? '',
    sourcePrd: prd?.sourcePrd ?? '',
    stories: prd?.userStories ?? [],
    logs,
  };
}

function defaultPublicDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'public');
}

// Node binds the listening socket asynchronously: server.address() is null until
// the 'listening' event fires on the next tick. Tests read address().port
// synchronously right after start() returns, so we resolve the actual port up
// front. For an explicit port we use it directly; for port 0 (ephemeral) we draw
// a random port from the IANA ephemeral range ourselves to keep address()
// synchronous (the OS would otherwise assign one only after listen completes).
function ephemeralPort(): number {
  const base = 49152;
  const span = 65535 - base + 1;
  const r = (Math.floor(Math.random() * span) + (process.pid & 0x7fff)) % span;
  return base + r;
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
}): { close(): void; address(): { port: number } } {
  configureWorkspace(opts.workspace, opts.maxIterations);
  const publicDir = opts.publicDir ?? defaultPublicDir();
  const requestedPort = opts.port ?? 7331;
  const port = requestedPort === 0 ? ephemeralPort() : requestedPort;

  const serveHtml = (res: import('node:http').ServerResponse, file: string) => {
    try {
      const html = readFileSync(join(publicDir, file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
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

  server.on('error', (err) => {
    console.error(`dashboard server error: ${(err as Error).message}`);
  });

  server.listen(port, '127.0.0.1');

  const url = `http://localhost:${port}`;
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
      child.on('error', () => { /* opener missing or failed — non-fatal */ });
      child.unref();
    } catch {
      // swallow — browser launch failures are non-fatal
    }
  }

  return {
    close: () => server.close(),
    address: () => ({ port }),
  };
}

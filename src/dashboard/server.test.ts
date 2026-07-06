import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setState, buildApiResponse, start, configureWorkspace, browserOpenCommand } from './server.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({
    project: '任务应用', branchName: 'ralph/x', description: 'd',
    sourcePrd: 'docs/prds/prd-x.md',
    userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
  }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
  }));
  writeFileSync(join(dir, 'progress.md'), '## US-001\n- done');
  return dir;
}

describe('buildApiResponse', () => {
  it('reflects state + workspace files', () => {
    const ws = tempWorkspace();
    configureWorkspace(ws, 50);
    setState({ iteration: 3, phase: 'validating', currentStory: 'US-001' });
    const r = buildApiResponse();
    expect(r.runtime.iteration).toBe(3);
    expect(r.runtime.phase).toBe('validating');
    expect(r.project).toBe('任务应用');
    expect(r.branchName).toBe('ralph/x');
    expect(r.sourcePrd).toBe('docs/prds/prd-x.md');
    expect(r.stories.length).toBe(1);
    expect(r.stories[0].passes).toBe(true); // 状态来自 state.json
    expect(r.logs).toContain('US-001');
  });

  it('falls back to legacy in-story state when state.json is absent (v0.4 workspace)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-legacy-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'prd.json'), JSON.stringify({
      project: 'p', branchName: 'ralph/x', description: 'd',
      userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [],
        priority: 1, passes: true, notes: '', retryCount: 0, blocked: false }],
    }));
    writeFileSync(join(dir, 'progress.md'), '');
    configureWorkspace(dir, 50);
    const r = buildApiResponse();
    expect(r.stories[0].passes).toBe(true);
  });

  it('exposes the current model in runtime and defaults it to null', () => {
    setState({ phase: 'developing', model: 'opus' });
    expect(buildApiResponse().runtime.model).toBe('opus');
    setState({ model: null });
    expect(buildApiResponse().runtime.model).toBe(null);
  });
});

describe('browserOpenCommand', () => {
  it('darwin → open', () => {
    expect(browserOpenCommand('darwin', 'http://x')).toEqual({ cmd: 'open', args: ['http://x'] });
  });
  it('win32 → cmd /c start "" url', () => {
    expect(browserOpenCommand('win32', 'http://x')).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', 'http://x'] });
  });
  it('linux → xdg-open', () => {
    expect(browserOpenCommand('linux', 'http://x')).toEqual({ cmd: 'xdg-open', args: ['http://x'] });
  });
});

describe('start', () => {
  it('serves /api/state as JSON', async () => {
    const ws = tempWorkspace();
    const pub = mkdtempSync(join(tmpdir(), 'pub-'));
    cleanup.push(() => rmSync(pub, { recursive: true, force: true }));
    mkdirSync(pub, { recursive: true });
    writeFileSync(join(pub, 'dashboard.html'), '<html>main</html>');
    writeFileSync(join(pub, 'dashboard-p.html'), '<html>pixel</html>');

    const srv = start({ workspace: ws, maxIterations: 50, port: 0, publicDir: pub, openBrowser: false });
    cleanup.push(() => srv.close());
    const addr = srv.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/state`);
    const body = await res.json();
    expect(body.runtime.max_iterations).toBe(50);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

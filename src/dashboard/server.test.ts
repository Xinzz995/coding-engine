import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setState, buildApiResponse, start, configureWorkspace } from './server.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({
    project: '任务应用', branchName: 'ralph/x', description: 'd',
    userStories: [{ id: 'US-001', passes: false }],
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
    expect(r.stories.length).toBe(1);
    expect(r.logs).toContain('US-001');
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

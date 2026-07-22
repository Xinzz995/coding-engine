import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
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

type DashboardStory = {
  id: string;
  passes: boolean;
  validated: boolean;
  notes: string;
  retryCount: number;
  blocked: boolean;
};

const dashboardAssets = [
  { label: '普通页', file: 'dashboard.html', stateFunction: 'getState', currentStoryArgument: true },
  { label: '像素页', file: 'dashboard-p.html', stateFunction: 'getStoryState', currentStoryArgument: false },
] as const;

function readDashboardAsset(file: string): string {
  return readFileSync(join(process.cwd(), 'assets', 'dashboard', file), 'utf-8');
}

function extractStateFunction(html: string, name: string): string {
  const source = html.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
  expect(source, `${name} should remain an inline dashboard function`).not.toBeNull();
  return source![0];
}

function dashboardState(
  asset: (typeof dashboardAssets)[number],
  story: DashboardStory,
  currentStory: string | null = null,
): string {
  const source = extractStateFunction(readDashboardAsset(asset.file), asset.stateFunction);
  const invocation = asset.currentStoryArgument
    ? `(${source})(story, currentStory)`
    : `(${source})(story)`;
  return runInNewContext(invocation, {
    story,
    currentStory,
    getRuntime: () => ({ current_story: currentStory }),
  }) as string;
}

describe.each(dashboardAssets)('$label dashboard published-state contract', (asset) => {
  const story = (over: Partial<DashboardStory> = {}): DashboardStory => ({
    id: 'US-001', passes: false, validated: false, notes: '', retryCount: 0, blocked: false, ...over,
  });

  it('按 active/blocked/passed/awaiting/failed/pending 状态矩阵分类', () => {
    expect(dashboardState(asset, story(), 'US-001')).toBe('active');
    expect(dashboardState(asset, story({ blocked: true }))).toBe('blocked');
    expect(dashboardState(asset, story({ passes: true, validated: true }))).toBe('passed');
    expect(dashboardState(asset, story({ passes: true, validated: false }))).toBe('awaiting');
    expect(dashboardState(asset, story({ retryCount: 1 }))).toBe('failed');
    expect(dashboardState(asset, story())).toBe('pending');
  });

  it('将待验收标记为「待引擎验收」，且完成计数必须同时要求 passes 与 validated', () => {
    const html = readDashboardAsset(asset.file);
    expect(html).toMatch(/awaiting\s*:\s*(?:\{[^}]*label\s*:\s*)?['"]待引擎验收['"]/);
    expect(html).toMatch(
      /stories\.filter\(s\s*=>\s*!s\.blocked\s*&&\s*s\.passes\s*===\s*true\s*&&\s*s\.validated\s*===\s*true\)\.length/,
    );
  });
});

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
    expect(r.stories[0].validated).toBe(true); // 旧 passed state 兼容为已验收
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
    expect(r.stories[0].validated).toBe(true);
  });

  it('exposes the current actual route in runtime and defaults it to null', () => {
    setState({
      phase: 'developing', model: 'opus', routeSource: 'difficulty',
      storyDifficulty: 'high', runner: 'claude',
    });
    expect(buildApiResponse().runtime.model).toBe('opus');
    expect(buildApiResponse().runtime.route_source).toBe('difficulty');
    expect(buildApiResponse().runtime.story_difficulty).toBe('high');
    expect(buildApiResponse().runtime.runner).toBe('claude');
    setState({ model: null, routeSource: null, storyDifficulty: null });
    expect(buildApiResponse().runtime.model).toBe(null);
  });

  it('exposes the complete configured routing separately from the actual route', () => {
    const ws = tempWorkspace();
    const path = join(ws, 'prd.json');
    const prd = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    prd.models = {
      runner: 'codex', builder: { low: 'lo', medium: 'mid', high: 'hi' },
      validator: 'val', escalation: 'esc',
    };
    (prd.userStories as Array<Record<string, unknown>>)[0].difficulty = 'medium';
    (prd.userStories as Array<Record<string, unknown>>)[0].difficultyReason = '命中 medium-1';
    writeFileSync(path, JSON.stringify(prd));
    configureWorkspace(ws, 50);
    expect(buildApiResponse().modelRouting).toMatchObject({
      status: 'enabled', config: { runner: 'codex', validator: 'val', escalation: 'esc' },
    });
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

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCliArgs, permissionWarning, runDashboard } from './cli.js';

describe('parseCliArgs', () => {
  it('defaults to claude run with standard timeouts', () => {
    const c = parseCliArgs([]);
    expect(c.command).toBe('run');
    expect(c.kind).toBe('claude');
    expect(c.maxIterations).toBe(50);
    expect(c.devTimeoutMs).toBe(30 * 60 * 1000);
    expect(c.valTimeoutMs).toBe(60 * 60 * 1000);
    expect(c.openBrowser).toBe(true);
  });
  it('parses codex positional and flag overrides', () => {
    const c = parseCliArgs(['codex', '--max-iter', '3', '--dev-timeout', '10', '--no-open']);
    expect(c.kind).toBe('codex');
    expect(c.maxIterations).toBe(3);
    expect(c.devTimeoutMs).toBe(10 * 60 * 1000);
    expect(c.openBrowser).toBe(false);
  });
  it('recognizes the repair subcommand', () => {
    expect(parseCliArgs(['repair']).command).toBe('repair');
  });
  it('recognizes the dashboard subcommand', () => {
    expect(parseCliArgs(['dashboard']).command).toBe('dashboard');
  });
  it('defaults keepOpen to false and port to 7331', () => {
    const c = parseCliArgs([]);
    expect(c.keepOpen).toBe(false);
    expect(c.port).toBe(7331);
  });
  it('parses --keep-open and --port overrides', () => {
    const c = parseCliArgs(['--keep-open', '--port', '8080']);
    expect(c.keepOpen).toBe(true);
    expect(c.port).toBe(8080);
  });
});

describe('runDashboard', () => {
  it('serves workspace state standalone until interrupt, then closes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dash-ws-'));
    writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
      project: 'offline-view', branchName: 'ralph/x', description: 'd',
      userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [],
        priority: 1, passes: true, notes: '', retryCount: 0, blocked: false }],
    }));
    const port = 20100 + (process.pid % 1000);
    let release!: () => void;
    const interrupt = new Promise<void>((r) => { release = r; });
    try {
      const running = runDashboard({ workspace, port, openBrowser: false }, interrupt);
      // Must not resolve on its own — it serves until interrupted.
      const pending = await Promise.race([
        running.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('pending'), 300)),
      ]);
      expect(pending).toBe('pending');
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(res.status).toBe(200);
      const body = await res.json() as { project: string; stories: unknown[] };
      expect(body.project).toBe('offline-view');
      expect(body.stories).toHaveLength(1);
      release();
      expect(await running).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('permissionWarning', () => {
  it('mentions skip-permissions for claude', () => {
    expect(permissionWarning('claude')).toMatch(/--dangerously-skip-permissions/);
  });
  it('mentions bypass-approvals for codex', () => {
    expect(permissionWarning('codex')).toMatch(/--dangerously-bypass-approvals-and-sandbox/);
  });
});

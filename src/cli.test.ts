import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCliArgs, permissionWarning, runDashboard, main } from './cli.js';

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
  it('recognizes the doctor subcommand', () => {
    expect(parseCliArgs(['doctor']).command).toBe('doctor');
  });
  it('recognizes the status subcommand with default workspace', () => {
    const c = parseCliArgs(['status']);
    expect(c.command).toBe('status');
    expect(c.workspace).toBe('.workspace');
  });
  it('passes --workspace through to the status subcommand', () => {
    expect(parseCliArgs(['status', '--workspace', 'ws-x']).workspace).toBe('ws-x');
  });
  it('parses --json for status and defaults to false', () => {
    expect(parseCliArgs(['status', '--json']).json).toBe(true);
    expect(parseCliArgs(['status']).json).toBe(false);
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
  it('defaults staleDays to 30', () => {
    expect(parseCliArgs(['doctor']).staleDays).toBe(30);
  });
  it('parses --stale-days overrides, including zero', () => {
    expect(parseCliArgs(['doctor', '--stale-days', '7']).staleDays).toBe(7);
    expect(parseCliArgs(['doctor', '--stale-days', '0']).staleDays).toBe(0);
  });
  it('throws a clear error instead of silently coercing an invalid --stale-days to NaN', () => {
    expect(() => parseCliArgs(['doctor', '--stale-days', 'abc'])).toThrow('--stale-days');
    expect(() => parseCliArgs(['doctor', '--stale-days', '-1'])).toThrow('--stale-days');
    expect(() => parseCliArgs(['doctor', '--stale-days', '1.5'])).toThrow('--stale-days');
  });
  it('rejects non-decimal literals that Number() would silently coerce', () => {
    expect(() => parseCliArgs(['doctor', '--stale-days', ''])).toThrow('--stale-days'); // Number('') === 0
    expect(() => parseCliArgs(['doctor', '--stale-days', '0x10'])).toThrow('--stale-days'); // === 16
    expect(() => parseCliArgs(['doctor', '--stale-days', '1e2'])).toThrow('--stale-days'); // === 100
  });
});

describe('main — invalid --stale-days', () => {
  it('reports the error and exits 1 without printing a doctor report', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['doctor', '--stale-days', 'abc']);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--stale-days'));
      expect(logSpy).not.toHaveBeenCalled(); // 未执行 doctor 检查，没有打印报告
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('main — status subcommand', () => {
  it('prints the workspace overview and returns 1 while stories are unfinished', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'status-cli-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
        project: 'cli-proj', branchName: 'ralph/s', description: 'd',
        userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
      }));
      writeFileSync(join(workspace, 'state.json'), JSON.stringify({
        'US-001': { passes: false, notes: '', retryCount: 0, blocked: false },
      }));
      const code = await main(['status', '--workspace', workspace]);
      expect(code).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('cli-proj'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0/1'));
    } finally {
      logSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('returns 2 and suggests prd-to-json when the workspace is missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['status', '--workspace', join(tmpdir(), 'status-cli-none')]);
      expect(code).toBe(2);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('prd-to-json'));
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('main — status --json', () => {
  const writePrd = (workspace: string) => {
    writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
      project: 'cli-proj', branchName: 'ralph/s', description: 'd', sourcePrd: 'docs/prds/s.md',
      userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
    }));
  };

  it('prints exactly one JSON.parse-able object to stdout with the same exit semantics', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'status-json-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writePrd(workspace);
      writeFileSync(join(workspace, 'state.json'), JSON.stringify({
        'US-001': { passes: false, notes: '', retryCount: 0, blocked: false },
      }));
      const code = await main(['status', '--workspace', workspace, '--json']);
      expect(code).toBe(1);
      expect(logSpy).toHaveBeenCalledTimes(1); // stdout 无装饰性文本混入
      const obj = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(obj.project).toBe('cli-proj');
      expect(obj.sourcePrd).toBe('docs/prds/s.md');
      expect(obj.summary).toEqual({ total: 1, passed: 0, blocked: 0 });
    } finally {
      logSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('warns on stderr (suggesting repair) for corrupt state.json without polluting stdout', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'status-json-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writePrd(workspace);
      writeFileSync(join(workspace, 'state.json'), '{ not json');
      const code = await main(['status', '--workspace', workspace, '--json']);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('npx coding-x repair'));
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(logSpy.mock.calls[0][0] as string)).not.toThrow();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('warns on stderr for corrupt state.json in human-readable mode too, but not when state.json is merely absent', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'status-json-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writePrd(workspace);
      await main(['status', '--workspace', workspace]); // state.json 缺失：静默回退
      expect(errSpy).not.toHaveBeenCalled();
      writeFileSync(join(workspace, 'state.json'), '{ not json');
      await main(['status', '--workspace', workspace]);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('npx coding-x repair'));
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('emits parseable error JSON and exits 2 when the workspace is missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['status', '--workspace', join(tmpdir(), 'status-json-none'), '--json']);
      expect(code).toBe(2);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logSpy.mock.calls[0][0] as string).error).toBe('missing');
    } finally {
      logSpy.mockRestore();
    }
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

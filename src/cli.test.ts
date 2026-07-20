import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseCliArgs, permissionWarning, runDashboard, isDirectInvocation, main } from './cli.js';

afterEach(() => {
  delete process.env.CODING_X_CODEX_BIN;
  delete process.env.CODING_X_CLAUDE_BIN;
  delete process.env.CODING_X_CURSOR_BIN;
  delete process.env.CODING_X_FAKE_DISCOVERY_MODE;
});

describe('isDirectInvocation', () => {
  it('symlink/路径别名形态的 argv[1] 解析到真实模块（npm bin shim 与 macOS /tmp 别名）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-entry-'));
    const real = join(dir, 'real-cli.mjs');
    writeFileSync(real, '// stub');
    const link = join(dir, 'shim-link.mjs');
    symlinkSync(real, link);
    // ESM loader 的 import.meta.url 是 realpath URL；argv[1] 则可能是 shim/别名路径
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    expect(isDirectInvocation(link, moduleUrl)).toBe(true);
    expect(isDirectInvocation(real, moduleUrl)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it('非本模块、不存在的路径、缺失 argv[1] 一律判非直接执行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-entry-'));
    const real = join(dir, 'real-cli.mjs');
    writeFileSync(real, '// stub');
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    const other = join(dir, 'other.mjs');
    writeFileSync(other, '// other');
    expect(isDirectInvocation(other, moduleUrl)).toBe(false);
    expect(isDirectInvocation(join(dir, 'missing.mjs'), moduleUrl)).toBe(false);
    expect(isDirectInvocation(undefined, moduleUrl)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('parseCliArgs', () => {
  it('defaults to claude run with standard timeouts', () => {
    const c = parseCliArgs([]);
    expect(c.command).toBe('run');
    expect(c.kind).toBe('claude');
    expect(c.kindExplicit).toBe(false);
    expect(c.maxIterations).toBe(50);
    expect(c.devTimeoutMs).toBe(30 * 60 * 1000);
    expect(c.valTimeoutMs).toBe(60 * 60 * 1000);
    expect(c.openBrowser).toBe(true);
  });
  it('parses codex positional and flag overrides', () => {
    const c = parseCliArgs(['codex', '--max-iter', '3', '--dev-timeout', '10', '--no-open']);
    expect(c.kind).toBe('codex');
    expect(c.kindExplicit).toBe(true);
    expect(c.maxIterations).toBe(3);
    expect(c.devTimeoutMs).toBe(10 * 60 * 1000);
    expect(c.openBrowser).toBe(false);
  });
  it('parses cursor positional as an explicit runner', () => {
    const c = parseCliArgs(['cursor']);
    expect(c.kind).toBe('cursor');
    expect(c.kindExplicit).toBe(true);
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
  it('recognizes the report subcommand with default workspace', () => {
    const c = parseCliArgs(['report']);
    expect(c.command).toBe('report');
    expect(c.workspace).toBe('.workspace');
  });
  it('recognizes models with an optional explicit runner', () => {
    const auto = parseCliArgs(['models', '--json']);
    expect(auto.command).toBe('models');
    expect(auto.kindExplicit).toBe(false);
    expect(parseCliArgs(['models', 'cursor']).kind).toBe('cursor');
    expect(parseCliArgs(['models', 'cursor']).kindExplicit).toBe(true);
    expect(() => parseCliArgs(['models', 'unknown'])).toThrow('models runner');
  });
  it('passes --workspace through to the report subcommand', () => {
    expect(parseCliArgs(['report', '--workspace', 'ws-x']).workspace).toBe('ws-x');
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
  it('parses all three model overrides', () => {
    const c = parseCliArgs(['--builder-model', 'haiku', '--validator-model', 'opus', '--escalation-model', 'max']);
    expect(c.builderModel).toBe('haiku');
    expect(c.validatorModel).toBe('opus');
    expect(c.escalationModel).toBe('max');
  });
  it('defaults all model overrides to undefined', () => {
    const c = parseCliArgs([]);
    expect(c.builderModel).toBeUndefined();
    expect(c.validatorModel).toBeUndefined();
    expect(c.escalationModel).toBeUndefined();
  });
  it('defaults stallLimit to 3', () => {
    expect(parseCliArgs([]).stallLimit).toBe(3);
    expect(parseCliArgs(['codex']).stallLimit).toBe(3);
  });
  it('parses --stall-limit overrides', () => {
    expect(parseCliArgs(['--stall-limit', '5']).stallLimit).toBe(5);
    expect(parseCliArgs(['--stall-limit', '1']).stallLimit).toBe(1);
  });
  it('throws a clear error instead of silently accepting a non-positive-integer --stall-limit', () => {
    expect(() => parseCliArgs(['--stall-limit', '0'])).toThrow('--stall-limit');
    expect(() => parseCliArgs(['--stall-limit', 'abc'])).toThrow('--stall-limit');
    expect(() => parseCliArgs(['--stall-limit', '-1'])).toThrow('--stall-limit');
    expect(() => parseCliArgs(['--stall-limit', '1.5'])).toThrow('--stall-limit');
  });
  it('does not validate --stall-limit outside the run command', () => {
    expect(() => parseCliArgs(['doctor', '--stall-limit', 'abc'])).not.toThrow();
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
  it('mentions force for cursor', () => {
    expect(permissionWarning('cursor')).toMatch(/--force/);
  });
});

describe('main — models subcommand', () => {
  const fixture = join(process.cwd(), 'src/engine/__fixtures__/fake-codex-app-server.mjs');
  const fakeCommand = `${process.execPath} ${fixture}`;

  it('available：Codex --json 输出单个可解析对象与完整分页模型', async () => {
    process.env.CODING_X_CODEX_BIN = fakeCommand;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['models', 'codex', '--json'])).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const result = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(result).toMatchObject({ status: 'available', runner: 'codex' });
      expect(result.models.map((m: { id: string }) => m.id)).toEqual(['model-a', 'model-b']);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('unsupported：已认证 Claude 诚实降级且退出 0', async () => {
    process.env.CODING_X_CLAUDE_BIN = fakeCommand;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['models', 'claude', '--json'])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
        status: 'unsupported', runner: 'claude',
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('error：认证失败输出机器可读错误并退出 1', async () => {
    process.env.CODING_X_CURSOR_BIN = fakeCommand;
    process.env.CODING_X_FAKE_DISCOVERY_MODE = 'auth-error';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['models', 'cursor', '--json'])).toBe(1);
      const result = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(result).toMatchObject({ status: 'error', runner: 'cursor' });
      expect(result.error).toContain('未认证');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('未显式指定 runner 时从现有 models.runner 推断', async () => {
    process.env.CODING_X_CODEX_BIN = fakeCommand;
    const workspace = mkdtempSync(join(tmpdir(), 'models-cli-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd',
        models: {
          runner: 'codex', builder: { low: 'model-a', medium: 'model-a', high: 'model-b' },
          validator: 'model-b', escalation: 'model-b',
        },
        userStories: [{
          id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1,
          difficulty: 'low', difficultyReason: '命中 low-1',
        }],
      }));
      expect(await main(['models', '--workspace', workspace, '--json'])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls[0][0] as string).runner).toBe('codex');
    } finally {
      logSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('main — report subcommand', () => {
  it('writes report.html and returns 0 on a valid workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      writeFileSync(join(dir, 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd',
        userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
      }));
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
      try {
        expect(await main(['report', '--workspace', dir])).toBe(0);
      } finally { console.log = orig; }
      expect(logs.some((l) => l.includes('report.html'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns 2 when the workspace is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      const errs: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
      try {
        expect(await main(['report', '--workspace', dir])).toBe(2);
      } finally { console.error = orig; }
      expect(errs.some((e) => e.includes('prd-to-json'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns 1 when writing report.html fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      writeFileSync(join(dir, 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd',
        userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
      }));
      mkdirSync(join(dir, 'report.html')); // 同名目录占位 → writeFileSync 抛 EISDIR
      const orig = console.error;
      console.error = () => {};
      try {
        expect(await main(['report', '--workspace', dir])).toBe(1);
      } finally { console.error = orig; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('repair 与工作区锁', () => {
  const validPrd = JSON.stringify({
    project: 'p', branchName: 'ralph/x', description: 'd',
    userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
  });

  it('refuses to repair while an alive lock exists (exit 2, files untouched)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-repair-lock-'));
    const brokenRaw = '{"project":"p","branchName":"b","description":"d","userStories":[],}'; // 尾逗号：可修复的坏 JSON
    writeFileSync(join(dir, 'prd.json'), brokenRaw);
    writeFileSync(join(dir, 'engine.lock'), JSON.stringify({
      pid: process.pid, startedAt: '2026-07-16T00:00:00.000Z', command: 'run',
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await main(['repair', '--workspace', dir]);
      expect(code).toBe(2);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('已被另一个 coding-x 进程锁定'));
      expect(readFileSync(join(dir, 'prd.json'), 'utf-8')).toBe(brokenRaw); // 未动文件
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquires and releases the lock across a successful repair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-repair-ok-'));
    writeFileSync(join(dir, 'prd.json'), validPrd);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['repair', '--workspace', dir]);
      expect(code).toBe(0);
      expect(existsSync(join(dir, 'engine.lock'))).toBe(false); // 修完锁已释放
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

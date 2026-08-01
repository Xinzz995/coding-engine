import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  CLI_HELP,
  parseCliArgs,
  permissionWarning,
  runDashboard,
  isDirectInvocation,
  main,
} from './cli.js';
import * as dashboard from './dashboard/server.js';
import { readGitHead } from './engine/validation-protocol.js';
import { renderManagedGitHubFiles } from './quality/github-workflows.js';
import { parseQualityContract, readQualityContract } from './quality/contract.js';
import { CODING_X_VERSION } from './version.js';
import { bootstrapWorkspace } from './workspace-safety/bootstrap.js';
import { digestBytes } from './workspace-safety/filesystem.js';
import { applyPrdV1CandidateDigest } from './workspace-safety/product-mutations.js';

afterEach(() => {
  delete process.env.CODING_X_CODEX_BIN;
  delete process.env.CODING_X_CLAUDE_BIN;
  delete process.env.CODING_X_CURSOR_BIN;
  delete process.env.CODING_X_CONFIG;
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
    expect(c.shadow).toBe(false);
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
  it('parses --shadow as an explicit non-delivery run mode', () => {
    expect(parseCliArgs(['codex', '--shadow']).shadow).toBe(true);
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
  it('recognizes the fixed workspace command family and strictly scopes --input', () => {
    expect(parseCliArgs(['workspace', 'init']).workspaceAction).toBe('init');
    expect(parseCliArgs(['workspace', 'recover']).workspaceAction).toBe('recover');
    expect(parseCliArgs(['workspace', 'resume-mutation']).workspaceAction).toBe('resume-mutation');
    expect(parseCliArgs(['workspace', 'apply-prd', '--input', '/tmp/request.json'])).toMatchObject({
      command: 'workspace',
      workspaceAction: 'apply-prd',
      inputFile: '/tmp/request.json',
    });
    expect(
      parseCliArgs([
        '--workspace',
        'ws-x',
        'workspace',
        'record-review-decision',
        '--input',
        '/tmp/decision.json',
      ]),
    ).toMatchObject({
      workspaceAction: 'record-review-decision',
      workspace: 'ws-x',
    });
    expect(() => parseCliArgs(['workspace', 'apply-prd'])).toThrow('--input');
    expect(() => parseCliArgs(['workspace', 'recover', '--input', 'x'])).toThrow('--input');
    expect(() => parseCliArgs(['workspace', 'unknown'])).toThrow('workspace 子命令');
    expect(() =>
      parseCliArgs(['workspace', 'init', '--workspace', 'a', '--workspace', 'b']),
    ).toThrow('--workspace 只能指定一次');
  });
  it('recognizes init-only contract and confirmation options', () => {
    const c = parseCliArgs(['init', '--contract', 'quality.json', '--yes', '--json']);
    expect(c.command).toBe('init');
    expect(c.contractFile).toBe('quality.json');
    expect(c.yes).toBe(true);
    expect(c.json).toBe(true);
    expect(() => parseCliArgs(['init', 'extra'])).toThrow('额外位置参数');
    expect(() => parseCliArgs(['doctor', '--contract', 'quality.json'])).toThrow('--contract');
    expect(() => parseCliArgs(['status', '--yes'])).toThrow('--yes');
  });
  it('limits --local to doctor', () => {
    expect(parseCliArgs(['doctor', '--local']).local).toBe(true);
    expect(parseCliArgs(['doctor']).local).toBe(false);
    expect(() => parseCliArgs(['status', '--local'])).toThrow('--local');
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
    expect(() => parseCliArgs(['models', 'codex', 'extra'])).toThrow('额外位置参数');
  });
  it('recognizes global config subcommands and rejects invalid actions', () => {
    expect(parseCliArgs(['config', 'path']).configAction).toBe('path');
    expect(parseCliArgs(['config', 'init']).configAction).toBe('init');
    expect(parseCliArgs(['config', 'validate']).configAction).toBe('validate');
    expect(() => parseCliArgs(['config'])).toThrow('config 子命令');
    expect(() => parseCliArgs(['config', 'unknown'])).toThrow('config 子命令');
    expect(() => parseCliArgs(['config', 'path', 'extra'])).toThrow('额外位置参数');
  });
  it('recognizes Cursor hook management and rejects incomplete forms', () => {
    expect(parseCliArgs(['hooks', 'cursor', 'install']).hooksAction).toBe('install');
    expect(parseCliArgs(['hooks', 'cursor', 'status']).hooksAction).toBe('status');
    expect(parseCliArgs(['hooks', 'cursor', 'remove']).hooksAction).toBe('remove');
    expect(() => parseCliArgs(['hooks'])).toThrow('hooks 子命令');
    expect(() => parseCliArgs(['hooks', 'claude', 'install'])).toThrow('hooks 子命令');
    expect(() => parseCliArgs(['hooks', 'cursor', 'unknown'])).toThrow('hooks 子命令');
    expect(() => parseCliArgs(['hooks', 'cursor', 'install', 'extra'])).toThrow('额外位置参数');
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
  it.each([
    ['0', 0],
    ['65535', 65535],
  ])('accepts decimal port boundary %s', (raw, expected) => {
    expect(parseCliArgs(['dashboard', '--port', raw]).port).toBe(expected);
  });
  it.each(['', '-1', '1.5', '1e2', '0x10', 'not-a-port'])(
    'rejects invalid port literal %j',
    (raw) => {
      expect(() => parseCliArgs(['dashboard', '--port', raw])).toThrow(
        `--port 必须是 0 到 65535（含边界）的十进制整数，收到「${raw}」`,
      );
    },
  );
  it.each(['65536', '999999'])('rejects out-of-range port %s', (raw) => {
    expect(() => parseCliArgs(['dashboard', '--port', raw])).toThrow(
      `--port 必须是 0 到 65535（含边界）的十进制整数，收到「${raw}」`,
    );
  });
  it('rejects --port without a value with the same clear range error', () => {
    expect(() => parseCliArgs(['dashboard', '--port'])).toThrow(
      '--port 必须是 0 到 65535（含边界）的十进制整数，收到「」',
    );
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
    const c = parseCliArgs([
      '--builder-model',
      'haiku',
      '--validator-model',
      'opus',
      '--escalation-model',
      'max',
    ]);
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

  it('recognizes --help, -h and help before subcommand-specific validation', () => {
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['help']).help).toBe(true);
    expect(parseCliArgs(['config', '--help']).help).toBe(true);
    expect(parseCliArgs(['models', 'unknown', '--help']).help).toBe(true);
  });
});

describe('main — help', () => {
  it('说明端口的严格格式，并完整列出 status 的退出码', () => {
    expect(CLI_HELP).toContain('仅接受 0–65535 的十进制整数；0 由系统选择可用端口');
    expect(CLI_HELP).toContain('status 退出码:');
    for (const meaning of [
      '0                              实现验证、本地 Review 与 GitHub 交付条件均已就绪',
      '1                              Story 未完成、state 损坏或 PRD 没有 Story',
      '2                              workspace 安全状态未就绪/不可读，或最终 Review 状态损坏',
      '3                              存在 blocked Story',
      '4                              最终 Review 有待人工处理的 finding',
      '5                              最终 Review 无法可靠验证',
      '6                              最终 Review 未完成或已失效，或 GitHub CI / Ruleset 未就绪',
      '7                              Shadow 已完成，但不能表示可交付',
    ]) {
      expect(CLI_HELP).toContain(meaning);
    }
  });

  it.each([['--help'], ['-h'], ['help'], ['config', '--help']])(
    '%s prints help to stdout and exits 0',
    async (...args) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await main(args)).toBe(0);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toEqual(expect.stringContaining('用法'));
        expect(errSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    },
  );

  it('lists every command, runner and option in one canonical help view', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['--help'])).toBe(0);
      const output = String(logSpy.mock.calls[0][0]);
      for (const token of [
        'claude',
        'codex',
        'cursor',
        'init',
        'repair',
        'dashboard',
        'doctor',
        'status',
        'report',
        'models',
        'config',
        'hooks cursor',
        '--max-iter',
        '--dev-timeout',
        '--val-timeout',
        '--builder-model',
        '--validator-model',
        '--review-model',
        '--escalation-model',
        '--workspace',
        '--no-open',
        '--keep-open',
        '--port',
        '--stall-limit',
        '--stale-days',
        '--json',
        '--shadow',
        '--contract',
        '--yes',
        '--local',
        '--help',
        '-h',
      ]) {
        expect(output, `help 缺少 ${token}`).toContain(token);
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not create workspace/config files or start a runner for help', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-help-'));
    const workspace = join(dir, 'workspace-that-must-not-exist');
    const configPath = join(dir, 'config-that-must-not-exist.json');
    process.env.CODING_X_CONFIG = configPath;
    process.env.CODING_X_CLAUDE_BIN = join(dir, 'missing-runner');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['--help', '--workspace', workspace])).toBe(0);
      expect(existsSync(workspace)).toBe(false);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['dashboard', '--port', 'abc', '--help'],
    ['dashboard', '--port', '1e2', '-h'],
    ['dashboard', '--port', '--help'],
    ['help', '--port', '0x10'],
    ['dashboard', '--port', 'abc', 'help'],
    ['dashboard', 'help', '--port', '0x10'],
    ['dashboard', '--port', 'help'],
  ])('prioritizes help over invalid --port for %j', async (...args) => {
    const dashboardStart = vi.spyOn(dashboard, 'start');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(args)).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('用法'));
      expect(errSpy).not.toHaveBeenCalled();
      expect(dashboardStart).not.toHaveBeenCalled();
    } finally {
      dashboardStart.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('main — invalid --port', () => {
  it.each([
    { label: 'empty', args: ['dashboard', '--port', ''], raw: '' },
    { label: 'missing', args: ['dashboard', '--port'], raw: '' },
    { label: 'negative', args: ['dashboard', '--port', '-1'], raw: '-1' },
    { label: 'decimal', args: ['dashboard', '--port', '1.5'], raw: '1.5' },
    { label: 'scientific', args: ['dashboard', '--port', '1e2'], raw: '1e2' },
    { label: 'hexadecimal', args: ['dashboard', '--port', '0x10'], raw: '0x10' },
    { label: 'non-numeric', args: ['dashboard', '--port', 'abc'], raw: 'abc' },
    { label: 'above range', args: ['dashboard', '--port', '65536'], raw: '65536' },
  ])('rejects $label input before dashboard or browser startup', async ({ args, raw }) => {
    const dashboardStart = vi.spyOn(dashboard, 'start');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(args)).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`收到「${raw}」`));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('0 到 65535'));
      expect(logSpy).not.toHaveBeenCalled();
      expect(dashboardStart).not.toHaveBeenCalled();
    } finally {
      dashboardStart.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
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

describe('main — doctor JSON', () => {
  it('prints one parseable object including the quality contract digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-doctor-'));
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), '.coding-x', 'quality.json'), 'utf8'),
    ) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('repository quality contract fixture must be an object');
    }
    const source = { ...raw, codingXVersion: CODING_X_VERSION };
    const parsed = parseQualityContract(source);
    if (parsed.status !== 'ready') throw new Error(`invalid doctor fixture: ${parsed.status}`);
    mkdirSync(join(root, '.coding-x'), { recursive: true });
    writeFileSync(join(root, '.coding-x', 'quality.json'), JSON.stringify(source));
    for (const [relativePath, content] of Object.entries(
      renderManagedGitHubFiles(parsed.contract),
    )) {
      mkdirSync(join(root, relativePath, '..'), { recursive: true });
      writeFileSync(join(root, relativePath), content);
    }
    await bootstrapWorkspace({ workspacePath: join(root, '.workspace') });
    process.env.CODING_X_CONFIG = join(root, 'missing-model-config.json');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // 单元测试不依赖 CI 机器的 gh 登录；远端回读由 delivery 适配器测试
      // 和真实 doctor 实证覆盖。
      expect(await main(['doctor', '--local', '--json'])).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
        schemaVersion: 1,
        quality: {
          status: 'ready',
          digest: expect.stringMatching(/^sha256:/),
        },
      });
    } finally {
      logSpy.mockRestore();
      cwdSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('main — status subcommand', () => {
  it('prints the workspace overview and returns 1 while stories are unfinished', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'status-cli-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await bootstrapWorkspace({ workspacePath: workspace });
      writeFileSync(
        join(workspace, 'prd.json'),
        JSON.stringify({
          project: 'cli-proj',
          branchName: 'ralph/s',
          description: 'd',
          userStories: [
            { id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 },
          ],
        }),
      );
      writeFileSync(
        join(workspace, 'state.json'),
        JSON.stringify({
          'US-001': { passes: false, notes: '', retryCount: 0, blocked: false },
        }),
      );
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
    writeFileSync(
      join(workspace, 'prd.json'),
      JSON.stringify({
        project: 'cli-proj',
        branchName: 'ralph/s',
        description: 'd',
        sourcePrd: 'docs/prds/s.md',
        userStories: [
          { id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 },
        ],
      }),
    );
  };

  it('prints exactly one JSON.parse-able object to stdout with the same exit semantics', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'status-json-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await bootstrapWorkspace({ workspacePath: workspace });
      writePrd(workspace);
      writeFileSync(
        join(workspace, 'state.json'),
        JSON.stringify({
          'US-001': { passes: false, notes: '', retryCount: 0, blocked: false },
        }),
      );
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
      await bootstrapWorkspace({ workspacePath: workspace });
      writePrd(workspace);
      writeFileSync(join(workspace, 'state.json'), '{ not json');
      const code = await main(['status', '--workspace', workspace, '--json']);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('npx coding-x repair'));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('按未验证状态'));
      expect(logSpy).toHaveBeenCalledTimes(1);
      const view = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(view.stateCorrupted).toBe(true);
      expect(view.summary).toEqual({ total: 1, passed: 0, blocked: 0 });
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
      await bootstrapWorkspace({ workspacePath: workspace });
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
      const code = await main([
        'status',
        '--workspace',
        join(tmpdir(), 'status-json-none'),
        '--json',
      ]);
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
    writeFileSync(
      join(workspace, 'prd.json'),
      JSON.stringify({
        project: 'offline-view',
        branchName: 'ralph/x',
        description: 'd',
        userStories: [
          {
            id: 'US-001',
            title: 't',
            description: 'd',
            acceptanceCriteria: [],
            priority: 1,
            passes: true,
            notes: '',
            retryCount: 0,
            blocked: false,
          },
        ],
      }),
    );
    const port = 20100 + (process.pid % 1000);
    let release!: () => void;
    const interrupt = new Promise<void>((r) => {
      release = r;
    });
    const opened: string[] = [];
    try {
      const running = runDashboard({ workspace, port, openBrowser: true }, interrupt, (url) =>
        opened.push(url),
      );
      // Must not resolve on its own — it serves until interrupted.
      const pending = await Promise.race([
        running.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('pending'), 300)),
      ]);
      expect(pending).toBe('pending');
      expect(opened).toEqual([`http://localhost:${port}`]);
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { project: string; stories: unknown[] };
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
  it.each(['claude', 'codex', 'cursor'] as const)(
    '%s 只读全局目录输出单个可解析对象，不拉起任何 runner CLI',
    async (runner) => {
      const dir = mkdtempSync(join(tmpdir(), 'models-cli-'));
      const configPath = join(dir, 'config.json');
      process.env.CODING_X_CONFIG = configPath;
      process.env.CODING_X_CLAUDE_BIN = join(dir, 'definitely-missing-claude');
      process.env.CODING_X_CODEX_BIN = join(dir, 'definitely-missing-codex');
      process.env.CODING_X_CURSOR_BIN = join(dir, 'definitely-missing-cursor');
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          models: { [runner]: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b' }] },
        }),
      );
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await main(['models', runner, '--json'])).toBe(0);
        expect(logSpy).toHaveBeenCalledTimes(1);
        const result = JSON.parse(logSpy.mock.calls[0][0] as string);
        expect(result).toMatchObject({ status: 'available', runner, source: 'global-config' });
        expect(result.models.map((m: { id: string }) => m.id)).toEqual(['model-a', 'model-b']);
      } finally {
        logSpy.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('配置缺失输出机器可读 error 并退出 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'models-cli-'));
    process.env.CODING_X_CONFIG = join(dir, 'missing.json');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['models', 'claude', '--json'])).toBe(1);
      const result = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(result).toMatchObject({ status: 'error', runner: 'claude' });
      expect(result.error).toContain('未找到全局模型配置');
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runner 未配置模型时输出 error，不接受人工临时绕过目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'models-cli-'));
    const configPath = join(dir, 'config.json');
    process.env.CODING_X_CONFIG = configPath;
    writeFileSync(configPath, JSON.stringify({ version: 1, models: { codex: [{ id: 'm' }] } }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['models', 'cursor', '--json'])).toBe(1);
      const result = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(result).toMatchObject({ status: 'error', runner: 'cursor' });
      expect(result.error).toContain('未配置任何模型');
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未显式指定 runner 时从现有 models.runner 推断', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'models-cli-'));
    const configPath = join(workspace, 'global-config.json');
    process.env.CODING_X_CONFIG = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        models: { codex: [{ id: 'model-a' }, { id: 'model-b' }] },
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(
        join(workspace, 'prd.json'),
        JSON.stringify({
          project: 'p',
          branchName: 'b',
          description: 'd',
          models: {
            runner: 'codex',
            builder: { low: 'model-a', medium: 'model-a', high: 'model-b' },
            validator: 'model-b',
            escalation: 'model-b',
          },
          userStories: [
            {
              id: 'US-001',
              title: 't',
              description: 'd',
              acceptanceCriteria: [],
              priority: 1,
              difficulty: 'low',
              difficultyReason: '命中 low-1',
            },
          ],
        }),
      );
      expect(await main(['models', '--workspace', workspace, '--json'])).toBe(0);
      expect(JSON.parse(logSpy.mock.calls[0][0] as string).runner).toBe('codex');
    } finally {
      logSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('未显式指定 runner 时不绕过非法 prd.json 猜测目录', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'models-cli-'));
    const configPath = join(workspace, 'global-config.json');
    process.env.CODING_X_CONFIG = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        models: { claude: [{ id: 'model-a' }] },
      }),
    );
    writeFileSync(
      join(workspace, 'prd.json'),
      JSON.stringify({
        project: 'p',
        branchName: 'b',
        description: 'd',
        models: { runner: 'unknown' },
        userStories: [],
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['models', '--workspace', workspace, '--json'])).toBe(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const result = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(result.configPath).toBe(configPath);
      expect(result.error).toContain('无法从现有 prd.json 推断 runner');
    } finally {
      logSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('未显式指定 runner 时不把损坏的 prd.json 当作文件缺失', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'models-cli-'));
    const configPath = join(workspace, 'missing-global-config.json');
    process.env.CODING_X_CONFIG = configPath;
    writeFileSync(join(workspace, 'prd.json'), '{ broken');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['models', '--workspace', workspace, '--json'])).toBe(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const result = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(result.configPath).toBe(configPath);
      expect(result.error).toContain('prd.json');
      expect(result.error).toContain('无法解析');
      expect(result.error).not.toContain('未找到全局模型配置');
    } finally {
      logSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each(['1', 'false', '"text"', '[]'])(
    '未显式指定 runner 时拒绝合法 JSON 的错误根形状：%s',
    async (rawPrd) => {
      const workspace = mkdtempSync(join(tmpdir(), 'models-cli-'));
      const configPath = join(workspace, 'global-config.json');
      process.env.CODING_X_CONFIG = configPath;
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          models: { claude: [{ id: 'model-a' }] },
        }),
      );
      writeFileSync(join(workspace, 'prd.json'), rawPrd);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await main(['models', '--workspace', workspace, '--json'])).toBe(1);
        expect(logSpy).toHaveBeenCalledTimes(1);
        const result = JSON.parse(logSpy.mock.calls[0][0] as string);
        expect(result.configPath).toBe(configPath);
        expect(result.error).toContain('无法从现有 prd.json 推断 runner');
        expect(result.error).toContain('无法解析');
      } finally {
        logSpy.mockRestore();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );
});

describe('main — config subcommand', () => {
  it('path 输出解析后的全局配置路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-cli-'));
    const path = join(dir, 'config.json');
    process.env.CODING_X_CONFIG = path;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['config', 'path'])).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(path);
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init 创建空模板且第二次拒绝覆盖', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-cli-'));
    const path = join(dir, 'nested', 'config.json');
    process.env.CODING_X_CONFIG = path;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['config', 'init'])).toBe(0);
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ version: 1, models: {} });
      const initialBytes = readFileSync(path, 'utf-8');
      expect(await main(['config', 'init'])).toBe(1);
      expect(readFileSync(path, 'utf-8')).toBe(initialBytes);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('不会覆盖'));
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validate 区分有效配置与非法 JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-cli-'));
    const path = join(dir, 'config.json');
    process.env.CODING_X_CONFIG = path;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(path, JSON.stringify({ version: 1, models: { claude: [{ id: 'sonnet' }] } }));
      expect(await main(['config', 'validate'])).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('claude=1'));
      writeFileSync(path, '{ invalid');
      expect(await main(['config', 'validate'])).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('不是合法 JSON'));
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validate 对缺失配置返回明确错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-cli-'));
    process.env.CODING_X_CONFIG = join(dir, 'missing.json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['config', 'validate'])).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('未找到全局模型配置'));
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('main — report subcommand', () => {
  it('writes report.html and returns 0 on a valid workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      await bootstrapWorkspace({ workspacePath: dir });
      writeFileSync(
        join(dir, 'prd.json'),
        JSON.stringify({
          project: 'p',
          branchName: 'b',
          description: 'd',
          userStories: [
            { id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 },
          ],
        }),
      );
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => {
        logs.push(a.join(' '));
      };
      try {
        expect(await main(['report', '--workspace', dir])).toBe(0);
      } finally {
        console.log = orig;
      }
      expect(logs.some((l) => l.includes('report.html'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 2 when the workspace is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      await bootstrapWorkspace({ workspacePath: dir });
      const errs: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => {
        errs.push(a.join(' '));
      };
      try {
        expect(await main(['report', '--workspace', dir])).toBe(2);
      } finally {
        console.error = orig;
      }
      expect(errs.some((e) => e.includes('prd-to-json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 1 when writing report.html fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      await bootstrapWorkspace({ workspacePath: dir });
      writeFileSync(
        join(dir, 'prd.json'),
        JSON.stringify({
          project: 'p',
          branchName: 'b',
          description: 'd',
          userStories: [
            { id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 },
          ],
        }),
      );
      mkdirSync(join(dir, 'report.html')); // 同名目录占位 → writeFileSync 抛 EISDIR
      const orig = console.error;
      console.error = () => {};
      try {
        expect(await main(['report', '--workspace', dir])).toBe(1);
      } finally {
        console.error = orig;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('state.json 损坏时写出保守诊断报告但返回 1，绝不假绿', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      await bootstrapWorkspace({ workspacePath: dir });
      writeFileSync(
        join(dir, 'prd.json'),
        JSON.stringify({
          project: 'p',
          branchName: 'b',
          description: 'd',
          userStories: [
            {
              id: 'US-001',
              title: 't',
              description: 'd',
              acceptanceCriteria: [],
              priority: 1,
              passes: true,
              notes: '',
              retryCount: 0,
              blocked: false,
            },
          ],
        }),
      );
      writeFileSync(join(dir, 'state.json'), '{ broken');
      const logs: string[] = [];
      const errs: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
        logs.push(a.join(' '));
      });
      const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
        errs.push(a.join(' '));
      });
      try {
        expect(await main(['report', '--workspace', dir])).toBe(1);
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
      expect(logs.some((l) => l.includes('report.html'))).toBe(true);
      expect(errs.some((e) => e.includes('state.json 已损坏'))).toBe(true);
      const html = readFileSync(join(dir, 'report.html'), 'utf-8');
      expect(html).toContain('状态不可验证');
      expect(html).not.toContain('全部通过');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('main — workspace commands', () => {
  it('initializes only an empty workspace and treats an already-ready workspace as idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-workspace-init-'));
    const workspace = join(root, 'ws');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['workspace', 'init', '--workspace', workspace])).toBe(0);
      expect(existsSync(join(workspace, 'workspace-safety.json'))).toBe(true);
      expect(existsSync(join(workspace, 'engine.lock', 'protocol.json'))).toBe(true);
      expect(existsSync(join(workspace, 'engine.lock', 'lease'))).toBe(false);
      expect(await main(['workspace', 'init', '--workspace', workspace])).toBe(0);
      expect(existsSync(join(workspace, 'engine.lock', 'lease'))).toBe(false);
    } finally {
      logSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies a fixed PRD request and releases the short lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-workspace-apply-'));
    const workspace = join(root, 'ws');
    const input = join(root, 'request.json');
    const quality = readQualityContract(process.cwd());
    if (quality.status !== 'ready')
      throw new Error(`quality fixture unavailable: ${quality.status}`);
    const head = readGitHead(process.cwd());
    if (head === null) throw new Error('Git HEAD fixture unavailable');
    const qualityDigest = quality.digest;
    const source = '# accepted spec\n';
    const candidate = {
      prd: JSON.stringify({
        project: 'fixture',
        branchName: 'feature/fixture',
        description: 'fixture',
        qualityContractDigest: qualityDigest,
        qualityChecks: quality.contract.checks,
        userStories: [],
      }),
      state: null,
      progress: '# Progress\n',
    };
    await bootstrapWorkspace({ workspacePath: workspace });
    writeFileSync(
      input,
      JSON.stringify({
        schemaVersion: 1,
        mode: 'replace-feature',
        source: { bytes: source, digest: digestBytes(Buffer.from(source)) },
        git: { expectedHead: head, currentHead: head },
        quality: { expectedDigest: qualityDigest, currentDigest: qualityDigest },
        candidate: {
          ...candidate,
          digest: applyPrdV1CandidateDigest('replace-feature', candidate),
        },
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await main(['workspace', 'apply-prd', '--workspace', workspace, '--input', input]),
      ).toBe(0);
      expect(JSON.parse(readFileSync(join(workspace, 'prd.json'), 'utf8'))).toMatchObject({
        branchName: 'feature/fixture',
      });
      expect(readFileSync(join(workspace, 'progress.md'), 'utf8')).toBe('# Progress\n');
      expect(existsSync(join(workspace, 'engine.lock', 'lease'))).toBe(false);
    } finally {
      logSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects request files inside the workspace before acquiring a lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-workspace-input-'));
    const workspace = join(root, 'ws');
    await bootstrapWorkspace({ workspacePath: workspace });
    const input = join(workspace, 'request.json');
    writeFileSync(input, '{}');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await main(['workspace', 'apply-prd', '--workspace', workspace, '--input', input]),
      ).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('workspace 之外'));
      expect(existsSync(join(workspace, 'engine.lock', 'lease'))).toBe(false);
      expect(readFileSync(input, 'utf8')).toBe('{}');
    } finally {
      errorSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the originating interrupt code without changing a ready workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-workspace-recover-interrupt-'));
    const workspace = join(root, 'ws');
    await bootstrapWorkspace({ workspacePath: workspace });
    const markerBefore = readFileSync(join(workspace, 'workspace-safety.json'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recovering = main(['workspace', 'recover', '--workspace', workspace]);
      process.emit('SIGINT');

      expect(await recovering).toBe(130);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('已按安全边界停止'));
      expect(readFileSync(join(workspace, 'workspace-safety.json'))).toEqual(markerBefore);
      expect(existsSync(join(workspace, 'engine.lock', 'lease'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repair 与工作区锁', () => {
  const validPrd = JSON.stringify({
    project: 'p',
    branchName: 'ralph/x',
    description: 'd',
    userStories: [
      { id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 },
    ],
  });

  it('refuses to treat a legacy pid-only lock as a safe workspace (exit 2, files untouched)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-repair-lock-'));
    const brokenRaw = '{"project":"p","branchName":"b","description":"d","userStories":[],}'; // 尾逗号：可修复的坏 JSON
    const legacyLockRaw = JSON.stringify({
      pid: process.pid,
      startedAt: '2026-07-16T00:00:00.000Z',
      command: 'run',
    });
    writeFileSync(join(dir, 'prd.json'), brokenRaw);
    writeFileSync(join(dir, 'engine.lock'), legacyLockRaw);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await main(['repair', '--workspace', dir]);
      expect(code).toBe(2);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('永久协议根'));
      expect(readFileSync(join(dir, 'prd.json'), 'utf-8')).toBe(brokenRaw); // 未动文件
      expect(readFileSync(join(dir, 'engine.lock'), 'utf-8')).toBe(legacyLockRaw);
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquires and releases the lock across a successful repair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-repair-ok-'));
    await bootstrapWorkspace({ workspacePath: dir });
    writeFileSync(join(dir, 'prd.json'), validPrd);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['repair', '--workspace', dir]);
      expect(code).toBe(0);
      expect(existsSync(join(dir, 'engine.lock'))).toBe(true); // 永久协议根保留
      expect(existsSync(join(dir, 'engine.lock', 'lease'))).toBe(false); // 当前 lease 已释放
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

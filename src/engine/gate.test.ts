import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readQualityChecks,
  applyGateFailure,
  runQualityChecks,
  MAX_RETRIES,
  applyAbortRollback,
  ABORT_LINE_PREFIX,
  applyValidatorFailure,
  applyValidatorSuccess,
  classifyValidationOnlyGateFailure,
  runContractQualityChecks,
  abortDesc,
} from './gate.js';
import type { GateFailure } from './gate.js';
import type { RunState } from './state.js';
import type { Prd } from './prd.js';
import type {
  FrozenQualityChecks,
  QualityContract,
  QualityCheckPolicy,
} from '../quality/contract.js';
import { createManagedProcessTestSession } from './managed-process-test-support.js';

async function runManagedQualityChecks(
  checks: string[],
  cwd: string,
  timeoutMs?: number,
): ReturnType<typeof runQualityChecks> {
  const fixture = await createManagedProcessTestSession();
  try {
    return await runQualityChecks(checks, cwd, timeoutMs, {
      session: fixture.session,
      kind: 'quality-check',
    });
  } finally {
    await fixture.close();
  }
}

async function runManagedContractQualityChecks(
  checks: FrozenQualityChecks,
  projectRoot: string,
  platform?: 'linux' | 'macos' | 'windows' | null,
): ReturnType<typeof runContractQualityChecks> {
  const fixture = await createManagedProcessTestSession();
  try {
    return await runContractQualityChecks(checks, projectRoot, platform, {
      session: fixture.session,
      kind: 'quality-check',
    });
  } finally {
    await fixture.close();
  }
}

function contractWith(
  test: QualityCheckPolicy,
  rest: Partial<QualityContract['checks']> = {},
): FrozenQualityChecks {
  return {
    test,
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
    ...rest,
  };
}

const prdWith = (qualityChecks?: unknown): Prd => ({
  project: 'p',
  branchName: 'b',
  description: 'd',
  userStories: [],
  ...(qualityChecks === undefined ? {} : { qualityChecks: qualityChecks as string[] }),
});

const failure = (over: Partial<GateFailure> = {}): GateFailure => ({
  command: 'npm test',
  exitCode: 1,
  timedOut: false,
  outputTail: '2 failed',
  ...over,
});

const validationReceipt = {
  schemaVersion: 1 as const,
  requestId: 'validator-request-1',
  gitHead: 'a'.repeat(40),
  acceptanceHash: `sha256:${'b'.repeat(64)}`,
};

describe('readQualityChecks', () => {
  it('returns null when prd is null or field missing', () => {
    expect(readQualityChecks(null)).toBeNull();
    expect(readQualityChecks(prdWith())).toBeNull();
  });

  it('returns null for an empty array (gate disabled, silent)', () => {
    expect(readQualityChecks(prdWith([]))).toBeNull();
  });

  it('returns the commands for a valid string array', () => {
    expect(readQualityChecks(prdWith(['npm run typecheck', 'npm test']))).toEqual([
      'npm run typecheck',
      'npm test',
    ]);
  });

  it('returns "invalid" for non-array or non-string members', () => {
    expect(readQualityChecks(prdWith('npm test'))).toBe('invalid');
    expect(readQualityChecks(prdWith([1]))).toBe('invalid');
    expect(readQualityChecks(prdWith(['ok', null]))).toBe('invalid');
  });
});

describe('classifyValidationOnlyGateFailure', () => {
  it('只把正常结束的门禁非零退出分类为明确失败', () => {
    expect(classifyValidationOnlyGateFailure(failure({ exitCode: 7, timedOut: false }))).toBe(
      'failed',
    );
  });

  it.each([
    ['超时', { exitCode: null, timedOut: true }],
    ['spawn 错误或信号终止', { exitCode: null, timedOut: false }],
    ['超时优先于异常的数值退出码', { exitCode: 143, timedOut: true }],
  ])('把%s分类为不可验证，不把候选实现误判为失败', (_label, overrides) => {
    expect(classifyValidationOnlyGateFailure(failure(overrides))).toBe('unverifiable');
  });
});

describe('applyGateFailure', () => {
  const base: RunState = {
    'US-001': {
      passes: true,
      validated: true,
      validationReceipt,
      notes: '',
      retryCount: 0,
      blocked: false,
      escalated: false,
    },
  };
  const now = new Date(2026, 6, 5, 14, 30); // 本地时间 2026-07-05 14:30

  it('flips passes to false, bumps retryCount, writes gate failure notes', () => {
    const next = applyGateFailure(base, 'US-001', failure(), now);
    expect(next['US-001'].passes).toBe(false);
    expect(next['US-001'].validated).toBe(false);
    expect(next['US-001']).toHaveProperty('validationReceipt', null);
    expect(next['US-001'].retryCount).toBe(1);
    expect(next['US-001'].blocked).toBe(false);
    expect(next['US-001'].notes).toContain('[门禁失败 - 第1次] 2026-07-05 14:30');
    expect(next['US-001'].notes).toContain('npm test');
    expect(next['US-001'].notes).toContain('退出码 1');
    expect(next['US-001'].notes).toContain('2 failed');
  });

  it('does not mutate the input state', () => {
    const next = applyGateFailure(base, 'US-001', failure(), now);
    expect(next).not.toBe(base);
    expect(base['US-001'].passes).toBe(true);
    expect(base['US-001'].validated).toBe(true);
    expect(base['US-001'].validationReceipt).toBe(validationReceipt);
    expect(base['US-001'].notes).toBe('');
  });

  it('keeps [需求冲突] lines at the top and drops stale failure notes', () => {
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: false,
        notes:
          '[需求冲突] 2026-07-01 10:00 冲突点（源说 X，AC 说 Y，已按 Y 实现）\n[验证失败 - 第1次] 旧失败详情',
        retryCount: 1,
        blocked: false,
        escalated: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(
      next['US-001'].notes.startsWith(
        '[需求冲突] 2026-07-01 10:00 冲突点（源说 X，AC 说 Y，已按 Y 实现）\n[门禁失败 - 第2次]',
      ),
    ).toBe(true);
    expect(next['US-001'].notes).not.toContain('[验证失败');
  });

  it('marks blocked and appends BLOCKED note when retryCount reaches MAX_RETRIES', () => {
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: false,
        notes: '',
        retryCount: MAX_RETRIES - 1,
        blocked: false,
        escalated: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].retryCount).toBe(MAX_RETRIES);
    expect(next['US-001'].blocked).toBe(true);
    expect(next['US-001'].notes).toContain('[BLOCKED: 已达到最大重试次数，跳过此 story]');
  });

  it('treats a missing story id as initial state and reports timeout wording', () => {
    const next = applyGateFailure({}, 'US-009', failure({ timedOut: true, exitCode: null }), now);
    expect(next['US-009'].retryCount).toBe(1);
    expect(next['US-009'].blocked).toBe(false);
    expect(next['US-009'].notes).toContain('执行超时被终止');
  });

  it('keeps [需要人工核实] arbitration lines the same way as [需求冲突]', () => {
    const state: RunState = {
      'US-001': {
        passes: false,
        validated: false,
        notes: '[需要人工核实] 2026-07-07 19:00 门禁配置来源存疑，已附调查过程\n普通旧失败行',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(
      next['US-001'].notes.startsWith(
        '[需要人工核实] 2026-07-07 19:00 门禁配置来源存疑，已附调查过程\n[门禁失败 - 第1次]',
      ),
    ).toBe(true);
    expect(next['US-001'].notes).not.toContain('普通旧失败行');
  });

  it('keeps mixed arbitration lines in original order before the failure block', () => {
    const state: RunState = {
      'US-001': {
        passes: false,
        validated: false,
        notes: '[需求冲突] 冲突点 A\n[需要人工核实] 疑点 B\n其他旧内容',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(
      next['US-001'].notes.startsWith(
        '[需求冲突] 冲突点 A\n[需要人工核实] 疑点 B\n[门禁失败 - 第1次]',
      ),
    ).toBe(true);
  });

  it('preserves an explicit blocked=true set by the agent and skips the max-retries banner', () => {
    const state: RunState = {
      'US-001': {
        passes: false,
        validated: false,
        notes: '[需要人工核实] 已置 blocked 待人工',
        retryCount: 0,
        blocked: true,
        escalated: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].blocked).toBe(true);
    expect(next['US-001'].retryCount).toBe(1);
    expect(next['US-001'].notes).not.toContain('[BLOCKED: 已达到最大重试次数');
  });
});

describe('engine-owned Validator verdict state', () => {
  const now = new Date(2026, 6, 22, 18, 30);
  const base: RunState = {
    'US-001': {
      passes: true,
      validated: false,
      validationReceipt,
      notes: '[需求冲突] 保留这条仲裁\n旧失败详情',
      retryCount: 2,
      blocked: false,
      escalated: true,
    },
  };

  it('applies a passed claim without letting Validator self-sign the receipt', () => {
    const next = applyValidatorSuccess(base, 'US-001');

    expect(next['US-001']).toEqual({
      passes: true,
      validated: false,
      validationReceipt: null,
      validatorUnverifiable: null,
      notes: '[需求冲突] 保留这条仲裁',
      retryCount: 0,
      blocked: false,
      escalated: true,
    });
    expect(base['US-001'].retryCount).toBe(2);
  });

  it('applies failed AC claims, increments retry and preserves arbitration', () => {
    const next = applyValidatorFailure(
      base,
      'US-001',
      {
        checks: [
          { acIndex: 1, passed: false, evidence: 'expected 401, received 200' },
          { acIndex: 2, passed: true, evidence: 'audit assertion passed' },
          { acIndex: 3, passed: false, evidence: 'missing request id' },
        ],
        summary: '鉴权和审计字段未达标',
      },
      now,
    );

    expect(next['US-001'].passes).toBe(false);
    expect(next['US-001'].validated).toBe(false);
    expect(next['US-001']).toHaveProperty('validationReceipt', null);
    expect(next['US-001'].retryCount).toBe(3);
    expect(next['US-001'].blocked).toBe(false);
    expect(next['US-001'].notes).toContain(
      '[需求冲突] 保留这条仲裁\n[验证失败 - 第3次] 2026-07-22 18:30',
    );
    expect(next['US-001'].notes).toContain('- AC 1：expected 401, received 200');
    expect(next['US-001'].notes).toContain('- AC 3：missing request id');
    expect(next['US-001'].notes).not.toContain('audit assertion passed');
    expect(next['US-001'].notes).toContain('- Validator 总结：鉴权和审计字段未达标');
  });

  it('blocks exactly at MAX_RETRIES and keeps the standard banner', () => {
    const state: RunState = {
      'US-001': { ...base['US-001'], retryCount: MAX_RETRIES - 1 },
    };
    const next = applyValidatorFailure(
      state,
      'US-001',
      {
        checks: [{ acIndex: 1, passed: false, evidence: 'still failing' }],
        summary: '未通过',
      },
      now,
    );

    expect(next['US-001'].retryCount).toBe(MAX_RETRIES);
    expect(next['US-001'].blocked).toBe(true);
    expect(next['US-001'].notes).toContain('[BLOCKED: 已达到最大重试次数，跳过此 story]');
  });
});

describe('runQualityChecks', { timeout: 30_000, concurrent: false }, () => {
  it('passes when every command exits 0', async () => {
    const r = await runManagedQualityChecks(['node -e "process.exit(0)"'], process.cwd());
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
  });

  it('fails with the exit code and captured output tail', async () => {
    const r = await runManagedQualityChecks(
      ['node -e "console.error(\'boom-marker\'); process.exit(3)"'],
      process.cwd(),
    );
    expect(r.ok).toBe(false);
    expect(r.failure!.command).toContain('boom-marker');
    expect(r.failure!.exitCode).toBe(3);
    expect(r.failure!.timedOut).toBe(false);
    expect(r.failure!.outputTail).toContain('boom-marker');
  });

  it('fail-fast: does not run commands after the first failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const marker = join(dir, 'ran-second.txt');
    try {
      // 外层双引号内用单引号包路径：tmpdir 路径无空格与单引号，shell 下字面保留
      const second = `node -e "require('node:fs').writeFileSync('${marker}', 'x')"`;
      const r = await runManagedQualityChecks(['node -e "process.exit(1)"', second], process.cwd());
      expect(r.ok).toBe(false);
      expect(r.failure!.command).toBe('node -e "process.exit(1)"');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only the tail of long output', async () => {
    const r = await runManagedQualityChecks(
      [`node -e "console.log('x'.repeat(5000) + 'TAIL-END'); process.exit(1)"`],
      process.cwd(),
    );
    expect(r.ok).toBe(false);
    expect(r.failure!.outputTail.length).toBeLessThanOrEqual(2000);
    expect(r.failure!.outputTail).toContain('TAIL-END');
  });

  it('times out a hanging command and reports timedOut', async () => {
    const r = await runManagedQualityChecks(
      ['node -e "setTimeout(() => {}, 30000)"'],
      process.cwd(),
      500,
    );
    expect(r.ok).toBe(false);
    expect(r.failure!.timedOut).toBe(true);
    expect(r.failure!.exitCode).toBeNull();
  });

  it.runIf(process.platform !== 'win32')(
    'does not resolve a timeout until the whole gate process tree has exited',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gate-'));
      const marker = join(dir, 'orphan-pid.txt');
      try {
        // 复合命令迫使 shell 保留自身进程：node 是孙进程，写下自己的 pid 后挂起
        const hang = `node -e "require('node:fs').writeFileSync('${marker}', String(process.pid)); setInterval(() => {}, 1000)"`;
        const r = await runManagedQualityChecks([`${hang} && echo done`], process.cwd(), 500);
        expect(r.ok).toBe(false);
        expect(r.failure!.timedOut).toBe(true);
        const pid = Number(readFileSync(marker, 'utf-8'));
        // timeout Promise 返回即代表进程树已经退出，引擎此后才可继续读写 workspace。
        expect(() => process.kill(pid, 0)).toThrow(); // signal 0 探活：已死则 ESRCH
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'escalates to SIGKILL before resolving when a gate descendant traps SIGTERM',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gate-'));
      const marker = join(dir, 'trap-pid.txt');
      try {
        // 孙进程陷住 SIGTERM 模拟优雅退出挂死：只有组 SIGKILL 能终结它
        const trap = `node -e "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('${marker}', String(process.pid)); setInterval(() => {}, 1000)" && echo done`;
        const r = await runManagedQualityChecks([trap], process.cwd(), 500);
        expect(r.ok).toBe(false);
        expect(r.failure!.timedOut).toBe(true);
        const pid = Number(readFileSync(marker, 'utf-8'));
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it('returns total/ran/ms — pass runs all, fail-fast stops at the failing check', async () => {
    const pass = await runManagedQualityChecks(
      ['node -e "process.exit(0)"', 'node -e "process.exit(0)"'],
      process.cwd(),
    );
    expect(pass.ok).toBe(true);
    expect(pass.total).toBe(2);
    expect(pass.ran).toBe(2);
    expect(pass.ms).toBeGreaterThanOrEqual(0);

    const fail = await runManagedQualityChecks(
      ['node -e "process.exit(1)"', 'node -e "process.exit(0)"'],
      process.cwd(),
    );
    expect(fail.ok).toBe(false);
    expect(fail.total).toBe(2);
    expect(fail.ran).toBe(1); // fail-fast：第 1 条失败，第 2 条未执行
  });
});

describe('runContractQualityChecks', { timeout: 30_000, concurrent: false }, () => {
  it('returns a deterministic gate failure when the executable cannot be resolved', async () => {
    const result = await runManagedContractQualityChecks(
      contractWith({
        checks: [
          {
            id: 'missing-bin',
            module: 'root',
            command: {
              executable: 'coding-x-definitely-missing-executable',
              args: [],
              cwd: '.',
              platforms: ['linux', 'macos', 'windows'],
              timeoutMs: 5_000,
            },
          },
        ],
      }),
      process.cwd(),
    );

    expect(result).toMatchObject({
      ok: false,
      total: 1,
      ran: 1,
      failure: { command: '[missing-bin]', exitCode: null, timedOut: false },
    });
    expect(result.failure?.outputTail).toContain('找不到可执行文件');
  });

  it('executes structured commands without a shell and honors the declared cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contract-gate-'));
    const moduleDir = join(root, 'module');
    const marker = join(moduleDir, 'structured.txt');
    mkdirSync(moduleDir);
    try {
      const result = await runManagedContractQualityChecks(
        contractWith({
          checks: [
            {
              id: 'structured',
              module: 'root',
              command: {
                executable: process.execPath,
                args: [
                  '-e',
                  `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd())`,
                ],
                cwd: 'module',
                platforms: ['linux', 'macos', 'windows'],
                timeoutMs: 5_000,
              },
            },
          ],
        }),
        root,
      );
      expect(result).toMatchObject({ ok: true, total: 1, ran: 1, skipped: [] });
      expect(readFileSync(marker, 'utf8')).toBe(realpathSync.native(moduleDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a source-tree argument reached through a path alias containing spaces',
    async () => {
      const container = mkdtempSync(join(tmpdir(), 'contract-forbidden-'));
      const source = join(container, 'developer source');
      const sourceAlias = join(container, 'developer source alias');
      const validationRoot = join(container, 'validation');
      const marker = join(validationRoot, 'must-not-run.txt');
      mkdirSync(source);
      mkdirSync(validationRoot);
      writeFileSync(join(source, 'secret.txt'), 'secret');
      symlinkSync(source, sourceAlias, 'dir');
      const fixture = await createManagedProcessTestSession();
      try {
        const result = await runContractQualityChecks(
          contractWith({
            checks: [{
              id: 'source-alias',
              module: 'root',
              command: {
                executable: process.execPath,
                args: [
                  '-e',
                  `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv[1])`,
                  join(sourceAlias, 'secret.txt'),
                ],
                cwd: '.',
                platforms: ['linux', 'macos', 'windows'],
                timeoutMs: 5_000,
              },
            }],
          }),
          validationRoot,
          null,
          {
            session: fixture.session,
            kind: 'quality-check',
            forbiddenExecutableRoot: source,
          },
        );
        expect(result).toMatchObject({
          ok: false,
          failure: { exitCode: null, timedOut: false },
        });
        expect(result.failure?.outputTail).toContain('验证命令解析到开发工作树');
        expect(existsSync(marker)).toBe(false);
      } finally {
        await fixture.close();
        rmSync(container, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps project .cmd quality checks available outside the AI Runner boundary',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'contract-windows-cmd-')));
      const command = join(root, 'project-check.cmd');
      const marker = join(root, 'project-check.txt');
      writeFileSync(command, '@echo off\r\n> "%~1" echo project-cmd-ok\r\nexit /b 0\r\n');
      try {
        const result = await runManagedContractQualityChecks(
          contractWith({
            checks: [
              {
                id: 'project-cmd',
                module: 'root',
                command: {
                  executable: command,
                  args: [marker],
                  cwd: '.',
                  platforms: ['windows'],
                  timeoutMs: 5_000,
                },
              },
            ],
          }),
          root,
          'windows',
        );
        expect(result).toMatchObject({ ok: true, total: 1, ran: 1, skipped: [] });
        expect(readFileSync(marker, 'utf8').trim()).toBe('project-cmd-ok');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'preserves a declared executable symlink as argv0 while executing its canonical target',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'contract-executable-argv0-')));
      const executable = join(root, '.venv', 'bin', 'python');
      mkdirSync(join(root, '.venv', 'bin'), { recursive: true });
      symlinkSync(process.execPath, executable);
      try {
        const result = await runManagedContractQualityChecks(
          contractWith({
            checks: [
              {
                id: 'argv0-sensitive-runtime',
                module: 'root',
                command: {
                  executable: '.venv/bin/python',
                  args: [
                    '-e',
                    `if (process.argv0 !== ${JSON.stringify(executable)}) { console.error(process.argv0); process.exit(9); }`,
                  ],
                  cwd: '.',
                  platforms: ['linux', 'macos'],
                  timeoutMs: 5_000,
                },
              },
            ],
          }),
          root,
          process.platform === 'darwin' ? 'macos' : 'linux',
        );
        expect(result).toMatchObject({ ok: true, total: 1, ran: 1 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'still rejects an executable symlink declared inside the forbidden developer tree',
    async () => {
      const container = mkdtempSync(join(tmpdir(), 'contract-executable-forbidden-'));
      const source = join(container, 'developer');
      const validationRoot = join(container, 'validation');
      mkdirSync(source);
      mkdirSync(validationRoot);
      const executable = join(source, 'runtime');
      symlinkSync(process.execPath, executable);
      const fixture = await createManagedProcessTestSession();
      try {
        const result = await runContractQualityChecks(
          contractWith({
            checks: [
              {
                id: 'forbidden-executable-link',
                module: 'root',
                command: {
                  executable,
                  args: ['-e', 'process.exit(0)'],
                  cwd: '.',
                  platforms: ['linux', 'macos'],
                  timeoutMs: 5_000,
                },
              },
            ],
          }),
          validationRoot,
          process.platform === 'darwin' ? 'macos' : 'linux',
          {
            session: fixture.session,
            kind: 'quality-check',
            forbiddenExecutableRoot: source,
          },
        );
        expect(result).toMatchObject({
          ok: false,
          failure: { exitCode: null, timedOut: false },
        });
        expect(result.failure?.outputTail).toContain('验证命令解析到开发工作树');
      } finally {
        await fixture.close();
        rmSync(container, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'runs an explicitly declared POSIX shell script and never infers shell from executable args',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'contract-shell-'));
      const marker = join(root, 'shell.txt');
      try {
        const result = await runManagedContractQualityChecks(
          contractWith({
            checks: [
              {
                id: 'shell',
                module: 'root',
                command: {
                  shell: '/bin/sh',
                  script: `printf shell-ok > ${JSON.stringify(marker)}`,
                  cwd: '.',
                  platforms: ['macos'],
                  timeoutMs: 5_000,
                },
              },
            ],
          }),
          root,
          'macos',
        );
        expect(result.ok).toBe(true);
        expect(readFileSync(marker, 'utf8')).toBe('shell-ok');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('skips checks that do not apply to the current platform and records their ids', async () => {
    const result = await runManagedContractQualityChecks(
      contractWith({
        checks: [
          {
            id: 'windows-only',
            module: 'root',
            command: {
              executable: process.execPath,
              args: ['-e', 'process.exit(9)'],
              cwd: '.',
              platforms: ['windows'],
              timeoutMs: 5_000,
            },
          },
        ],
      }),
      process.cwd(),
      'linux',
    );
    expect(result).toMatchObject({ ok: true, total: 0, ran: 0, skipped: ['windows-only'] });
  });

  it('fails fast and names the check without exposing a shell-expanded command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contract-fail-'));
    const marker = join(root, 'must-not-run.txt');
    try {
      const result = await runManagedContractQualityChecks(
        contractWith({
          checks: [
            {
              id: 'first-fails',
              module: 'root',
              command: {
                executable: process.execPath,
                args: ['-e', 'console.error("contract-boom"); process.exit(3)'],
                cwd: '.',
                platforms: ['macos'],
                timeoutMs: 5_000,
              },
            },
            {
              id: 'second',
              module: 'root',
              command: {
                executable: process.execPath,
                args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
                cwd: '.',
                platforms: ['macos'],
                timeoutMs: 5_000,
              },
            },
          ],
        }),
        root,
        'macos',
      );
      expect(result.ok).toBe(false);
      expect(result.failure).toMatchObject({
        command: '[first-fails]',
        exitCode: 3,
        timedOut: false,
      });
      expect(result.failure?.outputTail).toContain('contract-boom');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a command cwd that resolves through a symlink outside the project root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contract-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'contract-outside-'));
    symlinkSync(outside, join(root, 'escape'));
    try {
      const result = await runManagedContractQualityChecks(
        contractWith({
          checks: [
            {
              id: 'escape',
              module: 'root',
              command: {
                executable: process.execPath,
                args: ['-e', 'process.exit(0)'],
                cwd: 'escape',
                platforms: ['macos'],
                timeoutMs: 5_000,
              },
            },
          ],
        }),
        root,
        'macos',
      );
      expect(result.ok).toBe(false);
      expect(result.failure).toMatchObject({
        command: '[escape]',
        exitCode: null,
        timedOut: false,
      });
      expect(result.failure?.outputTail).toContain('项目根之外');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('applyAbortRollback', () => {
  const at = new Date('2026-07-17T10:00:00');

  it('distinguishes an output channel failure from a generic signal exit', () => {
    expect(
      abortDesc({ timedOut: false, exitCode: null, terminationReason: 'output-failure' }),
    ).toBe('输出通道失败后被终止');

    const next = applyAbortRollback(
      {
        'US-001': {
          passes: true,
          validated: false,
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      },
      'US-001',
      {
        side: 'builder',
        timedOut: false,
        exitCode: null,
        terminationReason: 'output-failure',
      },
      at,
    );
    expect(next['US-001'].notes).toContain('输出通道失败后被终止');
    expect(next['US-001'].notes).not.toContain('被信号终止');
  });

  it('回写 passes=false 并写入中断标记行；retryCount 与 blocked 不动', () => {
    const state = {
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt,
        notes: '',
        retryCount: 2,
        blocked: false,
        escalated: false,
      },
    };
    const next = applyAbortRollback(
      state,
      'US-001',
      { side: 'builder', timedOut: true, exitCode: null },
      at,
    );
    expect(next['US-001'].passes).toBe(false);
    expect(next['US-001'].validated).toBe(false);
    expect(next['US-001']).toHaveProperty('validationReceipt', null);
    expect(next['US-001'].retryCount).toBe(2);
    expect(next['US-001'].blocked).toBe(false);
    expect(next['US-001'].notes).toContain(ABORT_LINE_PREFIX);
    expect(next['US-001'].notes).toContain('builder');
    expect(next['US-001'].notes).toContain('执行超时被终止');
    // 不可变：原 state 不被就地修改
    expect(state['US-001'].passes).toBe(true);
    expect(state['US-001'].validated).toBe(true);
    expect(state['US-001'].validationReceipt).toBe(validationReceipt);
  });

  it('error 结局的标记行含退出码', () => {
    const state = {
      'US-001': {
        passes: true,
        validated: false,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    const next = applyAbortRollback(
      state,
      'US-001',
      { side: 'validator', timedOut: false, exitCode: 143 },
      at,
    );
    expect(next['US-001'].notes).toContain('validator');
    expect(next['US-001'].notes).toContain('退出码 143');
  });

  it('外部信号终止（timedOut=false 且 exitCode=null）渲染「被信号终止」而非「退出码 null」', () => {
    // runAgent 的 exit 事件 code 为 null 仅发生在进程被信号终止且非引擎超时路径
    const state = {
      'US-001': {
        passes: true,
        validated: false,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    const next = applyAbortRollback(
      state,
      'US-001',
      { side: 'builder', timedOut: false, exitCode: null },
      at,
    );
    expect(next['US-001'].notes).toContain('被信号终止');
    expect(next['US-001'].notes).not.toContain('退出码 null');
  });

  it('保全既有仲裁标签行在标记行之前', () => {
    const state = {
      'US-001': {
        passes: true,
        validated: false,
        notes: '[需求冲突] AC2 与源 PRD 矛盾\n其他记录',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    const next = applyAbortRollback(
      state,
      'US-001',
      { side: 'builder', timedOut: true, exitCode: null },
      at,
    );
    const lines = next['US-001'].notes.split('\n');
    expect(lines[0]).toBe('[需求冲突] AC2 与源 PRD 矛盾');
    expect(lines[1].startsWith(ABORT_LINE_PREFIX)).toBe(true);
    expect(next['US-001'].notes).not.toContain('其他记录');
  });

  it('prev.blocked 时原样返回不回写（停下等人信号优先）', () => {
    const state = {
      'US-001': {
        passes: true,
        validated: false,
        notes: '[需要人工核实] x',
        retryCount: 1,
        blocked: true,
        escalated: false,
      },
    };
    const next = applyAbortRollback(
      state,
      'US-001',
      { side: 'builder', timedOut: true, exitCode: null },
      at,
    );
    expect(next).toBe(state);
  });
});

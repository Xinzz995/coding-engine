import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readQualityChecks, applyGateFailure, runQualityChecks, MAX_RETRIES, applyAbortRollback, ABORT_LINE_PREFIX } from './gate.js';
import type { GateFailure } from './gate.js';
import type { RunState } from './state.js';
import type { Prd } from './prd.js';

const prdWith = (qualityChecks?: unknown): Prd => ({
  project: 'p', branchName: 'b', description: 'd', userStories: [],
  ...(qualityChecks === undefined ? {} : { qualityChecks: qualityChecks as string[] }),
});

const failure = (over: Partial<GateFailure> = {}): GateFailure => ({
  command: 'npm test', exitCode: 1, timedOut: false, outputTail: '2 failed', ...over,
});

describe('readQualityChecks', () => {
  it('returns null when prd is null or field missing', () => {
    expect(readQualityChecks(null)).toBeNull();
    expect(readQualityChecks(prdWith())).toBeNull();
  });

  it('returns null for an empty array (gate disabled, silent)', () => {
    expect(readQualityChecks(prdWith([]))).toBeNull();
  });

  it('returns the commands for a valid string array', () => {
    expect(readQualityChecks(prdWith(['npm run typecheck', 'npm test'])))
      .toEqual(['npm run typecheck', 'npm test']);
  });

  it('returns "invalid" for non-array or non-string members', () => {
    expect(readQualityChecks(prdWith('npm test'))).toBe('invalid');
    expect(readQualityChecks(prdWith([1]))).toBe('invalid');
    expect(readQualityChecks(prdWith(['ok', null]))).toBe('invalid');
  });
});

describe('applyGateFailure', () => {
  const base: RunState = {
    'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
  };
  const now = new Date(2026, 6, 5, 14, 30); // 本地时间 2026-07-05 14:30

  it('flips passes to false, bumps retryCount, writes gate failure notes', () => {
    const next = applyGateFailure(base, 'US-001', failure(), now);
    expect(next['US-001'].passes).toBe(false);
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
    expect(base['US-001'].notes).toBe('');
  });

  it('keeps [需求冲突] lines at the top and drops stale failure notes', () => {
    const state: RunState = {
      'US-001': {
        passes: true,
        notes: '[需求冲突] 2026-07-01 10:00 冲突点（源说 X，AC 说 Y，已按 Y 实现）\n[验证失败 - 第1次] 旧失败详情',
        retryCount: 1,
        blocked: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].notes.startsWith(
      '[需求冲突] 2026-07-01 10:00 冲突点（源说 X，AC 说 Y，已按 Y 实现）\n[门禁失败 - 第2次]',
    )).toBe(true);
    expect(next['US-001'].notes).not.toContain('[验证失败');
  });

  it('marks blocked and appends BLOCKED note when retryCount reaches MAX_RETRIES', () => {
    const state: RunState = {
      'US-001': { passes: true, notes: '', retryCount: MAX_RETRIES - 1, blocked: false },
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
        notes: '[需要人工核实] 2026-07-07 19:00 门禁配置来源存疑，已附调查过程\n普通旧失败行',
        retryCount: 0,
        blocked: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].notes.startsWith(
      '[需要人工核实] 2026-07-07 19:00 门禁配置来源存疑，已附调查过程\n[门禁失败 - 第1次]',
    )).toBe(true);
    expect(next['US-001'].notes).not.toContain('普通旧失败行');
  });

  it('keeps mixed arbitration lines in original order before the failure block', () => {
    const state: RunState = {
      'US-001': {
        passes: false,
        notes: '[需求冲突] 冲突点 A\n[需要人工核实] 疑点 B\n其他旧内容',
        retryCount: 0,
        blocked: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].notes.startsWith('[需求冲突] 冲突点 A\n[需要人工核实] 疑点 B\n[门禁失败 - 第1次]')).toBe(true);
  });

  it('preserves an explicit blocked=true set by the agent and skips the max-retries banner', () => {
    const state: RunState = {
      'US-001': {
        passes: false,
        notes: '[需要人工核实] 已置 blocked 待人工',
        retryCount: 0,
        blocked: true,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].blocked).toBe(true);
    expect(next['US-001'].retryCount).toBe(1);
    expect(next['US-001'].notes).not.toContain('[BLOCKED: 已达到最大重试次数');
  });
});

describe('runQualityChecks', () => {
  it('passes when every command exits 0', async () => {
    const r = await runQualityChecks(['node -e "process.exit(0)"'], process.cwd());
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
  });

  it('fails with the exit code and captured output tail', async () => {
    const r = await runQualityChecks(
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
      const r = await runQualityChecks(['node -e "process.exit(1)"', second], process.cwd());
      expect(r.ok).toBe(false);
      expect(r.failure!.command).toBe('node -e "process.exit(1)"');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only the tail of long output', async () => {
    const r = await runQualityChecks(
      [`node -e "console.log('x'.repeat(5000) + 'TAIL-END'); process.exit(1)"`],
      process.cwd(),
    );
    expect(r.ok).toBe(false);
    expect(r.failure!.outputTail.length).toBeLessThanOrEqual(2000);
    expect(r.failure!.outputTail).toContain('TAIL-END');
  });

  it('times out a hanging command and reports timedOut', async () => {
    const r = await runQualityChecks(
      ['node -e "setTimeout(() => {}, 30000)"'],
      process.cwd(),
      500,
    );
    expect(r.ok).toBe(false);
    expect(r.failure!.timedOut).toBe(true);
    expect(r.failure!.exitCode).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('kills the whole process tree on timeout (no orphaned grandchildren)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const marker = join(dir, 'orphan-pid.txt');
    try {
      // 复合命令迫使 shell 保留自身进程：node 是孙进程，写下自己的 pid 后挂起
      const hang = `node -e "require('node:fs').writeFileSync('${marker}', String(process.pid)); setInterval(() => {}, 1000)"`;
      const r = await runQualityChecks([`${hang} && echo done`], process.cwd(), 500);
      expect(r.ok).toBe(false);
      expect(r.failure!.timedOut).toBe(true);
      await new Promise((res) => setTimeout(res, 300)); // 给信号传播留时间
      const pid = Number(readFileSync(marker, 'utf-8'));
      expect(() => process.kill(pid, 0)).toThrow(); // signal 0 探活：已死则 ESRCH
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('escalates to SIGKILL for grandchildren that trap SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const marker = join(dir, 'trap-pid.txt');
    try {
      // 孙进程陷住 SIGTERM 模拟优雅退出挂死：只有组 SIGKILL 能终结它
      const trap = `node -e "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('${marker}', String(process.pid)); setInterval(() => {}, 1000)" && echo done`;
      const r = await runQualityChecks([trap], process.cwd(), 500);
      expect(r.ok).toBe(false);
      expect(r.failure!.timedOut).toBe(true);
      // 等过 5s 升级窗口 + 传播余量：组 SIGKILL 必须已补刀
      await new Promise((res) => setTimeout(res, 5800));
      const pid = Number(readFileSync(marker, 'utf-8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('returns total/ran/ms — pass runs all, fail-fast stops at the failing check', async () => {
    const pass = await runQualityChecks(['node -e "process.exit(0)"', 'node -e "process.exit(0)"'], process.cwd());
    expect(pass.ok).toBe(true);
    expect(pass.total).toBe(2);
    expect(pass.ran).toBe(2);
    expect(pass.ms).toBeGreaterThanOrEqual(0);

    const fail = await runQualityChecks(
      ['node -e "process.exit(1)"', 'node -e "process.exit(0)"'], process.cwd());
    expect(fail.ok).toBe(false);
    expect(fail.total).toBe(2);
    expect(fail.ran).toBe(1); // fail-fast：第 1 条失败，第 2 条未执行
  });
});

describe('applyAbortRollback', () => {
  const at = new Date('2026-07-17T10:00:00');

  it('回写 passes=false 并写入中断标记行；retryCount 与 blocked 不动', () => {
    const state = { 'US-001': { passes: true, notes: '', retryCount: 2, blocked: false } };
    const next = applyAbortRollback(state, 'US-001', { side: 'builder', timedOut: true, exitCode: null }, at);
    expect(next['US-001'].passes).toBe(false);
    expect(next['US-001'].retryCount).toBe(2);
    expect(next['US-001'].blocked).toBe(false);
    expect(next['US-001'].notes).toContain(ABORT_LINE_PREFIX);
    expect(next['US-001'].notes).toContain('builder');
    expect(next['US-001'].notes).toContain('执行超时被终止');
    // 不可变：原 state 不被就地修改
    expect(state['US-001'].passes).toBe(true);
  });

  it('error 结局的标记行含退出码', () => {
    const state = { 'US-001': { passes: true, notes: '', retryCount: 0, blocked: false } };
    const next = applyAbortRollback(state, 'US-001', { side: 'validator', timedOut: false, exitCode: 143 }, at);
    expect(next['US-001'].notes).toContain('validator');
    expect(next['US-001'].notes).toContain('退出码 143');
  });

  it('保全既有仲裁标签行在标记行之前', () => {
    const state = { 'US-001': { passes: true, notes: '[需求冲突] AC2 与源 PRD 矛盾\n其他记录', retryCount: 0, blocked: false } };
    const next = applyAbortRollback(state, 'US-001', { side: 'builder', timedOut: true, exitCode: null }, at);
    const lines = next['US-001'].notes.split('\n');
    expect(lines[0]).toBe('[需求冲突] AC2 与源 PRD 矛盾');
    expect(lines[1].startsWith(ABORT_LINE_PREFIX)).toBe(true);
    expect(next['US-001'].notes).not.toContain('其他记录');
  });

  it('prev.blocked 时原样返回不回写（停下等人信号优先）', () => {
    const state = { 'US-001': { passes: true, notes: '[需要人工核实] x', retryCount: 1, blocked: true } };
    const next = applyAbortRollback(state, 'US-001', { side: 'builder', timedOut: true, exitCode: null }, at);
    expect(next).toBe(state);
  });
});

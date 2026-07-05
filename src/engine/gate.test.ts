import { describe, it, expect } from 'vitest';
import { readQualityChecks, applyGateFailure, MAX_RETRIES } from './gate.js';
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
});

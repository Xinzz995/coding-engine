import { describe, expect, it } from 'vitest';
import { validateP1DeferralIssue } from './decisions.js';

function issue(over: Record<string, unknown> = {}) {
  return {
    number: 7, state: 'open' as const, title: 'defer', url: 'https://example.test/7',
    labels: ['quality-p1-deferral'], isPullRequest: false,
    body: [
      '### 负责人', '@owner', '### 原因', '等待外部兼容窗口',
      '### 到期日', '2026-08-01', '### 跟进事项', '补齐兼容实现与回归',
    ].join('\n'),
    ...over,
  };
}

describe('validateP1DeferralIssue', () => {
  it('requires an open, labeled, complete and unexpired issue', () => {
    expect(validateP1DeferralIssue(issue(), 30, new Date('2026-07-26T12:00:00Z'))).toEqual([]);
    expect(validateP1DeferralIssue(issue({ state: 'closed', labels: [], body: '' }), 30,
      new Date('2026-07-26T12:00:00Z'))).toEqual(expect.arrayContaining([
      '延期引用必须是开放 Issue',
      '延期 Issue 缺少 quality-p1-deferral 标签',
      '延期 Issue 缺少负责人、原因、到期日或跟进事项',
    ]));
  });

  it('rejects expired and overlong deferrals', () => {
    expect(validateP1DeferralIssue(issue({
      body: issue().body.replace('2026-08-01', '2026-07-25'),
    }), 30, new Date('2026-07-26T00:00:00Z'))).toContain('延期 Issue 已过期');
    expect(validateP1DeferralIssue(issue({
      body: issue().body.replace('2026-08-01', '2026-09-30'),
    }), 30, new Date('2026-07-26T00:00:00Z'))).toContain('延期 Issue 到期日超过 30 天上限');
    expect(validateP1DeferralIssue(issue({
      body: issue().body.replace('2026-08-01', '2026-02-30'),
    }), 30, new Date('2026-01-26T00:00:00Z'))).toContain('延期 Issue 到期日必须是 YYYY-MM-DD');
  });
});

import { describe, expect, it } from 'vitest';
import { currentBlockingDecisionProof, validateP1DeferralIssue } from './decisions.js';
import type { ReviewDecision, ReviewFinding } from './types.js';

function issue(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: 'open' as const,
    title: 'defer',
    url: 'https://example.test/7',
    labels: ['quality-p1-deferral'],
    isPullRequest: false,
    body: [
      '### 负责人',
      '@owner',
      '### 原因',
      '等待外部兼容窗口',
      '### 到期日',
      '2026-08-01',
      '### 跟进事项',
      '补齐兼容实现与回归',
    ].join('\n'),
    ...over,
  };
}

describe('validateP1DeferralIssue', () => {
  it('requires an open, labeled, complete and unexpired issue', () => {
    expect(validateP1DeferralIssue(issue(), 30, new Date('2026-07-26T12:00:00Z'))).toEqual([]);
    expect(
      validateP1DeferralIssue(
        issue({ state: 'closed', labels: [], body: '' }),
        30,
        new Date('2026-07-26T12:00:00Z'),
      ),
    ).toEqual(
      expect.arrayContaining([
        '延期引用必须是开放 Issue',
        '延期 Issue 缺少 quality-p1-deferral 标签',
        '延期 Issue 缺少负责人、原因、到期日或跟进事项',
      ]),
    );
  });

  it('rejects expired and overlong deferrals', () => {
    expect(
      validateP1DeferralIssue(
        issue({
          body: issue().body.replace('2026-08-01', '2026-07-25'),
        }),
        30,
        new Date('2026-07-26T00:00:00Z'),
      ),
    ).toContain('延期 Issue 已过期');
    expect(
      validateP1DeferralIssue(
        issue({
          body: issue().body.replace('2026-08-01', '2026-09-30'),
        }),
        30,
        new Date('2026-07-26T00:00:00Z'),
      ),
    ).toContain('延期 Issue 到期日超过 30 天上限');
    expect(
      validateP1DeferralIssue(
        issue({
          body: issue().body.replace('2026-08-01', '2026-02-30'),
        }),
        30,
        new Date('2026-01-26T00:00:00Z'),
      ),
    ).toContain('延期 Issue 到期日必须是 YYYY-MM-DD');
  });
});

describe('currentBlockingDecisionProof', () => {
  const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
    id: 'engineering:P1:demo',
    axis: 'engineering',
    severity: 'P1',
    title: 'deferred problem',
    location: { path: 'src/demo.ts', line: 1 },
    ruleSource: 'AGENTS.md',
    impact: 'delivery remains risky',
    recommendation: 'fix it',
    requiresHumanDecision: false,
    prNumber: 7,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    round: 1,
    ...over,
  });
  const decision = (over: Partial<ReviewDecision> = {}): ReviewDecision => ({
    findingId: 'engineering:P1:demo',
    headSha: 'b'.repeat(40),
    reviewBindingDigest: `sha256:${'c'.repeat(64)}`,
    action: 'p1-deferred',
    operator: 'owner',
    at: '2026-07-26T00:00:00.000Z',
    issue: 7,
    ...over,
  });

  it('retains the live Issue reference for the exact Review binding', () => {
    expect(
      currentBlockingDecisionProof({
        findings: [finding()],
        decisions: [decision()],
        headSha: 'b'.repeat(40),
        reviewBindingDigest: `sha256:${'c'.repeat(64)}`,
      }),
    ).toEqual({ deferrals: [{ findingId: 'engineering:P1:demo', issue: 7 }], errors: [] });
  });

  it('fails closed when the bound decision disappears, changes binding, or has weak evidence', () => {
    const options = {
      findings: [finding()],
      headSha: 'b'.repeat(40),
      reviewBindingDigest: `sha256:${'c'.repeat(64)}`,
    };
    expect(currentBlockingDecisionProof({ ...options, decisions: [] }).errors).toContain(
      'engineering:P1:demo 缺少当前 Review 的有效裁决',
    );
    expect(
      currentBlockingDecisionProof({
        ...options,
        decisions: [decision({ reviewBindingDigest: `sha256:${'d'.repeat(64)}` })],
      }).errors,
    ).toContain('engineering:P1:demo 缺少当前 Review 的有效裁决');
    expect(
      currentBlockingDecisionProof({
        ...options,
        decisions: [
          decision({ action: 'counterevidence', issue: undefined, evidence: 'too short' }),
        ],
      }).errors,
    ).toContain('engineering:P1:demo 的反证必须具体且不少于 20 个字符');
  });
});

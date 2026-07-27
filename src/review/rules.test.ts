import { describe, expect, it } from 'vitest';
import { REVIEW_RULES, REVIEW_RULES_DIGEST, rulesForAxis } from './rules.js';
import { REVIEW_RULES_VERSION } from './types.js';

describe('review rules', () => {
  it('keeps implementation intent separate from engine-owned delivery postconditions', () => {
    const rules = rulesForAxis('spec').join('\n');
    expect(rules).toContain('改动应具备什么行为');
    expect(rules).toContain('全部 Review 轴完成状态');
    expect(rules).toContain('不得仅因这些后置状态');
    expect(REVIEW_RULES.version).toBe('1.1.0');
    expect(REVIEW_RULES_VERSION).toBe('1.1.0');
    expect(REVIEW_RULES_DIGEST).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

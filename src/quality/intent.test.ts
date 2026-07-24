import { describe, expect, it } from 'vitest';
import { parseReviewIntent } from './intent.js';

const complete = `# PR

## 意图
让质量门禁阻止旧评审。

## 验收标准
- 新提交后旧 SHA 失效。

## 非目标
- 不自动合并。

## 验证方式
- 用真实 PR 检查。
`;

describe('review intent', () => {
  it('extracts the four required Chinese sections', () => {
    const result = parseReviewIntent(complete);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.intent.intent).toContain('质量门禁');
      expect(result.intent.acceptanceCriteria).toContain('旧 SHA');
    }
  });

  it('accepts stable English aliases', () => {
    const result = parseReviewIntent(`
## Intent
Add a gate.
## Acceptance Criteria
Old reviews fail.
## Non-goals
No auto merge.
## Verification
Open a pull request.
`);
    expect(result.status).toBe('valid');
  });

  it.each([
    ['', ['意图', '验收标准', '非目标', '验证方式']],
    ['## 意图\nx\n## 验收标准\ny\n## 非目标\nz', ['验证方式']],
    ['## 意图\n\n## 验收标准\ny\n## 非目标\nz\n## 验证方式\nv', ['意图']],
  ])('reports missing or empty sections without calling a model', (body, missing) => {
    const result = parseReviewIntent(body);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.missing).toEqual(missing);
  });

  it('does not treat untouched PR template comments as intent evidence', () => {
    const result = parseReviewIntent(`
## 意图
<!-- 这次改动要实现或修复什么？ -->
## 验收标准
<!-- 写成可观察的通过条件 -->
## 非目标
<!-- 明确不做什么 -->
## 验证方式
<!-- 列出验证 -->
`);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.missing).toEqual(['意图', '验收标准', '非目标', '验证方式']);
    }
  });
});

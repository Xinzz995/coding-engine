import { describe, expect, it } from 'vitest';
import {
  parseReviewIntent,
  selectReviewSpecPaths,
} from './intent.js';

const complete = `# PR

## 意图
让质量门禁阻止旧评审。

## 验收标准
- 新提交后旧 SHA 失效。

## 非目标
- 不自动合并。

## 验证方式
- 用真实 PR 检查。

## 关联规格
- \`docs/specs/quality.md\`
`;

describe('review intent', () => {
  it('extracts required intent sections and linked Spec paths', () => {
    const result = parseReviewIntent(complete);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.intent.intent).toContain('质量门禁');
      expect(result.intent.acceptanceCriteria).toContain('旧 SHA');
      expect(result.specification).toEqual({
        mode: 'linked',
        paths: ['docs/specs/quality.md'],
      });
    }
  });

  it('accepts stable English aliases and an explicit self-contained Spec', () => {
    const result = parseReviewIntent(`
## Intent
Add a gate.
## Acceptance Criteria
Old reviews fail.
## Non-goals
No auto merge.
## Verification
Open a pull request.
## Linked Specs
self-contained
`);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.specification).toEqual({ mode: 'self-contained', paths: [] });
    }
  });

  it.each([
    ['', ['意图', '验收标准', '非目标', '验证方式', '关联规格']],
    [
      '## 意图\nx\n## 验收标准\ny\n## 非目标\nz\n## 关联规格\nself-contained',
      ['验证方式'],
    ],
    [
      '## 意图\n\n## 验收标准\ny\n## 非目标\nz\n## 验证方式\nv\n## 关联规格\nself-contained',
      ['意图'],
    ],
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
## 关联规格
<!-- 列出规格 -->
`);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.missing).toEqual([
        '意图', '验收标准', '非目标', '验证方式', '关联规格',
      ]);
    }
  });

  it.each([
    ['../secret.md', '关联规格不是安全的项目文件路径'],
    ['/tmp/spec.md', '关联规格不是安全的项目文件路径'],
    ['docs\\specs\\feature.md', '关联规格不是安全的项目文件路径'],
    ['self-contained\n- docs/specs/feature.md', '不能同时声明'],
  ])('rejects ambiguous or unsafe Spec selection %s', (selection, message) => {
    const result = parseReviewIntent(
      complete.replace('- `docs/specs/quality.md`', selection),
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.missing[0]).toContain(message);
  });

  it('selects declared and changed Spec files without loading the whole allowed directory', () => {
    expect(selectReviewSpecPaths(
      { mode: 'linked', paths: ['docs/specs/one.md'] },
      ['docs/specs/one.md', 'docs/specs/two.md', 'docs/specs/unused.md'],
      ['src/app.ts', 'docs/specs/two.md'],
    )).toEqual(['docs/specs/one.md', 'docs/specs/two.md']);
    expect(() => selectReviewSpecPaths(
      { mode: 'linked', paths: ['README.md'] },
      ['docs/specs/one.md'],
      [],
    )).toThrow('不在质量契约允许范围内');
  });
});

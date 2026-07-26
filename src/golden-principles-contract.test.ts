import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const principles = readFileSync(new URL('../docs/golden-principles.md', import.meta.url), 'utf-8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf-8');
const planning = readFileSync(new URL('../commands/planning.md', import.meta.url), 'utf-8');
const reviewLoop = readFileSync(new URL('../commands/review-loop.md', import.meta.url), 'utf-8');

describe('新功能黄金原则合同', () => {
  it('保持五条可机械检查的原则，并覆盖报告得出的核心边界', () => {
    expect(principles.match(/^## \d+\. /gm)).toHaveLength(5);
    expect(principles.match(/^- \*\*规则\*\*：/gm)).toHaveLength(5);
    expect(principles.match(/^- \*\*为什么\*\*：/gm)).toHaveLength(5);
    expect(principles.match(/^- \*\*怎么检查\*\*：/gm)).toHaveLength(5);

    for (const anchor of [
      '可证伪的完成合同',
      '生成方不得给自己签发通过',
      '防线与可逆性必须同步增加',
      '原生执行能力优先复用',
      '以假绿率和失败恢复衡量价值',
      'agent 声明不得包装成防伪事实',
      'runner-neutral',
    ]) expect(principles).toContain(anchor);
  });

  it('AGENTS 把逐条对照设为编码前硬约束', () => {
    expect(agents).toContain('| 黄金原则 | `docs/golden-principles.md` |');
    expect(agents).toContain('新功能编码前必须在实现计划或 PRD 中逐条完成');
    expect(agents).toContain('不适用项写明理由，未裁决项先交用户确认');
  });

  it('planning 产物必须逐条裁决并设计失败路径', () => {
    for (const anchor of [
      '## 黄金原则对照',
      '| 黄金原则 | 适用性 | 本功能设计裁决 | 验证方式或证据 |',
      '不得用一句「均遵循」代替',
      'acceptanceCriteria → 验证方式/证据',
      '### 假绿与失败恢复',
      '停止生成可执行计划并先交用户裁决',
    ]) expect(planning).toContain(anchor);
  });

  it('review-loop 只裁决当前提交的结构化 finding，不制造第二套 Review', () => {
    for (const anchor of [
      '黄金原则不是自述',
      '不得降级为普通 diff Review',
      '.workspace/review-decisions.json',
      'fix-requested',
      '新提交会让旧 Validator 和最终 Review 失效',
      '模型不能替人选择产品行为',
    ]) expect(reviewLoop).toContain(anchor);
  });
});

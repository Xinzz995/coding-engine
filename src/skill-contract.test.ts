import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(new URL('../skills/prd-to-json/SKILL.md', import.meta.url), 'utf-8');

describe('prd-to-json 模型路由 prompt 合同', () => {
  it('包含 runner 绑定的新 schema 与五项用户选择', () => {
    for (const anchor of [
      '"runner": "codex"', '"low": "model-low"', '"medium": "model-medium"',
      '"high": "model-high"', '"validator": "model-validator"',
      '"escalation": "model-escalation"', '批量提出五道选择题',
      'npx coding-x models <runner> --json',
    ]) expect(skill).toContain(anchor);
  });

  it('包含完整固定难度规则与理由证据合同', () => {
    for (const anchor of [
      'high-1', 'high-7', 'medium-1', 'medium-6', 'low-1', 'low-5',
      '一至两句', '仓库具体证据', '仓库相对路径', '不在写入前逐 story 设置审批门槛',
    ]) expect(skill).toContain(anchor);
  });

  it('包含再派生精确保留/重置和 blocked 选择', () => {
    for (const anchor of [
      '五个模型在本次', '保留原 `difficulty`', '全量重新评估',
      'models.builder[difficulty]', '只改 difficultyReason、validator 或 escalation',
      '保持 blocked', '用新路由重试', 'blocked=false、retryCount=0、escalated=false',
    ]) expect(skill).toContain(anchor);
  });

  it('移除未发布的 profiles、阈值升级和 story 模型覆盖格式', () => {
    expect(skill).not.toContain('"profiles"');
    expect(skill).not.toContain('escalateAfter');
    expect(skill).not.toContain('story.model');
  });
});

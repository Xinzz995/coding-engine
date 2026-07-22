import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(new URL('../skills/prd-to-json/SKILL.md', import.meta.url), 'utf-8');

describe('prd-to-json 模型路由 prompt 合同', () => {
  it('包含 runner 绑定的项目 schema 与五项用户选择', () => {
    for (const anchor of [
      '"runner": "codex"', '"low": "model-low"', '"medium": "model-medium"',
      '"high": "model-high"', '"validator": "model-validator"',
      '"escalation": "model-escalation"', '批量提出五道选择题',
      'npx coding-x models <runner> --json',
    ]) expect(skill).toContain(anchor);
  });

  it('包含 v0.24 全局模型目录路径、schema 与只读边界', () => {
    for (const anchor of [
      '~/.config/coding-x/config.json', '`CODING_X_CONFIG`', '"version": 1',
      '"claude":', '"codex":', '"cursor":', '"id":', '"label":',
      'npx coding-x config path', 'npx coding-x config init', 'npx coding-x config validate',
      '都不拉起 Claude Code、Codex 或 Cursor CLI',
      '不证明账号、provider、配额或网络下实时可用',
      'runner-default 零配置路径', '任一模型 CLI 覆盖，该 ID 仍必须在目录中声明',
      '不能替用户拍板，也不能选择目录外 ID',
      '目录错误时不得请用户在当前会话临时粘贴 ID 绕过',
      '不自动推荐或判断倒挂',
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
      '任一模型被移出目录', '不得退回历史列表或会话内临时列表',
    ]) expect(skill).toContain(anchor);
  });

  it('写入前机械检查 workspace Git 隔离且不擅改用户仓库', () => {
    for (const anchor of [
      'git rev-parse --is-inside-work-tree',
      'git ls-files -- .workspace',
      'git check-ignore -q --no-index .workspace/',
      '不得自动修改 `.gitignore`',
      '不得自动执行 `git rm --cached`',
      '用户明确选择',
    ]) expect(skill).toContain(anchor);
  });

  it('归档或再派生前检查活跃工作区锁且不擅自删锁', () => {
    for (const anchor of [
      'npx coding-x doctor --workspace .workspace',
      '`engine.lock`',
      '引擎运行中',
      '停止派生',
      '不得删除 `engine.lock`',
      '真正写入前再次运行',
    ]) expect(skill).toContain(anchor);
  });

  it('移除旧 schema 与 runner 自主查询语义', () => {
    for (const removed of [
      '"profiles"', 'escalateAfter', 'story.model', 'unsupported',
      'app-server', 'model/list', '当前机器、当前账号', '模型发现/人工列表',
    ]) expect(skill).not.toContain(removed);
  });
});

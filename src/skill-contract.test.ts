import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(new URL('../skills/prd-to-json/SKILL.md', import.meta.url), 'utf-8');
const tddSkill = readFileSync(new URL('../skills/tdd/SKILL.md', import.meta.url), 'utf-8');

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

  it('用同一显式 workspace 做只读 Git 隔离且不擅改用户仓库', () => {
    for (const anchor of [
      'git rev-parse --is-inside-work-tree',
      '同一个 `<workspace-dir>`',
      '是否已有文件被跟踪',
      '是否被 Git 忽略',
      '不得自动修改 `.gitignore`',
      '不得自动执行 `git rm --cached`',
      '用户明确选择',
    ]) expect(skill).toContain(anchor);
    expect(skill).not.toContain('git ls-files -- .workspace');
    expect(skill).not.toContain('git check-ignore -q --no-index .workspace/');
  });

  it('把租约和业务写入完全交给固定 CLI 入口', () => {
    for (const anchor of [
      'npx coding-x doctor --json --workspace <workspace-dir>',
      '不预检、删除、修复或接管 workspace 租约',
      'workspace apply-prd',
      '原子获取结果',
      '保持零业务写入',
      '不得改成直接写 workspace',
    ]) expect(skill).toContain(anchor);
  });

  it('仅在用户确认并通过真实基线后派生 TDD 门禁', () => {
    for (const anchor of [
      '是否启用 TDD',
      '新项目或存量项目',
      'coverageCheck',
      'sourcePathspecs',
      'policyFiles',
      'baselineRef',
      'forbiddenAddedPatterns',
      '一次确认',
      '真实运行',
      '零测试',
      '分支覆盖率',
      'sha256',
      '不得编造',
      '不使用 AI 判断',
    ]) expect(skill).toContain(anchor);
  });

  it('把项目机械门禁留在 qualityChecks，不再复制进每个 Story', () => {
    expect(skill).toContain('机械质量检查与 Story AC 分层');
    expect(skill).toContain('不得自动向每个 story 追加 `Typecheck passes`');
    expect(skill).not.toContain('始终添加**："Typecheck passes"');
    expect(skill).not.toContain('每个 story 都有 "Typecheck passes" 作为标准');
  });

  it('把 TDD 政策变化留给用户重新批准', () => {
    for (const anchor of [
      '行覆盖率与分支覆盖率都不低于 90%',
      '总体行/分支覆盖率不低于启用基线',
      '新增/改动可执行行覆盖率不低于 90%',
      '不得自行降低阈值',
      '不得自行扩大排除',
      '重新派生',
    ]) expect(skill).toContain(anchor);
  });

  it('只提醒显式安装 Cursor 项目检查，不在转换时偷偷安装', () => {
    for (const anchor of [
      'npx coding-x hooks cursor install',
      'npx coding-x hooks cursor status',
      'npx coding-x hooks cursor remove',
      '本 skill 不自动安装',
      '不修改 Git hooks',
    ]) expect(skill).toContain(anchor);
  });

  it('移除旧 schema 与 runner 自主查询语义', () => {
    for (const removed of [
      '"profiles"', 'escalateAfter', 'story.model', 'unsupported',
      'app-server', 'model/list', '当前机器、当前账号', '模型发现/人工列表',
    ]) expect(skill).not.toContain(removed);
  });
});

describe('tdd skill 合同', () => {
  it('frontmatter 只声明 name 与完整触发描述', () => {
    const frontmatter = tddSkill.split('---')[1] ?? '';
    const keys = frontmatter.split(/\r?\n/)
      .map((line) => /^([a-zA-Z_-]+):/.exec(line)?.[1])
      .filter(Boolean);
    expect(keys).toEqual(['name', 'description']);
    expect(frontmatter).toContain('name: tdd');
    for (const trigger of ['TDD', '测试先行', '红-绿-重构', '修复缺陷', 'test-first']) {
      expect(frontmatter).toContain(trigger);
    }
  });

  it('强制一行为一循环、真实 RED/GREEN 与绿色重构', () => {
    for (const anchor of [
      '一次只处理一个行为',
      '真实运行',
      '待实现行为',
      '语法、依赖、路径或环境错误',
      '同一条聚焦测试命令',
      '只在 GREEN',
      '公共接口',
      'coverageCheck',
      'agent 声明',
    ]) expect(tddSkill).toContain(anchor);
  });

  it('区分交互模式与 coding-x 已批准 AC 的无人值守模式', () => {
    for (const anchor of [
      '交互模式',
      'coding-x 模式',
      'acceptanceCriteria',
      '已获用户批准',
      '[需要人工核实]',
      'blocked',
      '不得自行新增覆盖排除',
    ]) expect(tddSkill).toContain(anchor);
  });

  it('包含 Cursor 项目检查的安装、刷新、状态与卸载边界', () => {
    for (const anchor of [
      'npx coding-x hooks cursor install',
      'npx coding-x hooks cursor status',
      'npx coding-x hooks cursor remove',
      '不要静默安装',
      '不修改 Git hooks',
      '不暂存或提交文件',
    ]) expect(tddSkill).toContain(anchor);
  });

  it('直接索引五份按需参考材料', () => {
    for (const file of [
      'references/tests.md',
      'references/mocking.md',
      'references/interface-design.md',
      'references/deep-modules.md',
      'references/refactoring.md',
    ]) expect(tddSkill).toContain(file);
  });
});

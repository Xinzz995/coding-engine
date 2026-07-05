import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 清单一致性测试：skills/、commands/ 目录与 README 两张表格必须逐项一致。
// 与 version-consistency 同源的教训（2026-07-04 插件清单版本停滞三个版本无人发现）：
// 靠人记「加了 skill 要同步 README」必漂移，而 README 表格是用户了解插件能力的
// 权威登记处——目录里有而表格没有，用户不知道它存在；表格有而目录没有，README 在撒谎
// （不变量学自 mattpocock/skills：凡 promoted 的 skill 必须同时出现在 README 与插件清单，缺一即违规）。
// 覆盖范围：只校验两张表格（权威登记处）；README 散文与目录结构示意图中的枚举不做机械校验。

const ROOT = process.cwd(); // vitest root = 仓库根

// 按表头行（如「| 命令 | 作用 |」）锚定表格，取其后连续表格行的首列。
// 不按 ### 标题切片：indexOf('### 命令') 会命中更早的「### 命令行参数」章节（本测试首跑就红在这）。
// 首列形如 | `/planning <功能描述>` | 或 | `scenario-alignment` |，取反引号内首个词；|---| 分隔行无反引号自然跳过。
function tableFirstColumnAfterHeader(md, headerPattern) {
  const lines = md.split('\n');
  const idx = lines.findIndex((l) => headerPattern.test(l));
  if (idx === -1) return null;
  const cells = [];
  for (let i = idx + 1; i < lines.length && lines[i].startsWith('|'); i++) {
    const m = lines[i].match(/^\|\s*`([^`]+)`\s*\|/);
    if (m) cells.push(m[1].trim().split(/\s+/)[0]);
  }
  return cells;
}

describe('catalog consistency', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('README 命令表格与 commands/ 目录逐项一致', () => {
    const onDisk = readdirSync(join(ROOT, 'commands'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();

    const cells = tableFirstColumnAfterHeader(readme, /^\|\s*命令\s*\|/);
    expect(cells, 'README 必须存在「| 命令 | … |」表头的命令表格').not.toBeNull();
    const inReadme = cells.map((cell) => cell.replace(/^\//, '')).sort();

    expect(inReadme, 'README 命令表格与 commands/*.md 漂移').toEqual(onDisk);
  });

  it('README Skills 表格与 skills/ 目录逐项一致', () => {
    const onDisk = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'skills', e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();

    const cells = tableFirstColumnAfterHeader(readme, /^\|\s*Skill\s*\|/);
    expect(cells, 'README 必须存在「| Skill | … |」表头的 Skills 表格').not.toBeNull();
    const inReadme = cells.sort();

    expect(inReadme, 'README Skills 表格与 skills/*/SKILL.md 漂移').toEqual(onDisk);
  });

  it('每个 skill 目录都有 SKILL.md（无空壳目录）', () => {
    const missing = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !existsSync(join(ROOT, 'skills', e.name, 'SKILL.md')))
      .map((e) => e.name);
    expect(missing, '存在缺 SKILL.md 的 skill 目录').toEqual([]);
  });
});

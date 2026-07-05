import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFrontmatter,
  extractAgentsIndexPaths,
  extractInlineLinkTargets,
  runDoctor,
  renderDoctorReport,
} from './doctor.js';

const FULL_FM = ['---', 'title: 示例', 'status: active', 'updated: 2026-07-03', 'scope: root', '---', '', '# 正文'].join('\n');

/** 四字段齐全、updated 为指定值的 frontmatter 文档。 */
function fmDoc(updated: string): string {
  return ['---', 'title: 示例', 'status: active', `updated: ${updated}`, 'scope: root', '---', '', '# 正文'].join('\n');
}

/** 建临时项目根，写入 files（相对路径 → 内容），回调后清理。 */
function withProject(files: Record<string, string>, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'doctor-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function gitInit(root: string): void {
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 'doctor@test.local');
  run('config', 'user.name', 'doctor-test');
  run('config', 'commit.gpgsign', 'false');
}

/** 以固定 committer 日期提交全部文件（%cs 读的是 committer date）。 */
function gitCommitAll(root: string, date: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` },
  });
}

describe('parseFrontmatter', () => {
  it('extracts key-value pairs from a leading frontmatter block', () => {
    const fm = parseFrontmatter(FULL_FM);
    expect(fm).not.toBeNull();
    expect(Object.keys(fm!)).toEqual(['title', 'status', 'updated', 'scope']);
    expect(fm!.updated).toBe('2026-07-03');
  });
  it('returns null when content does not start with ---', () => {
    expect(parseFrontmatter('# 普通文档\n\n---\ntitle: x\n---\n')).toBeNull();
  });
  it('returns null when the frontmatter block is never closed', () => {
    expect(parseFrontmatter('---\ntitle: x\n')).toBeNull();
  });
  it('strips surrounding quotes from values', () => {
    const fm = parseFrontmatter('---\ntitle: "PRD: 某功能"\n---\n');
    expect(fm!.title).toBe('PRD: 某功能');
  });
});

describe('runDoctor — frontmatter 完整性', () => {
  it('recursively scans docs/ and passes files with all four fields', () => {
    withProject({ 'docs/a.md': FULL_FM, 'docs/sub/b.md': FULL_FM }, (root) => {
      const report = runDoctor(root);
      expect(report.docsFound).toBe(true);
      expect(report.frontmatter!.scanned).toBe(2);
      expect(report.frontmatter!.checked).toBe(2);
      expect(report.frontmatter!.issues).toEqual([]);
    });
  });
  it('reports each file missing required fields, naming the fields', () => {
    const missing = ['---', 'title: 只有标题', 'updated: 2026-07-03', '---'].join('\n');
    withProject({ 'docs/a.md': FULL_FM, 'docs/sub/bad.md': missing }, (root) => {
      const { issues } = runDoctor(root).frontmatter!;
      expect(issues).toHaveLength(1);
      expect(issues[0].file).toBe(join('docs', 'sub', 'bad.md'));
      expect(issues[0].message).toContain('status');
      expect(issues[0].message).toContain('scope');
      expect(issues[0].message).not.toContain('title');
    });
  });
  it('skips .md files without a leading frontmatter block, without issues', () => {
    withProject({ 'docs/README.md': '# 占位\n', 'docs/a.md': FULL_FM }, (root) => {
      const fm = runDoctor(root).frontmatter!;
      expect(fm.scanned).toBe(2);
      expect(fm.checked).toBe(1);
      expect(fm.issues).toEqual([]);
    });
  });
  it('ignores non-markdown files in docs/', () => {
    withProject({ 'docs/a.md': FULL_FM, 'docs/data.json': '{}' }, (root) => {
      expect(runDoctor(root).frontmatter!.scanned).toBe(1);
    });
  });
  it('reports docs/ as missing when the directory does not exist', () => {
    withProject({ 'README.md': '# 无 docs 的项目\n' }, (root) => {
      const report = runDoctor(root);
      expect(report.docsFound).toBe(false);
      expect(report.frontmatter).toBeNull();
    });
  });
});

describe('runDoctor — updated 新鲜度', () => {
  it('flags a file whose git date is beyond the default 30-day threshold', () => {
    withProject({ 'docs/stale.md': fmDoc('2026-01-01') }, (root) => {
      gitInit(root);
      gitCommitAll(root, '2026-03-01'); // 落后 59 天 > 缺省 30
      const fresh = runDoctor(root).freshness!;
      expect(fresh.staleDays).toBe(30);
      expect(fresh.checked).toBe(1);
      expect(fresh.issues).toHaveLength(1);
      expect(fresh.issues[0].file).toBe(join('docs', 'stale.md'));
      expect(fresh.issues[0].message).toContain('2026-01-01');
      expect(fresh.issues[0].message).toContain('2026-03-01');
      expect(fresh.issues[0].message).toContain('59');
    });
  });
  it('passes a file within the default threshold', () => {
    withProject({ 'docs/ok.md': fmDoc('2026-01-01') }, (root) => {
      gitInit(root);
      gitCommitAll(root, '2026-01-20'); // 落后 19 天 ≤ 30
      expect(runDoctor(root).freshness!.issues).toEqual([]);
    });
  });
  it('honours a custom --stale-days threshold, exactly-at-threshold passing', () => {
    withProject({ 'docs/a.md': fmDoc('2026-01-01') }, (root) => {
      gitInit(root);
      gitCommitAll(root, '2026-01-11'); // 落后 10 天
      expect(runDoctor(root, { staleDays: 9 }).freshness!.issues).toHaveLength(1);
      expect(runDoctor(root, { staleDays: 10 }).freshness!.issues).toEqual([]); // 「超过」阈值才算过期
    });
  });
  it('treats any lag as stale when staleDays is 0, but same-day as fresh', () => {
    withProject({ 'docs/a.md': fmDoc('2026-01-01') }, (root) => {
      gitInit(root);
      gitCommitAll(root, '2026-01-02'); // 仅落后 1 天
      expect(runDoctor(root, { staleDays: 0 }).freshness!.issues).toHaveLength(1);
    });
    withProject({ 'docs/b.md': fmDoc('2026-01-02') }, (root) => {
      gitInit(root);
      gitCommitAll(root, '2026-01-02'); // 同一天
      expect(runDoctor(root, { staleDays: 0 }).freshness!.issues).toEqual([]);
    });
  });
  it('reports a malformed updated value even outside git', () => {
    withProject({ 'docs/bad.md': fmDoc('07/01/2026') }, (root) => {
      const fresh = runDoctor(root).freshness!;
      expect(fresh.issues).toHaveLength(1);
      expect(fresh.issues[0].message).toContain('YYYY-MM-DD');
    });
  });
  it('reports a calendar-invalid updated value as malformed', () => {
    withProject({ 'docs/bad.md': fmDoc('2026-13-01') }, (root) => {
      expect(runDoctor(root).freshness!.issues).toHaveLength(1);
    });
  });
  it('skips the git comparison outside a git repository, without issues', () => {
    withProject({ 'docs/old.md': fmDoc('2020-01-01') }, (root) => {
      const fresh = runDoctor(root).freshness!;
      expect(fresh.gitAvailable).toBe(false);
      expect(fresh.checked).toBe(1);
      expect(fresh.issues).toEqual([]);
    });
  });
  it('skips files with no commit history, without issues', () => {
    withProject({ 'docs/new.md': fmDoc('2020-01-01') }, (root) => {
      gitInit(root); // 有仓库但从未提交该文件
      const fresh = runDoctor(root).freshness!;
      expect(fresh.gitAvailable).toBe(true);
      expect(fresh.issues).toEqual([]);
    });
  });
  it('does not count files lacking an updated field toward the freshness check', () => {
    withProject({ 'docs/no-updated.md': '---\ntitle: x\nstatus: active\nscope: root\n---\n' }, (root) => {
      const fresh = runDoctor(root).freshness!;
      expect(fresh.checked).toBe(0);
      expect(fresh.issues).toEqual([]);
    });
  });
});

const AGENTS_MD = [
  '# AGENTS.md',
  '',
  '| 主题 | 路径 | 说明 |',
  '|---|---|---|',
  '| 架构 | `docs/architecture.md` | 地图 |',
  '| 决策 | `docs/decisions/` | ADR |',
  '| 命令 | `npm run dev` | 含空格，非路径 |',
  '',
  '表格外的反引号路径不参与检查：`docs/not-in-table.md`。',
].join('\n');

describe('extractAgentsIndexPaths', () => {
  it('extracts only path-like backtick content from table rows', () => {
    expect(extractAgentsIndexPaths(AGENTS_MD)).toEqual(['docs/architecture.md', 'docs/decisions/']);
  });
  it('dedupes repeated paths and skips flags and version-like tokens', () => {
    const content = '| a | `x/y.md` |\n| b | `x/y.md` 与 `--stale-days` 与 `0.6.0` |';
    expect(extractAgentsIndexPaths(content)).toEqual(['x/y.md']);
  });
  it('ignores a backtick path embedded in descriptive prose, only counting a cell the path occupies alone', () => {
    const content =
      '| 主题 | 路径 | 说明 |\n' +
      '|---|---|---|\n' +
      '| PRD | `docs/prds/` | 意图真相源，`.workspace/prd.json` 由它派生（ADR-003） |';
    expect(extractAgentsIndexPaths(content)).toEqual(['docs/prds/']);
  });
});

describe('extractInlineLinkTargets', () => {
  it('extracts inline link and image targets, not reference-style links', () => {
    const content = '见 [a](a.md) 与 ![图](img/x.png "标题")，以及 [ref][1]。\n[1]: ref.md';
    expect(extractInlineLinkTargets(content)).toEqual(['a.md', 'img/x.png']);
  });
  it('ignores link-like literals inside fenced code blocks and inline code', () => {
    const content = ['```', '[fence](in-fence.md)', '```', '行内 `[code](in-code.md)` 不算链接，[真](real.md)。'].join('\n');
    expect(extractInlineLinkTargets(content)).toEqual(['real.md']);
  });
});

describe('runDoctor — AGENTS.md 索引', () => {
  it('passes when indexed file and directory paths exist', () => {
    withProject(
      {
        'AGENTS.md': AGENTS_MD,
        'docs/architecture.md': FULL_FM,
        'docs/decisions/adr-001.md': '# adr\n',
      },
      (root) => {
        const idx = runDoctor(root).agentsIndex!;
        expect(idx.agentsFound).toBe(true);
        expect(idx.checked).toBe(2); // `npm run dev` 与表格外路径不计
        expect(idx.issues).toEqual([]);
      },
    );
  });
  it('reports each missing indexed path, including directory paths', () => {
    withProject({ 'AGENTS.md': AGENTS_MD, 'docs/a.md': FULL_FM }, (root) => {
      const idx = runDoctor(root).agentsIndex!;
      expect(idx.issues).toHaveLength(2);
      expect(idx.issues[0].file).toBe('AGENTS.md');
      const messages = idx.issues.map((i) => i.message).join('\n');
      expect(messages).toContain('docs/architecture.md');
      expect(messages).toContain('docs/decisions/');
      expect(messages).not.toContain('not-in-table');
      expect(messages).not.toContain('npm run dev');
    });
  });
  it('skips the index check without failing when AGENTS.md is absent', () => {
    withProject({ 'docs/a.md': FULL_FM }, (root) => {
      const idx = runDoctor(root).agentsIndex!;
      expect(idx.agentsFound).toBe(false);
      expect(idx.checked).toBe(0);
      expect(idx.issues).toEqual([]);
    });
  });
  it('does not flag a non-existent path embedded in the description column prose', () => {
    const agentsWithEmbeddedDescPath = [
      '| 主题 | 路径 | 说明 |',
      '|---|---|---|',
      '| PRD | `docs/prds/` | 意图真相源，`.workspace/prd.json` 由它派生（ADR-003） |',
    ].join('\n');
    withProject(
      { 'AGENTS.md': agentsWithEmbeddedDescPath, 'docs/prds/.gitkeep': '' },
      // 注意：故意不创建 .workspace/prd.json —— 它只是说明列散文里内嵌的反引号路径，不是索引项。
      (root) => {
        const idx = runDoctor(root).agentsIndex!;
        expect(idx.checked).toBe(1); // 只有整格独占的 `docs/prds/` 计入
        expect(idx.issues).toEqual([]);
      },
    );
  });
});

describe('runDoctor — 文档相对链接', () => {
  it('passes when relative link targets exist', () => {
    withProject(
      {
        'docs/a.md': `${FULL_FM}\n见 [b](./b.md) 与 [c](sub/c.md)。\n`,
        'docs/b.md': '# b\n',
        'docs/sub/c.md': '# c\n',
      },
      (root) => {
        const links = runDoctor(root).links!;
        expect(links.checked).toBe(2);
        expect(links.issues).toEqual([]);
      },
    );
  });
  it('reports broken links with the containing file and the target', () => {
    withProject({ 'docs/a.md': `${FULL_FM}\n[丢了](missing.md)\n` }, (root) => {
      const links = runDoctor(root).links!;
      expect(links.issues).toHaveLength(1);
      expect(links.issues[0].file).toBe(join('docs', 'a.md'));
      expect(links.issues[0].message).toContain('missing.md');
    });
  });
  it('resolves targets relative to the containing file, not the project root', () => {
    withProject(
      { 'docs/sub/a.md': `${FULL_FM}\n[上级](../b.md)\n`, 'docs/b.md': '# b\n' },
      (root) => {
        expect(runDoctor(root).links!.issues).toEqual([]);
      },
    );
  });
  it('skips http(s) links, pure anchors and absolute paths', () => {
    const body = '\n[外](https://e.com/x) [外2](http://e.com) [锚](#sec) [绝](/etc/hosts)\n';
    withProject({ 'docs/a.md': FULL_FM + body }, (root) => {
      const links = runDoctor(root).links!;
      expect(links.checked).toBe(0);
      expect(links.issues).toEqual([]);
    });
  });
  it('strips the #anchor and checks only the file part', () => {
    withProject(
      { 'docs/a.md': `${FULL_FM}\n[有](b.md#sec) [无](missing.md#sec)\n`, 'docs/b.md': '# b\n' },
      (root) => {
        const links = runDoctor(root).links!;
        expect(links.checked).toBe(2);
        expect(links.issues).toHaveLength(1);
        expect(links.issues[0].message).toContain('missing.md#sec');
      },
    );
  });
  it('does not scan links in files without frontmatter', () => {
    withProject({ 'docs/README.md': '# 占位\n[断](nope.md)\n', 'docs/a.md': FULL_FM }, (root) => {
      const links = runDoctor(root).links!;
      expect(links.checked).toBe(0);
      expect(links.issues).toEqual([]);
    });
  });
});

describe('renderDoctorReport — 输出与退出码', () => {
  it('exits 1 and lists file + missing fields when issues exist', () => {
    withProject({ 'docs/bad.md': '---\ntitle: x\n---\n' }, (root) => {
      const { text, exitCode } = renderDoctorReport(runDoctor(root));
      expect(exitCode).toBe(1);
      expect(text).toContain(join('docs', 'bad.md'));
      expect(text).toContain('status');
      expect(text).toContain('updated');
      expect(text).toContain('scope');
    });
  });
  it('exits 0 with a pass message including the checked file count', () => {
    withProject({ 'docs/a.md': FULL_FM, 'docs/b.md': FULL_FM }, (root) => {
      const { text, exitCode } = renderDoctorReport(runDoctor(root));
      expect(exitCode).toBe(0);
      expect(text).toContain('✅');
      expect(text).toMatch(/2/);
    });
  });
  it('exits 0 and suggests /init-docs when docs/ is missing', () => {
    withProject({}, (root) => {
      const { text, exitCode } = renderDoctorReport(runDoctor(root));
      expect(exitCode).toBe(0);
      expect(text).toContain('/init-docs');
    });
  });
  it('counts stale files into exit code 1 and prints the freshness detail', () => {
    withProject({ 'docs/stale.md': fmDoc('2026-01-01') }, (root) => {
      gitInit(root);
      gitCommitAll(root, '2026-06-01');
      const { text, exitCode } = renderDoctorReport(runDoctor(root));
      expect(exitCode).toBe(1);
      expect(text).toContain('updated 新鲜度');
      expect(text).toContain('落后');
    });
  });
  it('counts a malformed updated value into exit code 1', () => {
    withProject({ 'docs/bad.md': fmDoc('昨天') }, (root) => {
      const { text, exitCode } = renderDoctorReport(runDoctor(root));
      expect(exitCode).toBe(1);
      expect(text).toContain('YYYY-MM-DD');
    });
  });
  it('shows the threshold in the freshness section header', () => {
    withProject({ 'docs/a.md': FULL_FM }, (root) => {
      const { text } = renderDoctorReport(runDoctor(root, { staleDays: 7 }));
      expect(text).toContain('7 天');
    });
  });
  it('counts missing index paths and broken links into exit code 1', () => {
    withProject(
      { 'AGENTS.md': '| x | `docs/gone.md` |', 'docs/a.md': `${FULL_FM}\n[断](nope.md)\n` },
      (root) => {
        const { text, exitCode } = renderDoctorReport(runDoctor(root));
        expect(exitCode).toBe(1);
        expect(text).toContain('docs/gone.md');
        expect(text).toContain('nope.md');
        expect(text).toContain('共发现 2 个问题');
      },
    );
  });
  it('notes the skipped index check when AGENTS.md is absent, still exiting 0', () => {
    withProject({ 'docs/a.md': FULL_FM }, (root) => {
      const { text, exitCode } = renderDoctorReport(runDoctor(root));
      expect(exitCode).toBe(0);
      expect(text).toContain('未找到 AGENTS.md');
    });
  });
  it('shows pass lines for both index and link sections when everything is green', () => {
    withProject(
      {
        'AGENTS.md': '| a | `docs/a.md` |',
        'docs/a.md': `${FULL_FM}\n[b](b.md)\n`,
        'docs/b.md': '# b\n',
      },
      (root) => {
        const { text, exitCode } = renderDoctorReport(runDoctor(root));
        expect(exitCode).toBe(0);
        expect(text).toContain('AGENTS.md 索引');
        expect(text).toContain('文档相对链接');
      },
    );
  });
});

describe('runDoctor quality gate config check', () => {
  it('reports prd missing as skipped (not a failure)', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-gate-'));
    try {
      mkdirSync(join(root, 'docs'));
      const report = runDoctor(root);
      expect(report.gate).toEqual({
        prdPath: join('.workspace', 'prd.json'), prdFound: false, configured: false,
      });
      expect(renderDoctorReport(report).exitCode).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('suggests configuring qualityChecks without failing the check', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-gate-'));
    try {
      mkdirSync(join(root, 'docs'));
      mkdirSync(join(root, '.workspace'));
      writeFileSync(join(root, '.workspace', 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd', userStories: [],
      }));
      const report = runDoctor(root);
      expect(report.gate.prdFound).toBe(true);
      expect(report.gate.configured).toBe(false);
      const { text, exitCode } = renderDoctorReport(report);
      expect(text).toContain('建议在 prd.json 顶层配置 qualityChecks');
      expect(exitCode).toBe(0); // 建议级：不影响退出码
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports configured, honoring a custom workspace, and still works without docs/', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-gate-'));
    try {
      mkdirSync(join(root, 'run'));
      writeFileSync(join(root, 'run', 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd', userStories: [],
        qualityChecks: ['npm test'],
      }));
      // 故意不建 docs/：gate 检查独立于知识库存在与否
      const report = runDoctor(root, { workspace: 'run' });
      expect(report.docsFound).toBe(false);
      expect(report.gate).toEqual({
        prdPath: join('run', 'prd.json'), prdFound: true, configured: true,
      });
      expect(renderDoctorReport(report).text).toContain('机械门禁');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

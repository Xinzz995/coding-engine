import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFrontmatter, runDoctor, renderDoctorReport } from './doctor.js';

const FULL_FM = ['---', 'title: 示例', 'status: active', 'updated: 2026-07-03', 'scope: root', '---', '', '# 正文'].join('\n');

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
});

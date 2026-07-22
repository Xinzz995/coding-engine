import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const command = readFileSync(new URL('../commands/compound-docs.md', import.meta.url), 'utf-8');
const archiveTemplate = readFileSync(
  new URL('../templates/docs/archive-README.md', import.meta.url),
  'utf-8',
);

describe('compound-docs 熵 GC 与物理归档 prompt 合同', () => {
  it('默认增量、全量必须显式触发，并覆盖五类活知识', () => {
    for (const anchor of [
      '增量模式（默认）',
      '全量模式（必须由用户显式触发）',
      '`patterns.md`',
      '`glossary.md`',
      '`architecture.md`',
      '`golden-principles.md`',
      '`prompt-writing.md`',
      '保留',
      '改写',
      '合并',
      '迁位',
      '删除',
      '待拍板',
    ]) expect(command).toContain(anchor);
  });

  it('物理归档有显式授权门、固定路径与 ADR 排除', () => {
    for (const anchor of [
      '物理归档（必须显式授权）',
      '`status` 是 `done` 或 `superseded`',
      '不在 `docs/archive/` 或 `docs/decisions/`',
      '`rejected` 默认保留',
      '`docs/archive/<源 docs 内相对路径>`',
      '目标不存在、无重名覆盖',
      '不在旧路径留重定向 stub、符号链接或内容副本',
      '仓库外书签',
    ]) expect(command).toContain(anchor);
  });

  it('归档后更新索引、重算链接并要求 doctor 验证', () => {
    for (const anchor of [
      'templates/docs/archive-README.md',
      '历史冷档案',
      '重算仓库内所有 Markdown 内联相对链接',
      '承担导航作用',
      'npx coding-x doctor',
      '物理归档清单',
    ]) expect(command).toContain(anchor);
  });

  it('冷档案模板声明按需读取、Git 保留与无旧路径副本', () => {
    for (const anchor of [
      '日常实现、沉淀和熵 GC 默认排除本目录',
      '归档文件继续纳入 Git',
      '旧路径不保留副本或重定向',
    ]) expect(archiveTemplate).toContain(anchor);
  });
});

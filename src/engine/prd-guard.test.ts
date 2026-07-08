import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrdGuard } from './prd-guard.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
  vi.restoreAllMocks();
});

function setup(content?: string): { dir: string; prdPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prd-guard-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const prdPath = join(dir, 'prd.json');
  if (content !== undefined) writeFileSync(prdPath, content);
  return { dir, prdPath };
}

const PRD = JSON.stringify({
  project: 'p', branchName: 'ralph/x', description: 'd',
  qualityChecks: ['npm test'],
  userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: ['原始验收标准'], priority: 1 }],
});

describe('createPrdGuard: 快照建立与一致读取', () => {
  it('第一次成功读取建立快照并返回解析结果', () => {
    const { prdPath } = setup(PRD);
    const guard = createPrdGuard(prdPath);
    const r = guard.read();
    expect(r.prd?.qualityChecks).toEqual(['npm test']);
    expect(r.restoreFailed).toBe(false);
    expect(guard.summary().count).toBe(0);
  });

  it('磁盘未变时重复读取返回快照且不告警', () => {
    const { prdPath } = setup(PRD);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    const r = guard.read();
    expect(r.prd?.project).toBe('p');
    expect(warn).not.toHaveBeenCalled();
  });

  it('启动缺失返回 null；文件出现后顺延建立快照', () => {
    const { prdPath } = setup(); // 不写文件
    const guard = createPrdGuard(prdPath);
    expect(guard.read().prd).toBeNull();
    writeFileSync(prdPath, PRD);
    expect(guard.read().prd?.project).toBe('p');
  });

  it('启动损坏（非法 JSON）返回 null 不建快照，修好后建立', () => {
    const { prdPath } = setup('{ broken');
    const guard = createPrdGuard(prdPath);
    expect(guard.read().prd).toBeNull();
    writeFileSync(prdPath, PRD);
    expect(guard.read().prd?.project).toBe('p');
  });
});

describe('createPrdGuard: 篡改处置', () => {
  it('篡改后 read 返回快照、磁盘被恢复、篡改版被存档', () => {
    const { dir, prdPath } = setup(PRD);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read(); // 建快照
    const tampered = PRD.replace('原始验收标准', '被改弱的标准');
    writeFileSync(prdPath, tampered);
    const r = guard.read();
    expect(r.prd?.userStories[0].acceptanceCriteria).toEqual(['原始验收标准']); // 返回快照
    expect(r.restoreFailed).toBe(false);
    expect(readFileSync(prdPath, 'utf-8')).toBe(PRD); // 磁盘已恢复
    const archived = readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'));
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(dir, archived[0]), 'utf-8')).toBe(tampered); // 存档=篡改版
    expect(warn).toHaveBeenCalled();
    expect(guard.summary().count).toBe(1);
    expect(guard.summary().archives).toHaveLength(1);
  });

  it('同一篡改内容反复出现只存档一次、只告警一次（写回后再次同内容篡改）', () => {
    const { dir, prdPath } = setup(PRD);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    const tampered = PRD.replace('npm test', 'echo skip');
    writeFileSync(prdPath, tampered);
    guard.read(); // 第一次：存档+告警+恢复
    writeFileSync(prdPath, tampered);
    guard.read(); // 同内容再现：不再存档/告警，仍恢复
    expect(readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'))).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('检测到 prd.json'))).toHaveLength(1);
    expect(readFileSync(prdPath, 'utf-8')).toBe(PRD);
    expect(guard.summary().count).toBe(1);
  });

  it('不同篡改内容各自存档、各自计数', () => {
    const { dir, prdPath } = setup(PRD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    writeFileSync(prdPath, PRD.replace('npm test', 'echo a'));
    guard.read();
    writeFileSync(prdPath, PRD.replace('npm test', 'echo b'));
    guard.read();
    expect(readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'))).toHaveLength(2);
    expect(guard.summary().count).toBe(2);
  });

  it('快照建立后文件被删：按篡改处置，恢复文件、无存档（无内容可存）', () => {
    const { dir, prdPath } = setup(PRD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    unlinkSync(prdPath);
    const r = guard.read();
    expect(r.prd?.project).toBe('p');
    expect(r.restoreFailed).toBe(false);
    expect(readFileSync(prdPath, 'utf-8')).toBe(PRD); // 文件被恢复
    expect(readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'))).toHaveLength(0);
    expect(guard.summary().count).toBe(1);
  });

  it('快照建立后文件损坏（非法 JSON）：损坏内容存档、磁盘恢复', () => {
    const { dir, prdPath } = setup(PRD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    writeFileSync(prdPath, '{ broken');
    const r = guard.read();
    expect(r.prd?.project).toBe('p');
    expect(readFileSync(prdPath, 'utf-8')).toBe(PRD);
    const archived = readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'));
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(dir, archived[0]), 'utf-8')).toBe('{ broken');
  });

  it('写回失败时 restoreFailed=true（prd.json 被替换为同名目录）', () => {
    const { prdPath } = setup(PRD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    unlinkSync(prdPath);
    mkdirSync(prdPath); // 同名目录：读抛 EISDIR→按删除篡改；写回 writeFileSync 抛 EISDIR→失败
    const r = guard.read();
    expect(r.prd?.project).toBe('p'); // 引擎自身仍用快照
    expect(r.restoreFailed).toBe(true);
  });
});

describe('createPrdGuard: read().tamperedArchive 三态', () => {
  it('无篡改时为 undefined；新篡改给存档路径；同内容重复篡改回到 undefined', () => {
    const original = JSON.stringify({ project: 'p', userStories: [] });
    const { prdPath } = setup(original);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    expect(guard.read().tamperedArchive).toBeUndefined(); // 建快照

    writeFileSync(prdPath, JSON.stringify({ project: 'evil', userStories: [] }));
    const first = guard.read();
    expect(typeof first.tamperedArchive).toBe('string'); // 新篡改：给存档路径
    expect(first.tamperedArchive).toContain('prd.tampered-');

    writeFileSync(prdPath, JSON.stringify({ project: 'evil', userStories: [] }));
    expect(guard.read().tamperedArchive).toBeUndefined(); // 同内容重复：去重不再报
  });

  it('删除类篡改给 null（有新事件但无存档）', () => {
    const { prdPath } = setup(JSON.stringify({ project: 'p', userStories: [] }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();

    unlinkSync(prdPath);
    const r = guard.read();
    expect(r.tamperedArchive).toBeNull();
  });
});

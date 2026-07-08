import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryReadPrd, type Prd } from '../engine/prd.js';
import { tryReadState, mergedStories, initialStateFor, type StoryView } from '../engine/state.js';
import { readProgress } from '../engine/progress.js';
import { readEvidence, type EvidenceRecord } from '../engine/evidence.js';
import { renderReportHtml } from './render.js';

export interface ScreenshotEntry {
  filename: string;
  /** 归属 story id（null=未归类） */
  storyId: string | null;
  phase: 'builder' | 'validator' | null;
  isImage: boolean;
}

export interface ReportData {
  workspace: string;
  /** 由调用方注入，保持纯函数可测 */
  generatedAt: Date;
  prd: Prd;
  /** mergedStories 合并视图；state 缺失/损坏回退语义与 status/dashboard 一致 */
  stories: StoryView[];
  /** state.json 存在但解析失败——报告内警示 */
  stateCorrupted: boolean;
  progress: string;
  reviews: { filename: string; content: string }[];
  tamperedArchives: string[];
  screenshots: ScreenshotEntry[];
  /** evidence.jsonl 结构化证据（缺失=空记录零跳过） */
  evidence: { records: EvidenceRecord[]; skippedLines: number };
}

export type ReportSource =
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string }
  | { status: 'ok'; data: ReportData };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

// 只读一层、只收常规文件；目录不存在/不可读一律按空处理（报告容错：有什么记什么）
function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

// 截图命名实测两类形态：builder-US-008-6.png / validator-us-008-pass-1.png / validator-us-008-export.pdf
// ——序号尾缀与语义尾缀并存，解析以 story id 段为锚（剥相位前缀后，某 id 恰为余段或其 '-' 前缀），
// 大小写不敏感；多 id 命中取最长（防 US-1 抢走 US-10 的文件）。
export function parseScreenshotEntry(filename: string, storyIds: string[]): ScreenshotEntry {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const m = /^(builder|validator)-(.+)\.[^.]+$/i.exec(filename);
  if (!m) return { filename, storyId: null, phase: null, isImage };
  const phase = m[1].toLowerCase() as 'builder' | 'validator';
  const rest = m[2].toLowerCase();
  let hit: string | null = null;
  for (const id of storyIds) {
    const idl = id.toLowerCase();
    if ((rest === idl || rest.startsWith(idl + '-')) && (hit === null || id.length > hit.length)) hit = id;
  }
  return { filename, storyId: hit, phase, isImage };
}

export function collectReport(workspace: string, now: Date): ReportSource {
  const prdPath = join(workspace, 'prd.json');
  if (!existsSync(prdPath)) return { status: 'missing', workspace };
  const prd = tryReadPrd(prdPath);
  if (prd === null || !Array.isArray(prd.userStories)) return { status: 'unparsable', workspace };
  const statePath = join(workspace, 'state.json');
  const stateExists = existsSync(statePath);
  const rawState = stateExists ? tryReadState(statePath) : null;
  const state = rawState ?? initialStateFor(prd);
  const rootFiles = listFiles(workspace);
  const reviews: { filename: string; content: string }[] = [];
  for (const filename of rootFiles.filter((n) => /^review-.*\.md$/.test(n)).sort()) {
    try {
      reviews.push({ filename, content: readFileSync(join(workspace, filename), 'utf-8') });
    } catch { /* 单文件读取失败跳过——容错：有什么记什么 */ }
  }
  const storyIds = prd.userStories.map((s) => s.id);
  return {
    status: 'ok',
    data: {
      workspace,
      generatedAt: now,
      prd,
      stories: mergedStories(prd, state),
      stateCorrupted: stateExists && rawState === null,
      progress: readProgress(join(workspace, 'progress.md')),
      reviews,
      tamperedArchives: rootFiles.filter((n) => /^prd\.tampered-.*\.json$/.test(n)).sort(),
      screenshots: listFiles(join(workspace, 'screenshots')).sort().map((f) => parseScreenshotEntry(f, storyIds)),
      evidence: readEvidence(workspace),
    },
  };
}

export type WriteReportResult =
  | { status: 'written'; path: string }
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string };

/**
 * 编排：collect → render → 落盘 <workspace>/report.html（幂等覆盖）。
 * missing/unparsable 原样透传不写盘；写盘 IO 失败向上抛——调用方定语义
 * （cli 退出 1 / loop 仅 warn，报告是副产物绝不影响循环结果）。
 */
export function writeReport(workspace: string, now: Date): WriteReportResult {
  const source = collectReport(workspace, now);
  if (source.status !== 'ok') return source;
  const path = join(workspace, 'report.html');
  writeFileSync(path, renderReportHtml(source.data), 'utf-8');
  return { status: 'written', path };
}

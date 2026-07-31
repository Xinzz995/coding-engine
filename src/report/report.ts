import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { tryReadPrd, type Prd } from '../engine/prd.js';
import { readDisplayState, mergedStories, type StoryView } from '../engine/state.js';
import { writeFileAtomicSync } from '../engine/fs-atomic.js';
import { readProgress } from '../engine/progress.js';
import { readEvidence, type EvidenceRecord } from '../engine/evidence.js';
import { readFinalReviewState } from '../review/state.js';
import type { CurrentReviewStatus } from '../review/status.js';
import { renderReportHtml } from './render.js';
import type { WorkspaceWriter } from '../workspace-safety/session.js';

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
  /** PRD 信任来源：手动 report 读磁盘；引擎收口使用启动时冻结快照。 */
  prdSource: 'disk' | 'engine-snapshot';
  /** mergedStories 合并视图；state 缺失兼容 legacy，损坏则全部按未验证处理。 */
  stories: StoryView[];
  /** state.json 存在但解析失败——报告内警示 */
  stateCorrupted: boolean;
  progress: string;
  reviews: { filename: string; content: string }[];
  tamperedArchives: string[];
  screenshots: ScreenshotEntry[];
  /** evidence.jsonl 结构化证据（缺失=空记录零跳过） */
  evidence: { records: EvidenceRecord[]; skippedLines: number };
  /**
   * 本地最终 Review 及其生成报告时的当前性判断；报告只展示，不把 workspace 当共享凭证。
   * 没有调用方提供的可信当前性观察时，即使磁盘上保存了 passed，也必须按过期处理。
   */
  finalReview: CurrentReviewStatus;
}

export type ReportSource =
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string }
  | { status: 'ok'; data: ReportData };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export interface ReportOptions {
  /** 仅供已经建立信任边界的引擎调用方注入；提供后不再读取磁盘 prd.json。 */
  trustedPrd?: Prd;
  /**
   * 调用方在受控边界内完成的当前性观察。collectReport 会再次读取最终 Review，
   * 只有两者完全一致才采用，避免观察后 workspace 被另一轮操作替换。
   */
  currentReview?: CurrentReviewStatus;
}

function reportReviewStatus(
  read: ReturnType<typeof readFinalReviewState>,
  observed: CurrentReviewStatus | undefined,
): CurrentReviewStatus {
  if (observed !== undefined && isDeepStrictEqual(observed.read, read)) return observed;
  return {
    read,
    current: false,
    staleReasons:
      read.status === 'ready'
        ? [
            observed === undefined
              ? '生成报告时未重新核验最终 Review 当前性'
              : '当前性核验后最终 Review 状态已变化',
          ]
        : [],
  };
}

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

export function collectReport(workspace: string, now: Date, options: ReportOptions = {}): ReportSource {
  const prdPath = join(workspace, 'prd.json');
  const prdSource = options.trustedPrd === undefined ? 'disk' : 'engine-snapshot';
  if (prdSource === 'disk' && !existsSync(prdPath)) return { status: 'missing', workspace };
  const prd = options.trustedPrd ?? tryReadPrd(prdPath);
  if (prd === null || !Array.isArray(prd.userStories)) return { status: 'unparsable', workspace };
  const statePath = join(workspace, 'state.json');
  const { state, stateCorrupted } = readDisplayState(statePath, prd);
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
      prdSource,
      stories: mergedStories(prd, state),
      stateCorrupted,
      progress: readProgress(join(workspace, 'progress.md')),
      reviews,
      tamperedArchives: rootFiles.filter((n) => /^prd\.tampered-.*\.json$/.test(n)).sort(),
      screenshots: listFiles(join(workspace, 'screenshots')).sort().map((f) => parseScreenshotEntry(f, storyIds)),
      evidence: readEvidence(workspace),
      finalReview: reportReviewStatus(readFinalReviewState(workspace), options.currentReview),
    },
  };
}

export type WriteReportResult =
  | { status: 'written'; path: string; stateCorrupted: boolean }
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string };

const REPORT_FILE = 'report.html';

/**
 * @deprecated 仅供激活前旧控制流、CLI 与同步单元测试使用。正式控制流必须使用
 * writeReportWithWriter，不得拿裸 workspace 写报告。
 *
 * 编排：collect → render → 落盘 <workspace>/report.html（幂等覆盖）。
 * missing/unparsable 原样透传不写盘；写盘 IO 失败向上抛——调用方定语义
 * （cli 退出 1 / loop 仅 warn，报告是副产物绝不影响循环结果）。
 */
export function writeReport(workspace: string, now: Date, options: ReportOptions = {}): WriteReportResult {
  const source = collectReport(workspace, now, options);
  if (source.status !== 'ok') return source;
  const path = join(workspace, REPORT_FILE);
  writeFileAtomicSync(path, renderReportHtml(source.data));
  return { status: 'written', path, stateCorrupted: source.data.stateCorrupted };
}

/**
 * 编排：collect → render → 由当前 owner 覆盖固定的 report.html。
 * missing/unparsable 保持纯只读结果；任何写入错误完整向上抛。
 */
export async function writeReportWithWriter(
  writer: WorkspaceWriter,
  now: Date,
  options: ReportOptions = {},
): Promise<WriteReportResult> {
  const workspace = writer.workspacePath;
  const source = collectReport(workspace, now, options);
  if (source.status !== 'ok') return source;
  const path = join(workspace, REPORT_FILE);
  await writer.writeFile(REPORT_FILE, renderReportHtml(source.data));
  return { status: 'written', path, stateCorrupted: source.data.stateCorrupted };
}

import { existsSync, lstatSync, opendirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tryReadPrd, validatePrdStoryDefinitions, type Prd } from '../engine/prd.js';
import {
  readDisplayState,
  mergedStories,
  validationReceiptsDigest,
  type StoryView,
} from '../engine/state.js';
import { writeFileAtomicSync } from '../engine/fs-atomic.js';
import { readSafeControlFileUtf8Sync } from '../engine/safe-control-file.js';
import {
  assertRegisteredWorkspacePath,
  assertWorkspaceDirectory,
  freezeWorkspaceDirectory,
} from '../engine/workspace-identity.js';
import { readProgress } from '../engine/progress.js';
import { readEvidence, type EvidenceRecord } from '../engine/evidence.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { collectCurrentReviewStatus, type CurrentReviewStatus } from '../review/status.js';
import { readGitHead } from '../engine/validation-protocol.js';
import { digest, reviewRoutingDigest } from '../review/common.js';
import { freezeReviewDecisions, readFinalReviewState } from '../review/state.js';
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
  /** 最终 Review 经当前 PR、规则、远端检查与 Story 凭证重新核对后的状态。 */
  finalReview: CurrentReviewStatus;
  currentGitHead: string | null;
  storyValidationDigest: string | null;
}

export type ReportSource =
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string }
  | { status: 'ok'; data: ReportData };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const REVIEW_MARKDOWN_MAX_BYTES = 4 * 1024 * 1024;
const REPORT_DIRECTORY_ENTRY_LIMIT = 4_096;

export interface ReportOptions {
  /** 仅供已经建立信任边界的引擎调用方注入；提供后不再读取磁盘 prd.json。 */
  trustedPrd?: Prd;
  /** 用于核对 Story Validator 凭证是否仍绑定当前提交。 */
  projectRoot?: string;
  /** GitHub 只读适配器；主要用于测试，生产默认使用 gh。 */
  client?: GitHubQualityClient;
  /** 测试注入点；生产始终使用真实的最终 Review 当前性收集器。 */
  reviewCollector?: typeof collectCurrentReviewStatus;
}

type ReportLocalSnapshot = {
  prd: Prd;
  currentGitHead: string | null;
  display: ReturnType<typeof readDisplayState>;
  finalReviewIdentity: string;
  reviewDecisionsIdentity: string;
};

function localReviewFileIdentities(workspace: string): {
  finalReviewIdentity: string;
  reviewDecisionsIdentity: string;
} {
  const finalReview = readFinalReviewState(workspace);
  let reviewDecisionsIdentity: string;
  try {
    reviewDecisionsIdentity = freezeReviewDecisions(workspace).digest;
  } catch (error) {
    reviewDecisionsIdentity = digest({
      status: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    finalReviewIdentity: digest(finalReview),
    reviewDecisionsIdentity,
  };
}

function readReportLocalSnapshot(options: {
  trustedPrd?: Prd;
  prdPath: string;
  statePath: string;
  projectRoot: string;
}): ReportLocalSnapshot | null {
  // 引擎自动收口时，PRD guard 的冻结快照仍是唯一可信需求；磁盘 PRD 即使
  // 在报告收集期间变化，也不能替换已经用于本轮执行与 Review 的输入。
  const prd = options.trustedPrd ?? tryReadPrd(options.prdPath);
  if (prd === null || !validatePrdStoryDefinitions(prd).ok) return null;
  const currentGitHead = readGitHead(options.projectRoot);
  return {
    prd,
    currentGitHead,
    display: readDisplayState(options.statePath, prd, currentGitHead),
    ...localReviewFileIdentities(dirname(options.prdPath)),
  };
}

function reportSnapshotChangeReasons(
  before: ReportLocalSnapshot,
  after: ReportLocalSnapshot,
): string[] {
  const reasons: string[] = [];
  if (digest(before.prd) !== digest(after.prd)) {
    reasons.push('报告收集期间 PRD 已变化；已使用最终快照');
  }
  if (reviewRoutingDigest(before.prd.models) !== reviewRoutingDigest(after.prd.models)) {
    reasons.push('报告收集期间 PRD 模型路由已变化；已使用最终快照');
  }
  if (before.currentGitHead !== after.currentGitHead) {
    reasons.push('报告收集期间 Git HEAD 已变化；已使用最终快照');
  }
  if (
    digest(before.display.state) !== digest(after.display.state) ||
    before.display.stateCorrupted !== after.display.stateCorrupted
  ) {
    reasons.push('报告收集期间 Story 状态已变化；已使用最终快照');
  }
  if (before.finalReviewIdentity !== after.finalReviewIdentity) {
    reasons.push('报告收集期间本地最终 Review 状态已变化');
  }
  if (before.reviewDecisionsIdentity !== after.reviewDecisionsIdentity) {
    reasons.push('报告收集期间 Review 裁决记录已变化');
  }
  return reasons;
}

function invalidateReviewForSnapshotChanges(
  review: CurrentReviewStatus,
  reasons: string[],
): CurrentReviewStatus {
  if (reasons.length === 0) return review;
  return {
    ...review,
    current: false,
    staleReasons: [...new Set([...review.staleReasons, ...reasons])],
  };
}

// 只读一层、只收常规文件；目录不存在/不可读一律按空处理（报告容错：有什么记什么）
function listFiles(dir: string): string[] {
  let handle: ReturnType<typeof opendirSync> | null = null;
  try {
    const workspaceIdentity = assertRegisteredWorkspacePath(dir);
    const before = lstatSync(dir, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) return [];
    handle = opendirSync(dir);
    const files: string[] = [];
    let count = 0;
    let exceeded = false;
    let entry = handle.readSync();
    while (entry !== null) {
      count += 1;
      if (count > REPORT_DIRECTORY_ENTRY_LIMIT) {
        exceeded = true;
        break;
      }
      if (entry.isFile()) files.push(entry.name);
      entry = handle.readSync();
    }
    const after = lstatSync(dir, { bigint: true });
    if (
      exceeded ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      return [];
    }
    if (workspaceIdentity) assertWorkspaceDirectory(workspaceIdentity);
    return files;
  } catch {
    return [];
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // 报告素材是展示信道；关闭失败时保持容错语义。
    }
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
    if ((rest === idl || rest.startsWith(idl + '-')) && (hit === null || id.length > hit.length))
      hit = id;
  }
  return { filename, storyId: hit, phase, isImage };
}

export function collectReport(
  workspace: string,
  now: Date,
  options: ReportOptions = {},
): ReportSource {
  if (!existsSync(workspace)) return { status: 'missing', workspace };
  freezeWorkspaceDirectory(workspace);
  const prdPath = join(workspace, 'prd.json');
  const prdSource = options.trustedPrd === undefined ? 'disk' : 'engine-snapshot';
  if (prdSource === 'disk' && !existsSync(prdPath)) return { status: 'missing', workspace };
  const statePath = join(workspace, 'state.json');
  const projectRoot = options.projectRoot ?? process.cwd();
  const initialSnapshot = readReportLocalSnapshot({
    ...(options.trustedPrd ? { trustedPrd: options.trustedPrd } : {}),
    prdPath,
    statePath,
    projectRoot,
  });
  if (initialSnapshot === null) return { status: 'unparsable', workspace };
  const initialStoryValidationDigest = validationReceiptsDigest(
    initialSnapshot.prd,
    initialSnapshot.display.state,
    initialSnapshot.currentGitHead,
  );
  const localReviewIdentity = () => {
    const snapshot = readReportLocalSnapshot({
      ...(options.trustedPrd ? { trustedPrd: options.trustedPrd } : {}),
      prdPath,
      statePath,
      projectRoot,
    });
    if (snapshot === null) {
      throw new Error('prd.json 当前不可解析');
    }
    if (snapshot.display.stateCorrupted) throw new Error('state.json 当前不可验证');
    return {
      storyValidationDigest: validationReceiptsDigest(
        snapshot.prd,
        snapshot.display.state,
        snapshot.currentGitHead,
      ),
      reviewRoutingDigest: reviewRoutingDigest(snapshot.prd.models),
    };
  };
  const rootFiles = listFiles(workspace);
  const reviews: { filename: string; content: string }[] = [];
  for (const filename of rootFiles.filter((n) => /^review-.*\.md$/.test(n)).sort()) {
    try {
      const content = readSafeControlFileUtf8Sync(join(workspace, filename), {
        maxBytes: REVIEW_MARKDOWN_MAX_BYTES,
      });
      if (content !== null) reviews.push({ filename, content });
    } catch {
      /* 单文件读取失败跳过——容错：有什么记什么 */
    }
  }
  const collectedReview = (options.reviewCollector ?? collectCurrentReviewStatus)({
    workspace,
    projectRoot,
    storyValidationDigest: initialStoryValidationDigest,
    reviewRoutingDigest: reviewRoutingDigest(initialSnapshot.prd.models),
    localIdentity: localReviewIdentity,
    ...(options.client ? { client: options.client } : {}),
    refreshRemote: true,
  });
  const finalSnapshot = readReportLocalSnapshot({
    ...(options.trustedPrd ? { trustedPrd: options.trustedPrd } : {}),
    prdPath,
    statePath,
    projectRoot,
  });
  if (finalSnapshot === null) return { status: 'unparsable', workspace };
  const snapshotChanges = reportSnapshotChangeReasons(initialSnapshot, finalSnapshot);
  const finalReview = invalidateReviewForSnapshotChanges(collectedReview, snapshotChanges);
  const { state, stateCorrupted } = finalSnapshot.display;
  const prd = finalSnapshot.prd;
  const currentGitHead = finalSnapshot.currentGitHead;
  const storyValidationDigest = validationReceiptsDigest(prd, state, currentGitHead);
  const storyIds = prd.userStories.map((s) => s.id);
  let evidence: ReturnType<typeof readEvidence>;
  try {
    evidence = readEvidence(workspace);
  } catch {
    // evidence 是展示信道，不得因 FIFO、软链、超限或损坏阻塞/改变质量裁决。
    evidence = { records: [], skippedLines: 1 };
  }
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
      screenshots: listFiles(join(workspace, 'screenshots'))
        .sort()
        .map((f) => parseScreenshotEntry(f, storyIds)),
      evidence,
      finalReview,
      currentGitHead,
      storyValidationDigest,
    },
  };
}

export type WriteReportResult =
  | { status: 'written'; path: string; stateCorrupted: boolean }
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string };

/**
 * 编排：collect → render → 落盘 <workspace>/report.html（幂等覆盖）。
 * missing/unparsable 原样透传不写盘；写盘 IO 失败向上抛——调用方定语义
 * （cli 退出 1 / loop 仅 warn，报告是副产物绝不影响循环结果）。
 */
export function writeReport(
  workspace: string,
  now: Date,
  options: ReportOptions = {},
): WriteReportResult {
  const source = collectReport(workspace, now, options);
  if (source.status !== 'ok') return source;
  const path = join(workspace, 'report.html');
  writeFileAtomicSync(path, renderReportHtml(source.data));
  return { status: 'written', path, stateCorrupted: source.data.stateCorrupted };
}

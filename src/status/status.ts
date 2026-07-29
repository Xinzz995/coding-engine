import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tryReadPrd, validatePrdStoryDefinitions, type Prd } from '../engine/prd.js';
import {
  readDisplayState,
  mergedStories,
  getCurrentStoryId,
  type StoryView,
  isStoryPassed,
  validationReceiptsDigest,
  type ValidationReceiptInvalidation,
} from '../engine/state.js';
import { readGitHead } from '../engine/validation-protocol.js';
import { readProgress } from '../engine/progress.js';
import { isArbitrationLine } from '../engine/gate.js';
import {
  readEvidence,
  type AgentInvocationEvidence,
  type EvidenceRecord,
  type ValidationTargetEvidence,
  type LoopValidationProtocolErrorCode,
} from '../engine/evidence.js';
import {
  readModelRouting,
  type ModelRouteSource,
  type ModelRoutingReadResult,
} from '../engine/models.js';
import { collectCurrentReviewStatus, type CurrentReviewStatus } from '../review/status.js';
import { digest, reviewRoutingDigest } from '../review/common.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { freezeReviewDecisions, readFinalReviewState } from '../review/state.js';
import {
  assertWorkspaceDirectory,
  freezeWorkspaceDirectory,
} from '../engine/workspace-identity.js';

export interface RecentModelRoute {
  model: string | null;
  source: ModelRouteSource | null;
  iteration: number;
  outcome?: 'completed' | 'timeout' | 'error';
  invocation?: AgentInvocationEvidence;
}

export interface StoryRecentActual {
  builder?: RecentModelRoute;
  validator?: RecentModelRoute;
}

export interface StoryRecentValidation {
  protocol: 'passed' | 'failed' | 'invalid';
  iteration: number;
  target?: ValidationTargetEvidence;
  error?: { code: LoopValidationProtocolErrorCode; diagnostic: string };
  stateMutation: boolean;
}

export type StatusReport =
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string }
  | {
      status: 'ok';
      prd: Prd;
      stories: StoryView[];
      currentStoryId: string | null;
      latestProgress: string | null;
      modelRouting: ModelRoutingReadResult;
      recentActual: Record<string, StoryRecentActual>;
      recentValidation: Record<string, StoryRecentValidation>;
      evidenceSkippedLines: number;
      evidenceUnavailable: boolean;
      /** state.json 存在但解析失败/形状非法；缺失是正常回退，不算损坏 */
      stateCorrupted: boolean;
      validationInvalidations: ValidationReceiptInvalidation[];
      finalReview: CurrentReviewStatus;
    };

type StatusLocalSnapshot = {
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

function readStatusLocalSnapshot(
  prdPath: string,
  statePath: string,
  projectRoot: string,
): StatusLocalSnapshot | null {
  const prd = tryReadPrd(prdPath);
  if (prd === null || !validatePrdStoryDefinitions(prd).ok) return null;
  const currentGitHead = readGitHead(projectRoot);
  return {
    prd,
    currentGitHead,
    display: readDisplayState(statePath, prd, currentGitHead),
    ...localReviewFileIdentities(dirname(prdPath)),
  };
}

function statusSnapshotChangeReasons(
  before: StatusLocalSnapshot,
  after: StatusLocalSnapshot,
): string[] {
  const reasons: string[] = [];
  if (digest(before.prd) !== digest(after.prd)) {
    reasons.push('状态收集期间 PRD 已变化；已使用最终快照');
  }
  if (reviewRoutingDigest(before.prd.models) !== reviewRoutingDigest(after.prd.models)) {
    reasons.push('状态收集期间 PRD 模型路由已变化；已使用最终快照');
  }
  if (before.currentGitHead !== after.currentGitHead) {
    reasons.push('状态收集期间 Git HEAD 已变化；已使用最终快照');
  }
  if (
    digest(before.display.state) !== digest(after.display.state) ||
    before.display.stateCorrupted !== after.display.stateCorrupted
  ) {
    reasons.push('状态收集期间 Story 状态已变化；已使用最终快照');
  }
  if (before.finalReviewIdentity !== after.finalReviewIdentity) {
    reasons.push('状态收集期间本地最终 Review 状态已变化');
  }
  if (before.reviewDecisionsIdentity !== after.reviewDecisionsIdentity) {
    reasons.push('状态收集期间 Review 裁决记录已变化');
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

// progress.md 是追加式日志，迭代记录标题固定以日期开头（`## yyyy-mm-dd HH:mm - Story ID`），
// 按日期前缀匹配以排除 `## Codebase Patterns` 等非记录标题；最后一条即最近一次迭代
function latestProgressTitle(progress: string): string | null {
  const records = progress.split('\n').filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l));
  const last = records.at(-1);
  return last ? last.slice(3).trim() : null;
}

function recentActualOf(records: EvidenceRecord[]): Record<string, StoryRecentActual> {
  const recent: Record<string, StoryRecentActual> = {};
  for (const record of records) {
    if (record.type !== 'iteration' || record.storyId === null) continue;
    const current = recent[record.storyId] ?? {};
    if (record.builderRan) {
      current.builder = {
        model: record.builderModel,
        source: record.builderRouteSource ?? null,
        iteration: record.iteration,
        ...(record.builderOutcome ? { outcome: record.builderOutcome } : {}),
        ...(record.builderInvocation ? { invocation: record.builderInvocation } : {}),
      };
    }
    if (record.validatorRan) {
      current.validator = {
        model: record.validatorModel,
        source: record.validatorRouteSource ?? null,
        iteration: record.iteration,
        ...(record.validatorOutcome && record.validatorOutcome !== 'skipped'
          ? { outcome: record.validatorOutcome }
          : {}),
        ...(record.validatorInvocation ? { invocation: record.validatorInvocation } : {}),
      };
    }
    recent[record.storyId] = current;
  }
  return recent;
}

function recentValidationOf(records: EvidenceRecord[]): Record<string, StoryRecentValidation> {
  const recent: Record<string, StoryRecentValidation> = {};
  for (const record of records) {
    if (record.type !== 'iteration' || record.storyId === null || !record.validationProtocol)
      continue;
    recent[record.storyId] = {
      protocol: record.validationProtocol,
      iteration: record.iteration,
      ...(record.validationTarget ? { target: record.validationTarget } : {}),
      ...(record.validationProtocolError ? { error: record.validationProtocolError } : {}),
      stateMutation: record.validatorStateMutation === true,
    };
  }
  return recent;
}

/** 只读收集 workspace 执行状态；state.json 缺失兼容 legacy，存在但损坏则 fail-closed。 */
export function collectStatus(
  workspace: string,
  options: {
    projectRoot?: string;
    client?: GitHubQualityClient;
    refreshRemote?: boolean;
    /** 测试注入点；生产始终使用真实的最终 Review 当前性收集器。 */
    reviewCollector?: typeof collectCurrentReviewStatus;
  } = {},
): StatusReport {
  const prdPath = join(workspace, 'prd.json');
  if (!existsSync(prdPath)) return { status: 'missing', workspace };
  let workspaceIdentity: ReturnType<typeof freezeWorkspaceDirectory>;
  try {
    workspaceIdentity = freezeWorkspaceDirectory(workspace);
  } catch {
    return { status: 'unparsable', workspace };
  }
  const statePath = join(workspace, 'state.json');
  const projectRoot = options.projectRoot ?? process.cwd();
  const initialSnapshot = readStatusLocalSnapshot(prdPath, statePath, projectRoot);
  // userStories 非数组的 prd.json 对 status 同样不可用，与 JSON 解析失败同等对待
  if (initialSnapshot === null) return { status: 'unparsable', workspace };
  const initialStoryValidationDigest = validationReceiptsDigest(
    initialSnapshot.prd,
    initialSnapshot.display.state,
    initialSnapshot.currentGitHead,
  );
  const localReviewIdentity = () => {
    const snapshot = readStatusLocalSnapshot(prdPath, statePath, projectRoot);
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
  let evidence: ReturnType<typeof readEvidence> = { records: [], skippedLines: 0 };
  let evidenceUnavailable = false;
  try {
    evidence = readEvidence(workspace);
  } catch {
    evidenceUnavailable = true;
  }
  const collectedReview = (options.reviewCollector ?? collectCurrentReviewStatus)({
    workspace,
    ...(options.projectRoot ? { projectRoot } : {}),
    storyValidationDigest: initialStoryValidationDigest,
    reviewRoutingDigest: reviewRoutingDigest(initialSnapshot.prd.models),
    localIdentity: localReviewIdentity,
    ...(options.client ? { client: options.client } : {}),
    refreshRemote: options.refreshRemote ?? false,
  });
  const finalSnapshot = readStatusLocalSnapshot(prdPath, statePath, projectRoot);
  if (finalSnapshot === null) return { status: 'unparsable', workspace };
  try {
    assertWorkspaceDirectory(workspaceIdentity);
  } catch {
    return { status: 'unparsable', workspace };
  }
  const snapshotChanges = statusSnapshotChangeReasons(initialSnapshot, finalSnapshot);
  const finalReview = invalidateReviewForSnapshotChanges(collectedReview, snapshotChanges);
  const { state, stateCorrupted, validationInvalidations } = finalSnapshot.display;
  const prd = finalSnapshot.prd;
  return {
    status: 'ok',
    prd,
    stories: mergedStories(prd, state),
    currentStoryId: getCurrentStoryId(prd, state),
    latestProgress: latestProgressTitle(readProgress(join(workspace, 'progress.md'))),
    modelRouting: readModelRouting(prd),
    recentActual: recentActualOf(evidence.records),
    recentValidation: recentValidationOf(evidence.records),
    evidenceSkippedLines: evidence.skippedLines,
    evidenceUnavailable,
    stateCorrupted,
    validationInvalidations,
    finalReview,
  };
}

function summarize(stories: StoryView[]): { total: number; passed: number; blocked: number } {
  return {
    total: stories.length,
    passed: stories.filter(isStoryPassed).length,
    blocked: stories.filter((s) => s.blocked).length,
  };
}

function markOf(s: StoryView): string {
  return isStoryPassed(s) ? '✅' : s.blocked ? '⛔' : s.passes ? '🟨' : '⬜';
}

function diagnosticSummary(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= 240 ? singleLine : `…${singleLine.slice(-239)}`;
}

export function renderStatusReport(report: StatusReport): { text: string; exitCode: number } {
  if (report.status === 'missing') {
    return {
      text: `❌ 未找到工作区：${join(report.workspace, 'prd.json')} 不存在。建议先用 prd-to-json 从源 PRD 生成工作区。`,
      exitCode: 2,
    };
  }
  if (report.status === 'unparsable') {
    return {
      text: `❌ 无法解析 ${join(report.workspace, 'prd.json')}。建议运行 npx coding-x repair 修复后重试。`,
      exitCode: 2,
    };
  }
  const { prd, stories } = report;
  const { total, passed, blocked } = summarize(stories);
  const lines: string[] = [
    `📋 ${prd.project}（分支 ${prd.branchName}）`,
    `   story 通过 ${passed}/${total}${blocked > 0 ? `，阻塞 ${blocked}` : ''}`,
    '',
  ];
  const review = report.finalReview;
  if (review.read.status === 'missing') {
    lines.push('🔎 本地最终 Review：尚未运行', '');
  } else if (review.read.status === 'unsupported') {
    lines.push(
      `⏳ 本地最终 Review：旧格式 v${review.read.schemaVersion} 已失效`,
      '   请重新运行 coding-x 生成当前格式的 Review 结果',
      '',
    );
  } else if (review.read.status === 'invalid') {
    lines.push(`❌ 本地最终 Review 状态损坏：${review.read.error}`, '');
  } else {
    const state = review.read.state;
    const remote = review.refreshedRemote ?? state.remote;
    lines.push(
      `🔎 本地最终 Review：${review.current ? state.status : '已失效'}`,
      `   绑定 PR #${state.binding.prNumber} · head=${state.binding.headSha.slice(0, 12)} · ` +
        `${state.binding.runner}/${state.binding.model}`,
      `   GitHub 交付：${remote.status}${state.shadow ? ' · shadow' : ''}`,
      ...review.staleReasons.map((reason) => `   ⚠️ ${reason}`),
      '',
    );
  }
  if (report.modelRouting.status === 'enabled') {
    const m = report.modelRouting.config;
    lines.push(
      `🧭 模型路由（${m.runner}）`,
      `   builder low=${m.builder.low} · medium=${m.builder.medium} · high=${m.builder.high}`,
      `   validator=${m.validator} · escalation=${m.escalation}`,
      '',
    );
  } else if (report.modelRouting.status === 'invalid') {
    lines.push('⚠️  模型路由配置无效：', ...report.modelRouting.errors.map((e) => `   · ${e}`), '');
  } else {
    lines.push('🧭 PRD 模型路由：未启用', '');
  }
  for (const s of stories) {
    const retry = s.retryCount > 0 ? `（已重试 ${s.retryCount} 次）` : '';
    const difficulty = s.difficulty ? ` [${s.difficulty}]` : '';
    const escalated = s.escalated ? ' ⬆️ 已升级' : '';
    const pendingValidationLabel =
      !s.blocked && s.passes && !isStoryPassed(s) ? ' ⏳ 实现候选待验收' : '';
    lines.push(
      `  ${markOf(s)} ${s.id} ${s.title}${difficulty}${escalated}${pendingValidationLabel}${retry}`,
    );
    if (s.difficultyReason) lines.push(`      · 难度依据：${s.difficultyReason}`);
    const actual = report.recentActual[s.id];
    if (actual?.builder || actual?.validator) {
      const route = (side: RecentModelRoute | undefined) =>
        side
          ? `${side.model ?? '默认'} [${side.source ?? '来源未知'}]@第${side.iteration}轮` +
            `${side.outcome ? ` · ${side.outcome}` : ''}` +
            `${side.invocation ? ` · ${(side.invocation.durationMs / 1000).toFixed(1)}s` : ''}` +
            `${
              side.invocation?.exitCode !== undefined
                ? ` · exit=${side.invocation.exitCode ?? 'unavailable'}`
                : ''
            }`
          : '无';
      lines.push(
        `      · 最近实际：builder=${route(actual.builder)} · validator=${route(actual.validator)}`,
      );
      if (actual.builder?.invocation?.diagnosticTail) {
        lines.push(
          `      ⚠️ builder 诊断：${diagnosticSummary(actual.builder.invocation.diagnosticTail)}`,
        );
      }
      if (actual.validator?.invocation?.diagnosticTail) {
        lines.push(
          `      ⚠️ validator 诊断：${diagnosticSummary(actual.validator.invocation.diagnosticTail)}`,
        );
      }
    }
    const recentValidation = report.recentValidation[s.id];
    if (recentValidation) {
      const target = recentValidation.target
        ? ` · AC=${recentValidation.target.acceptanceHash.slice(0, 15)}… · Git=${recentValidation.target.gitHead?.slice(0, 12) ?? 'unavailable'}`
        : '';
      if (recentValidation.protocol === 'invalid') {
        const reason = recentValidation.error
          ? `${recentValidation.error.code}：${recentValidation.error.diagnostic}`
          : '原因未记录';
        lines.push(
          `      ⚠️ 最近验收协议：invalid@第${recentValidation.iteration}轮（${reason}）${target}`,
        );
      } else {
        lines.push(
          `      · 最近验收协议：${recentValidation.protocol}@第${recentValidation.iteration}轮${target}`,
        );
      }
    }
    for (const raw of s.notes.split('\n')) {
      const note = raw.trim();
      if (note === '') continue;
      lines.push(isArbitrationLine(note) ? `      🚨 ${note}` : `      · ${note}`);
    }
  }
  const current = stories.find((s) => s.id === report.currentStoryId);
  const extras: string[] = [];
  if (current) extras.push(`👉 当前 story：${current.id} ${current.title}`);
  if (report.latestProgress !== null) extras.push(`🕐 最近进展：${report.latestProgress}`);
  if (extras.length > 0) lines.push('', ...extras);
  if (report.evidenceSkippedLines > 0) {
    lines.push(`⚠️ evidence.jsonl 有 ${report.evidenceSkippedLines} 行无法解析已跳过`);
  }
  if (report.evidenceUnavailable)
    lines.push('⚠️ evidence.jsonl 当前不可读，最近实际路由可能不完整');
  // 空 story 列表不算全绿：status 的退出码用作 CI 门禁，对退化的 prd.json 必须保守
  if (total === 0) {
    lines.push('', '⚠️ prd.json 中没有任何 story');
    return { text: lines.join('\n'), exitCode: 1 };
  }
  const allPassed = !report.stateCorrupted && passed === total;
  if (!allPassed) {
    lines.push(
      '',
      blocked > 0 ? '⏸️ 存在 blocked story' : `⏳ 还有 ${total - passed} 个 story 未完成`,
    );
    return { text: lines.join('\n'), exitCode: blocked > 0 ? 3 : 1 };
  }
  const finalReview = report.finalReview;
  if (finalReview.read.status === 'invalid') {
    lines.push('', '❌ Story 已通过，但本地 Review 状态损坏');
    return { text: lines.join('\n'), exitCode: 2 };
  }
  if (
    finalReview.read.status === 'missing' ||
    finalReview.read.status === 'unsupported' ||
    !finalReview.current
  ) {
    lines.push('', '⏳ Story 已通过，但本地最终 Review 尚未完成或已经失效');
    return { text: lines.join('\n'), exitCode: 6 };
  }
  const reviewState = finalReview.read.state;
  if (reviewState.status === 'unverifiable')
    return {
      text: [...lines, '', '❌ 本地最终 Review 无法验证'].join('\n'),
      exitCode: 5,
    };
  if (reviewState.status === 'failed')
    return {
      text: [...lines, '', '⏸️ 本地最终 Review 存在待人工处理 finding'].join('\n'),
      exitCode: 4,
    };
  if (reviewState.shadow)
    return {
      text: [...lines, '', '🧪 Shadow 已完成，但不能表示可交付'].join('\n'),
      exitCode: 7,
    };
  const remote = finalReview.refreshedRemote ?? reviewState.remote;
  if (remote.status !== 'ready')
    return {
      text: [...lines, '', '⏳ 本地已完成，GitHub CI 或 Ruleset 尚未就绪'].join('\n'),
      exitCode: 6,
    };
  lines.push('', '✅ 实现验证、本地 Review 与 GitHub 交付条件均已就绪');
  return { text: lines.join('\n'), exitCode: 0 };
}

/**
 * --json 机器可读输出：text 恒为单个可 JSON.parse 的对象（错误态输出 { error, workspace }），
 * 退出码语义与人类可读模式一致：只有实现、Review、GitHub 均就绪才返回 0，
 * 其余状态保守地返回 1–7 中对应代码。
 * 损坏警告不在此处——它走 stderr，由 cli 层负责，保证 stdout 纯净。
 */
export function renderStatusJson(report: StatusReport): { text: string; exitCode: number } {
  if (report.status !== 'ok') {
    return {
      text: JSON.stringify({ error: report.status, workspace: report.workspace }, null, 2),
      exitCode: 2,
    };
  }
  const { prd, stories } = report;
  const summary = summarize(stories);
  const view = {
    project: prd.project,
    branchName: prd.branchName,
    sourcePrd: prd.sourcePrd, // undefined 时 JSON.stringify 自动省略该键
    stateCorrupted: report.stateCorrupted,
    validationInvalidations: report.validationInvalidations,
    stories: stories.map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      passes: s.passes,
      validated: s.validated,
      validationReceipt: s.validationReceipt,
      notes: s.notes,
      retryCount: s.retryCount,
      blocked: s.blocked,
      escalated: s.escalated,
      ...(s.difficulty ? { difficulty: s.difficulty, difficultyReason: s.difficultyReason } : {}),
    })),
    modelRouting: report.modelRouting,
    recentActual: report.recentActual,
    recentValidation: report.recentValidation,
    evidence: {
      skippedLines: report.evidenceSkippedLines,
      unavailable: report.evidenceUnavailable,
    },
    finalReview: report.finalReview,
    summary,
  };
  // 与人类可读模式同一保守语义：空 story 列表不算全绿
  const allPassed = !report.stateCorrupted && summary.total > 0 && summary.passed === summary.total;
  if (!allPassed)
    return { text: JSON.stringify(view, null, 2), exitCode: summary.blocked > 0 ? 3 : 1 };
  const review = report.finalReview;
  if (review.read.status === 'invalid') return { text: JSON.stringify(view, null, 2), exitCode: 2 };
  if (review.read.status === 'missing' || review.read.status === 'unsupported' || !review.current) {
    return { text: JSON.stringify(view, null, 2), exitCode: 6 };
  }
  if (review.read.state.status === 'unverifiable')
    return { text: JSON.stringify(view, null, 2), exitCode: 5 };
  if (review.read.state.status === 'failed')
    return { text: JSON.stringify(view, null, 2), exitCode: 4 };
  if (review.read.state.shadow) return { text: JSON.stringify(view, null, 2), exitCode: 7 };
  const remote = review.refreshedRemote ?? review.read.state.remote;
  return { text: JSON.stringify(view, null, 2), exitCode: remote.status === 'ready' ? 0 : 6 };
}

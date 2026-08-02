import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tryReadPrd, type Prd } from '../engine/prd.js';
import {
  readDisplayState,
  mergedStories,
  getCurrentStoryId,
  type StoryView,
  isStoryPassed,
  evaluateStoryValidationReceiptSet,
  reconcileValidationReceipts,
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
  type ValidationHeadAbortEvidence,
} from '../engine/evidence.js';
import {
  readModelRouting,
  type ModelRouteSource,
  type ModelRoutingReadResult,
} from '../engine/models.js';
import {
  collectCurrentReviewStatus,
  type CurrentReviewStatus,
  type RunnerVersionObservation,
} from '../review/status.js';
import type { GitHubQualityClient } from '../quality/github.js';
import {
  inspectWorkspaceSafetyStatus,
  renderWorkspaceSafetyStatusLines,
  type WorkspaceSafetyStatusSnapshot,
} from '../workspace-safety/status.js';
import { observeStatusRunnerVersion } from './runner-version-observation.js';

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

export interface StoryRecentValidationHeadAbort extends ValidationHeadAbortEvidence {
  iteration: number;
}

export interface StoryValidationCurrentness {
  gitHead: string | null;
  /** true 表示没有持久绿灯因当前 HEAD/PRD 失效，不表示全部 Story 已完成。 */
  current: boolean;
  /** 本次只读对账实际撤销验收的 Story；普通未完成项不在其中。 */
  invalidStoryIds: string[];
}

export type StatusReport = (
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
      /** 兼容手工构造的旧 StatusReport；正式收集始终提供。 */
      recentValidationHeadAbort?: Record<string, StoryRecentValidationHeadAbort>;
      evidenceSkippedLines: number;
      evidenceUnavailable: boolean;
      /** state.json 存在但解析失败/形状非法；缺失是正常回退，不算损坏 */
      stateCorrupted: boolean;
      storyValidation: StoryValidationCurrentness;
      finalReview: CurrentReviewStatus;
    }
) & {
  /** 只读诊断快照；不存在时保持旧同步收集入口的兼容输出。 */
  workspaceSafety?: WorkspaceSafetyStatusSnapshot;
};

export type StatusReportWithWorkspaceSafety = StatusReport & {
  workspaceSafety: WorkspaceSafetyStatusSnapshot;
};

interface StatusWorkspaceSafetyReadAdapter {
  readonly collect: () => StatusReport | Promise<StatusReport>;
  readonly inspect: () => Promise<WorkspaceSafetyStatusSnapshot>;
}

interface StableStatusRead {
  readonly report: StatusReport;
  readonly before: WorkspaceSafetyStatusSnapshot;
  readonly after: WorkspaceSafetyStatusSnapshot;
}

const STATUS_STABILITY_ATTEMPTS = 2;

interface StatusCollectionOptions {
  readonly projectRoot?: string;
  readonly client?: GitHubQualityClient;
  readonly refreshRemote?: boolean;
  /** @internal Deterministic Story-currentness seam; production reads projectRoot HEAD. */
  readonly currentGitHead?: string | null;
}

interface ControlledStatusCollectionOptions extends StatusCollectionOptions {
  readonly runnerVersionObservation?: RunnerVersionObservation;
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

function recentValidationHeadAbortOf(
  records: EvidenceRecord[],
): Record<string, StoryRecentValidationHeadAbort> {
  const recent: Record<string, StoryRecentValidationHeadAbort> = {};
  for (const record of records) {
    if (record.type !== 'iteration' || record.storyId === null) continue;
    if (!record.validationHeadAbort) {
      delete recent[record.storyId];
    } else {
      recent[record.storyId] = {
        iteration: record.iteration,
        ...record.validationHeadAbort,
      };
    }
  }
  return recent;
}

/** 只读收集 workspace 执行状态；state.json 缺失兼容 legacy，存在但损坏则 fail-closed。 */
function collectStatusControlled(
  workspace: string,
  options: ControlledStatusCollectionOptions = {},
): StatusReport {
  const prdPath = join(workspace, 'prd.json');
  if (!existsSync(prdPath)) return { status: 'missing', workspace };
  const prd = tryReadPrd(prdPath);
  // userStories 非数组的 prd.json 对 status 同样不可用，与 JSON 解析失败同等对待
  if (prd === null || !Array.isArray(prd.userStories)) return { status: 'unparsable', workspace };
  const statePath = join(workspace, 'state.json');
  const { state, stateCorrupted } = readDisplayState(statePath, prd);
  const currentGitHead =
    options.currentGitHead === undefined
      ? readGitHead(options.projectRoot ?? process.cwd())
      : options.currentGitHead;
  const storyValidationSet = evaluateStoryValidationReceiptSet(
    prd,
    state,
    currentGitHead ?? '',
  );
  const reconciledStoryValidation = reconcileValidationReceipts(
    prd,
    state,
    currentGitHead ?? '',
  );
  const currentState = reconciledStoryValidation.state;
  let evidence: ReturnType<typeof readEvidence> = { records: [], skippedLines: 0 };
  let evidenceUnavailable = false;
  try {
    evidence = readEvidence(workspace);
  } catch {
    evidenceUnavailable = true;
  }
  return {
    status: 'ok',
    prd,
    stories: mergedStories(prd, currentState),
    currentStoryId: getCurrentStoryId(prd, currentState),
    latestProgress: latestProgressTitle(readProgress(join(workspace, 'progress.md'))),
    modelRouting: readModelRouting(prd),
    recentActual: recentActualOf(evidence.records),
    recentValidation: recentValidationOf(evidence.records),
    recentValidationHeadAbort: recentValidationHeadAbortOf(evidence.records),
    evidenceSkippedLines: evidence.skippedLines,
    evidenceUnavailable,
    stateCorrupted,
    storyValidation: {
      gitHead: currentGitHead,
      current:
        currentGitHead !== null && reconciledStoryValidation.invalidatedStoryIds.length === 0,
      invalidStoryIds: reconciledStoryValidation.invalidatedStoryIds,
    },
    finalReview: collectCurrentReviewStatus({
      workspace,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(options.client ? { client: options.client } : {}),
      refreshRemote: options.refreshRemote ?? false,
      storyValidationDigest: storyValidationSet.digest,
      ...(options.runnerVersionObservation
        ? { runnerVersionObservation: options.runnerVersionObservation }
        : {}),
    }),
  };
}

export function collectStatus(
  workspace: string,
  options: StatusCollectionOptions = {},
): StatusReport {
  return collectStatusControlled(workspace, options);
}

/**
 * Production display entrypoint. The legacy synchronous collector remains available to callers
 * that have not migrated yet, while every activated CLI/UI path should await this function.
 */
function isStableStatusRead(value: StableStatusRead): boolean {
  // The fingerprint covers the complete safety tree, including append-only released lease
  // incidents. A formal writer that both starts and finishes inside this window therefore still
  // changes the fingerprint instead of disappearing between the two observations.
  if (JSON.stringify(value.before) !== JSON.stringify(value.after)) return false;
  return value.after.status !== 'ready' || value.after.safetyFingerprint !== null;
}

function unstableStatusSnapshot(
  after: WorkspaceSafetyStatusSnapshot,
): WorkspaceSafetyStatusSnapshot {
  return {
    ...after,
    status: 'invalid',
    observedClassification: 'invalid',
    reason: 'unstable-probe',
    diagnostic:
      'workspace safety state changed while status data was collected and did not stabilize after one retry',
    display: {
      label: '状态不稳定',
      summary: '状态读取期间发生了 workspace 写入，无法证明当前结果来自同一个稳定时刻。',
      guidance: '等待当前操作结束后重新查询。',
    },
  };
}

/** @internal Deterministic status-read race seam; production fixes both readers below. */
export async function collectStatusWithWorkspaceSafetyControlled(
  adapter: StatusWorkspaceSafetyReadAdapter,
): Promise<StatusReportWithWorkspaceSafety> {
  let last: StableStatusRead | undefined;
  for (let attempt = 0; attempt < STATUS_STABILITY_ATTEMPTS; attempt += 1) {
    const before = await adapter.inspect();
    const report = await adapter.collect();
    const after = await adapter.inspect();
    last = { report, before, after };
    if (isStableStatusRead(last)) return { ...report, workspaceSafety: after };
  }
  if (last === undefined) throw new Error('status stability read did not run');
  return { ...last.report, workspaceSafety: unstableStatusSnapshot(last.after) };
}

export async function collectStatusWithWorkspaceSafety(
  workspace: string,
  options: StatusCollectionOptions = {},
): Promise<StatusReportWithWorkspaceSafety> {
  return await collectStatusWithWorkspaceSafetyControlled({
    collect: async () => {
      const runnerVersionObservation = options.projectRoot
        ? await observeStatusRunnerVersion({ workspace, projectRoot: options.projectRoot })
        : undefined;
      return collectStatusControlled(workspace, {
        ...options,
        ...(runnerVersionObservation === undefined ? {} : { runnerVersionObservation }),
      });
    },
    inspect: async () => await inspectWorkspaceSafetyStatus(workspace),
  });
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
    const safetyLines =
      report.workspaceSafety === undefined
        ? []
        : ['', ...renderWorkspaceSafetyStatusLines(report.workspaceSafety)];
    return {
      text: [
        `❌ 未找到工作区：${join(report.workspace, 'prd.json')} 不存在。建议先用 prd-to-json 从源 PRD 生成工作区。`,
        ...safetyLines,
      ].join('\n'),
      exitCode: 2,
    };
  }
  if (report.status === 'unparsable') {
    const safetyLines =
      report.workspaceSafety === undefined
        ? []
        : ['', ...renderWorkspaceSafetyStatusLines(report.workspaceSafety)];
    return {
      text: [
        `❌ 无法解析 ${join(report.workspace, 'prd.json')}。建议运行 npx coding-x repair 修复后重试。`,
        ...safetyLines,
      ].join('\n'),
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
  if (report.workspaceSafety !== undefined) {
    lines.push(...renderWorkspaceSafetyStatusLines(report.workspaceSafety), '');
  }
  if (report.workspaceSafety !== undefined && report.workspaceSafety.status !== 'ready') {
    lines.push('❌ workspace 安全状态未就绪，不能表示可交付');
    return { text: lines.join('\n'), exitCode: 2 };
  }
  if (report.storyValidation.gitHead === null) {
    lines.push('⚠️ 当前 Git HEAD 不可读取，Story 验收结果均按待重验显示', '');
  } else if (!report.storyValidation.current) {
    lines.push(
      `⚠️ Story 验收凭证已过期，共 ${report.storyValidation.invalidStoryIds.length} 个 Story 待重验`,
      '',
    );
  }
  const review = report.finalReview;
  if (review.read.status === 'missing') {
    lines.push('🔎 本地最终 Review：尚未运行', '');
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
    const pendingValidationLabel = !s.blocked && s.passes && !s.validated ? ' ⏳ 待引擎验收' : '';
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
    const headAbort = report.recentValidationHeadAbort?.[s.id];
    if (headAbort) {
      const expected = headAbort.expectedGitHead?.slice(0, 12) ?? 'unavailable';
      const actual = headAbort.actualGitHead?.slice(0, 12) ?? 'unavailable';
      const reason = headAbort.reason === 'head-unreadable' ? '提交身份不可读' : '提交身份变化';
      lines.push(
        `      ⚠️ 检查链中止：${reason}@${headAbort.phase}（期望 ${expected}，实际 ${actual}）` +
          `，相关执行结果未采用 · 第${headAbort.iteration}轮`,
      );
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
  if (finalReview.read.status === 'missing' || !finalReview.current) {
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
      text: JSON.stringify(
        {
          error: report.status,
          workspace: report.workspace,
          ...(report.workspaceSafety === undefined
            ? {}
            : { workspaceSafety: report.workspaceSafety }),
        },
        null,
        2,
      ),
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
    stories: stories.map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      passes: s.passes,
      validated: s.validated,
      notes: s.notes,
      retryCount: s.retryCount,
      blocked: s.blocked,
      escalated: s.escalated,
      ...(s.difficulty ? { difficulty: s.difficulty, difficultyReason: s.difficultyReason } : {}),
    })),
    modelRouting: report.modelRouting,
    recentActual: report.recentActual,
    recentValidation: report.recentValidation,
    recentValidationHeadAbort: report.recentValidationHeadAbort ?? {},
    evidence: {
      skippedLines: report.evidenceSkippedLines,
      unavailable: report.evidenceUnavailable,
    },
    finalReview: report.finalReview,
    storyValidation: report.storyValidation,
    ...(report.workspaceSafety === undefined ? {} : { workspaceSafety: report.workspaceSafety }),
    summary,
  };
  if (report.workspaceSafety !== undefined && report.workspaceSafety.status !== 'ready') {
    return { text: JSON.stringify(view, null, 2), exitCode: 2 };
  }
  // 与人类可读模式同一保守语义：空 story 列表不算全绿
  const allPassed = !report.stateCorrupted && summary.total > 0 && summary.passed === summary.total;
  if (!allPassed)
    return { text: JSON.stringify(view, null, 2), exitCode: summary.blocked > 0 ? 3 : 1 };
  const review = report.finalReview;
  if (review.read.status === 'invalid') return { text: JSON.stringify(view, null, 2), exitCode: 2 };
  if (review.read.status === 'missing' || !review.current)
    return { text: JSON.stringify(view, null, 2), exitCode: 6 };
  if (review.read.state.status === 'unverifiable')
    return { text: JSON.stringify(view, null, 2), exitCode: 5 };
  if (review.read.state.status === 'failed')
    return { text: JSON.stringify(view, null, 2), exitCode: 4 };
  if (review.read.state.shadow) return { text: JSON.stringify(view, null, 2), exitCode: 7 };
  const remote = review.refreshedRemote ?? review.read.state.remote;
  return { text: JSON.stringify(view, null, 2), exitCode: remote.status === 'ready' ? 0 : 6 };
}

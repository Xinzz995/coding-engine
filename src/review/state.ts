import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from '../engine/fs-atomic.js';
import { readSafeControlFileUtf8Sync } from '../engine/safe-control-file.js';
import {
  assertRegisteredWorkspacePath,
  removeRegisteredWorkspaceFileSync,
} from '../engine/workspace-identity.js';
import { digest } from './common.js';
import { REVIEWER_DEEP_REVIEW_REASON } from './risk.js';
import {
  REVIEW_DECISIONS_FILE,
  REVIEW_DECISIONS_SCHEMA_VERSION,
  REVIEW_MARKDOWN_FILE,
  REVIEW_STATE_FILE,
  REVIEW_STATE_SCHEMA_VERSION,
  type FinalReviewState,
  type ReviewAxis,
  type ReviewAxisResult,
  type ReviewBinding,
  type ReviewDecision,
  type ReviewDecisionsFile,
  type ReviewDecisionsSnapshot,
  type ReviewFinding,
  type ReviewRemoteState,
  type ReviewRiskAssessment,
} from './types.js';

export type ReviewStateRead =
  | { status: 'missing' }
  | { status: 'unsupported'; schemaVersion: number }
  | { status: 'invalid'; error: string }
  | { status: 'ready'; state: FinalReviewState };

export const FINAL_REVIEW_CONTROL_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const REVIEW_DECISIONS_CONTROL_FILE_MAX_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(
  value: unknown,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} 必须是对象`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required)
    if (!Object.hasOwn(value, key)) throw new Error(`${name} 缺少 ${key}`);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${name} 含未知字段 ${key}`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`${name} 必须是非空字符串`);
  }
  return value;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  const result = value.map((entry, index) => string(entry, `${name}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${name} 不能重复`);
  return result;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${name} 必须是不小于 ${minimum} 的整数`);
  }
  return value as number;
}

function timestamp(value: unknown, name: string): string {
  const result = string(value, name);
  if (Number.isNaN(new Date(result).getTime())) throw new Error(`${name} 必须是合法时间`);
  return result;
}

function axisName(value: unknown, name: string): ReviewAxis {
  if (value !== 'spec' && value !== 'engineering' && value !== 'deep') {
    throw new Error(`${name} 非法`);
  }
  return value;
}

function finding(
  value: unknown,
  name: string,
  expected: { axis: ReviewAxis; binding: ReviewBinding; round: number },
): ReviewFinding {
  const item = object(value, name, [
    'id',
    'axis',
    'severity',
    'title',
    'location',
    'ruleSource',
    'impact',
    'recommendation',
    'requiresHumanDecision',
    'prNumber',
    'baseSha',
    'headSha',
    'round',
  ]);
  const axis = axisName(item.axis, `${name}.axis`);
  if (axis !== expected.axis) throw new Error(`${name}.axis 与所属评审轴不一致`);
  if (!['P0', 'P1', 'P2', 'Info'].includes(String(item.severity))) {
    throw new Error(`${name}.severity 非法`);
  }
  if (typeof item.requiresHumanDecision !== 'boolean') {
    throw new Error(`${name}.requiresHumanDecision 必须是 boolean`);
  }
  const location = object(item.location, `${name}.location`, ['path'], ['line', 'symbol']);
  const path = string(location.path, `${name}.location.path`);
  if (path.startsWith('/') || path.split('/').includes('..'))
    throw new Error(`${name}.location.path 非法`);
  const prNumber = integer(item.prNumber, `${name}.prNumber`, 1);
  const round = integer(item.round, `${name}.round`, 1);
  const baseSha = string(item.baseSha, `${name}.baseSha`);
  const headSha = string(item.headSha, `${name}.headSha`);
  if (
    prNumber !== expected.binding.prNumber ||
    round !== expected.round ||
    baseSha !== expected.binding.baseSha ||
    headSha !== expected.binding.headSha
  ) {
    throw new Error(`${name} 与最终 Review binding 不一致`);
  }
  return {
    id: string(item.id, `${name}.id`),
    axis,
    severity: item.severity as ReviewFinding['severity'],
    title: string(item.title, `${name}.title`),
    location: {
      path,
      ...(location.line === undefined
        ? {}
        : { line: integer(location.line, `${name}.location.line`, 1) }),
      ...(location.symbol === undefined
        ? {}
        : { symbol: string(location.symbol, `${name}.location.symbol`) }),
    },
    ruleSource: string(item.ruleSource, `${name}.ruleSource`),
    impact: string(item.impact, `${name}.impact`),
    recommendation: string(item.recommendation, `${name}.recommendation`),
    requiresHumanDecision: item.requiresHumanDecision,
    prNumber,
    baseSha,
    headSha,
    round,
  };
}

function binding(value: unknown): ReviewBinding {
  const item = object(value, 'binding', [
    'prNumber',
    'targetBranch',
    'baseSha',
    'headSha',
    'prTitleDigest',
    'prBodyDigest',
    'specDigest',
    'engineeringStandardsDigest',
    'qualityContractDigest',
    'codingXVersion',
    'storyValidationDigest',
    'reviewDecisionsDigest',
    'reviewRoutingDigest',
    'runner',
    'model',
    'runnerVersion',
    'reviewRulesVersion',
    'reviewRulesDigest',
    'riskDigest',
  ]);
  if (!['claude', 'codex', 'cursor'].includes(String(item.runner)))
    throw new Error('binding.runner 非法');
  return {
    prNumber: integer(item.prNumber, 'binding.prNumber', 1),
    targetBranch: string(item.targetBranch, 'binding.targetBranch'),
    baseSha: string(item.baseSha, 'binding.baseSha'),
    headSha: string(item.headSha, 'binding.headSha'),
    prTitleDigest: string(item.prTitleDigest, 'binding.prTitleDigest'),
    prBodyDigest: string(item.prBodyDigest, 'binding.prBodyDigest'),
    specDigest: string(item.specDigest, 'binding.specDigest'),
    engineeringStandardsDigest: string(
      item.engineeringStandardsDigest,
      'binding.engineeringStandardsDigest',
    ),
    qualityContractDigest: string(item.qualityContractDigest, 'binding.qualityContractDigest'),
    storyValidationDigest: string(item.storyValidationDigest, 'binding.storyValidationDigest'),
    reviewDecisionsDigest: string(item.reviewDecisionsDigest, 'binding.reviewDecisionsDigest'),
    reviewRoutingDigest: string(item.reviewRoutingDigest, 'binding.reviewRoutingDigest'),
    codingXVersion: string(item.codingXVersion, 'binding.codingXVersion'),
    runner: item.runner as ReviewBinding['runner'],
    model: string(item.model, 'binding.model'),
    runnerVersion: string(item.runnerVersion, 'binding.runnerVersion'),
    reviewRulesVersion: string(item.reviewRulesVersion, 'binding.reviewRulesVersion'),
    reviewRulesDigest: string(item.reviewRulesDigest, 'binding.reviewRulesDigest'),
    riskDigest: string(item.riskDigest, 'binding.riskDigest'),
  };
}

function risk(value: unknown): ReviewRiskAssessment {
  const item = object(value, 'risk', [
    'triggered',
    'categories',
    'reasons',
    'changedFiles',
    'changedModules',
    'digest',
  ]);
  if (typeof item.triggered !== 'boolean') throw new Error('risk.triggered 必须是 boolean');
  const parsed = {
    triggered: item.triggered,
    categories: strings(item.categories, 'risk.categories') as ReviewRiskAssessment['categories'],
    reasons: strings(item.reasons, 'risk.reasons'),
    changedFiles: strings(item.changedFiles, 'risk.changedFiles'),
    changedModules: strings(item.changedModules, 'risk.changedModules'),
  };
  const savedDigest = string(item.digest, 'risk.digest');
  if (parsed.triggered !== parsed.categories.length > 0) {
    throw new Error('risk.triggered 与 categories 不一致');
  }
  if (digest(parsed) !== savedDigest) throw new Error('risk.digest 与风险内容不一致');
  return { ...parsed, digest: savedDigest };
}

function axisResult(
  value: unknown,
  index: number,
  expected: { binding: ReviewBinding; round: number },
): ReviewAxisResult {
  const name = `axes[${index}]`;
  const item = object(value, name, [
    'axis',
    'status',
    'summary',
    'findings',
    'requestDeepReview',
    'durationMs',
    'attempts',
  ]);
  const axis = axisName(item.axis, `${name}.axis`);
  if (!['passed', 'failed', 'unverifiable'].includes(String(item.status))) {
    throw new Error(`${name}.status 非法`);
  }
  if (typeof item.requestDeepReview !== 'boolean')
    throw new Error(`${name}.requestDeepReview 必须是 boolean`);
  if (!Array.isArray(item.findings) || item.findings.length > 100)
    throw new Error(`${name}.findings 非法`);
  return {
    axis,
    status: item.status as ReviewAxisResult['status'],
    summary: string(item.summary, `${name}.summary`),
    findings: item.findings.map((entry, findingIndex) =>
      finding(entry, `${name}.findings[${findingIndex}]`, { axis, ...expected }),
    ),
    requestDeepReview: item.requestDeepReview,
    durationMs: integer(item.durationMs, `${name}.durationMs`),
    attempts: integer(item.attempts, `${name}.attempts`),
  };
}

function remote(value: unknown): ReviewRemoteState {
  const item = object(
    value,
    'remote',
    ['status', 'checks', 'rulesetErrors', 'checkedAt'],
    ['detail'],
  );
  if (!['ready', 'pending', 'failed', 'invalid'].includes(String(item.status))) {
    throw new Error('remote.status 非法');
  }
  if (!Array.isArray(item.checks)) throw new Error('remote.checks 必须是数组');
  const checks = item.checks.map((entry, index) => {
    const check = object(entry, `remote.checks[${index}]`, [
      'name',
      'status',
      'conclusion',
      'appId',
      'appSlug',
    ]);
    if (check.conclusion !== null && typeof check.conclusion !== 'string') {
      throw new Error(`remote.checks[${index}].conclusion 非法`);
    }
    return {
      name: string(check.name, `remote.checks[${index}].name`),
      status: string(check.status, `remote.checks[${index}].status`),
      conclusion: check.conclusion,
      appId: integer(check.appId, `remote.checks[${index}].appId`, 1),
      appSlug: string(check.appSlug, `remote.checks[${index}].appSlug`),
    };
  });
  return {
    status: item.status as ReviewRemoteState['status'],
    checks,
    rulesetErrors: strings(item.rulesetErrors, 'remote.rulesetErrors'),
    ...(item.detail === undefined ? {} : { detail: string(item.detail, 'remote.detail') }),
    checkedAt: timestamp(item.checkedAt, 'remote.checkedAt'),
  };
}

function parseFinalReviewState(value: unknown): FinalReviewState {
  const root = object(value, 'final-review.json', [
    'schemaVersion',
    'status',
    'deliveryStatus',
    'binding',
    'risk',
    'axes',
    'remote',
    'round',
    'shadow',
    'startedAt',
    'completedAt',
  ]);
  if (root.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) {
    throw new Error('final-review.json schemaVersion 不受支持');
  }
  if (!['passed', 'failed', 'unverifiable'].includes(String(root.status)))
    throw new Error('final-review.json status 非法');
  if (
    !['ready', 'findings', 'unverifiable', 'remote-pending', 'shadow'].includes(
      String(root.deliveryStatus),
    )
  ) {
    throw new Error('final-review.json deliveryStatus 非法');
  }
  if (typeof root.shadow !== 'boolean') throw new Error('final-review.json shadow 必须是 boolean');
  const parsedBinding = binding(root.binding);
  const parsedRisk = risk(root.risk);
  const round = integer(root.round, 'final-review.json round', 1);
  if (parsedBinding.riskDigest !== parsedRisk.digest)
    throw new Error('binding.riskDigest 与 risk.digest 不一致');
  if (!Array.isArray(root.axes)) throw new Error('final-review.json axes 必须是数组');
  const axes = root.axes.map((entry, index) =>
    axisResult(entry, index, { binding: parsedBinding, round }),
  );
  const axisNames = axes.map((axis) => axis.axis);
  if (new Set(axisNames).size !== axisNames.length)
    throw new Error('final-review.json axes 不能重复');
  if (!axisNames.includes('spec') || !axisNames.includes('engineering')) {
    throw new Error('final-review.json 必须包含独立的 spec 与 engineering 评审轴');
  }
  const reviewerRequested = axes.some((axis) => axis.axis !== 'deep' && axis.requestDeepReview);
  const hasReviewerRequestCategory = parsedRisk.categories.includes('reviewer-request');
  const hasReviewerRequestReason = parsedRisk.reasons.includes(REVIEWER_DEEP_REVIEW_REASON);
  if (
    reviewerRequested !== hasReviewerRequestReason ||
    (reviewerRequested && !hasReviewerRequestCategory)
  ) {
    throw new Error('final-review.json axes 与 Reviewer 深度升级风险不一致');
  }
  if (parsedRisk.triggered && !axisNames.includes('deep')) {
    throw new Error('风险已触发但 final-review.json 缺少 deep 评审轴');
  }
  if (!parsedRisk.triggered && axisNames.includes('deep')) {
    throw new Error('风险未触发但 final-review.json 含 deep 评审轴');
  }
  const parsedRemote = remote(root.remote);
  const status = root.status as FinalReviewState['status'];
  const deliveryStatus = root.deliveryStatus as FinalReviewState['deliveryStatus'];
  if (
    deliveryStatus === 'ready' &&
    (status !== 'passed' || parsedRemote.status !== 'ready' || root.shadow)
  ) {
    throw new Error('deliveryStatus=ready 与本地、远端或 shadow 状态矛盾');
  }
  if (deliveryStatus === 'findings' && status !== 'failed')
    throw new Error('deliveryStatus=findings 但 status 不是 failed');
  if (deliveryStatus === 'unverifiable' && status !== 'unverifiable') {
    throw new Error('deliveryStatus=unverifiable 但 status 不一致');
  }
  if (deliveryStatus === 'shadow' && (!root.shadow || status !== 'passed')) {
    throw new Error('deliveryStatus=shadow 与 shadow/status 不一致');
  }
  if (
    deliveryStatus === 'remote-pending' &&
    (status !== 'passed' || parsedRemote.status === 'ready' || root.shadow)
  ) {
    throw new Error('deliveryStatus=remote-pending 与本地、远端或 shadow 状态矛盾');
  }
  const hasUnverifiableAxis = axes.some((axis) => axis.status === 'unverifiable');
  if (hasUnverifiableAxis !== (status === 'unverifiable')) {
    throw new Error('final-review.json status 与评审轴的 unverifiable 状态不一致');
  }
  return {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    status,
    deliveryStatus,
    binding: parsedBinding,
    risk: parsedRisk,
    axes,
    remote: parsedRemote,
    round,
    shadow: root.shadow,
    startedAt: timestamp(root.startedAt, 'final-review.json startedAt'),
    completedAt: timestamp(root.completedAt, 'final-review.json completedAt'),
  };
}

/** Status/report reader. Formal run never trusts this file to skip a model Review. */
export function readFinalReviewState(workspace: string): ReviewStateRead {
  const path = join(workspace, REVIEW_STATE_FILE);
  try {
    const raw = readSafeControlFileUtf8Sync(path, {
      maxBytes: FINAL_REVIEW_CONTROL_FILE_MAX_BYTES,
      allowMissing: true,
    });
    if (raw === null) return { status: 'missing' };
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      Number.isInteger(value.schemaVersion) &&
      value.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION
    ) {
      return { status: 'unsupported', schemaVersion: value.schemaVersion as number };
    }
    return { status: 'ready', state: parseFinalReviewState(value) };
  } catch (error) {
    return { status: 'invalid', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 一次新的正式 Review 尝试从开始起就使旧结果失效。若后续机械检查、
 * Runner 或上下文复核失败，status 也不能继续展示上一次的绿色结论。
 */
export function invalidateFinalReviewState(workspace: string): void {
  removeRegisteredWorkspaceFileSync(join(workspace, REVIEW_STATE_FILE), true);
  removeRegisteredWorkspaceFileSync(join(workspace, REVIEW_MARKDOWN_FILE), true);
}

function decision(value: unknown, index: number): ReviewDecision {
  if (!isRecord(value)) throw new Error(`decisions[${index}] 必须是对象`);
  const allowed = new Set([
    'findingId',
    'headSha',
    'action',
    'operator',
    'at',
    'evidence',
    'issue',
  ]);
  for (const key of ['findingId', 'headSha', 'action', 'operator', 'at']) {
    if (!Object.hasOwn(value, key)) throw new Error(`decisions[${index}] 缺少 ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`decisions[${index}] 含未知字段 ${key}`);
  }
  for (const key of ['findingId', 'headSha', 'operator', 'at'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '' || value[key].includes('\0')) {
      throw new Error(`decisions[${index}].${key} 必须是非空字符串`);
    }
  }
  if (
    !['counterevidence', 'p1-deferred', 'acknowledged', 'fix-requested'].includes(
      String(value.action),
    )
  ) {
    throw new Error(`decisions[${index}].action 非法`);
  }
  if (
    value.evidence !== undefined &&
    (typeof value.evidence !== 'string' || value.evidence.trim() === '')
  ) {
    throw new Error(`decisions[${index}].evidence 必须是非空字符串`);
  }
  if (
    value.issue !== undefined &&
    (!Number.isInteger(value.issue) || (value.issue as number) < 1)
  ) {
    throw new Error(`decisions[${index}].issue 必须是正整数`);
  }
  if (Number.isNaN(new Date(value.at as string).getTime()))
    throw new Error(`decisions[${index}].at 非法`);
  return value as unknown as ReviewDecision;
}

export function readReviewDecisions(workspace: string): ReviewDecisionsFile {
  const path = join(workspace, REVIEW_DECISIONS_FILE);
  const raw = readReviewDecisionsRaw(path);
  if (raw === null) return { schemaVersion: REVIEW_DECISIONS_SCHEMA_VERSION, decisions: [] };
  return parseReviewDecisions(raw);
}

function readReviewDecisionsRaw(path: string): string | null {
  return readSafeControlFileUtf8Sync(path, {
    maxBytes: REVIEW_DECISIONS_CONTROL_FILE_MAX_BYTES,
    allowMissing: true,
  });
}

function parseReviewDecisions(raw: string): ReviewDecisionsFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `无法解析 ${REVIEW_DECISIONS_FILE}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== REVIEW_DECISIONS_SCHEMA_VERSION ||
    !Array.isArray(value.decisions)
  ) {
    throw new Error(`${REVIEW_DECISIONS_FILE} 形状非法`);
  }
  return {
    schemaVersion: REVIEW_DECISIONS_SCHEMA_VERSION,
    decisions: value.decisions.map(decision),
  };
}

/** 原始字节也进入身份，防止运行中重写同一语义后冒充启动输入。 */
export function reviewDecisionsDigest(raw: string | null): string {
  return digest({ status: raw === null ? 'missing' : 'present', raw });
}

export function freezeReviewDecisions(workspace: string): ReviewDecisionsSnapshot {
  const path = join(workspace, REVIEW_DECISIONS_FILE);
  const raw = readReviewDecisionsRaw(path);
  if (raw === null) {
    return {
      raw: null,
      value: { schemaVersion: REVIEW_DECISIONS_SCHEMA_VERSION, decisions: [] },
      digest: reviewDecisionsDigest(null),
    };
  }
  return { raw, value: parseReviewDecisions(raw), digest: reviewDecisionsDigest(raw) };
}

export function reviewDecisionsSnapshotIsValid(snapshot: ReviewDecisionsSnapshot): boolean {
  if (snapshot.digest !== reviewDecisionsDigest(snapshot.raw)) return false;
  try {
    const expected =
      snapshot.raw === null
        ? { schemaVersion: REVIEW_DECISIONS_SCHEMA_VERSION, decisions: [] }
        : parseReviewDecisions(snapshot.raw);
    return digest(expected) === digest(snapshot.value);
  } catch {
    return false;
  }
}

export function restoreReviewDecisionsSnapshot(
  workspace: string,
  snapshot: ReviewDecisionsSnapshot,
): { changed: boolean; receivedDigest: string } {
  const path = join(workspace, REVIEW_DECISIONS_FILE);
  let current: string | null;
  let receivedDigest: string;
  try {
    current = readReviewDecisionsRaw(path);
    receivedDigest = reviewDecisionsDigest(current);
  } catch {
    // 不可信进程可把路径换成 FIFO/软链/设备。它仍算一次明确篡改，
    // 但绝不读取目标内容；恢复只替换这个精确的 workspace 控制路径。
    current = null;
    receivedDigest = digest({ status: 'unsafe-control-path' });
    if (snapshot.raw === null) removeRegisteredWorkspaceFileSync(path, true);
    else writeFileAtomicSync(path, snapshot.raw);
    return { changed: true, receivedDigest };
  }
  if (current === snapshot.raw) return { changed: false, receivedDigest };
  if (snapshot.raw === null) removeRegisteredWorkspaceFileSync(path, true);
  else writeFileAtomicSync(path, snapshot.raw);
  return { changed: true, receivedDigest };
}

export function reviewDecisionsSnapshotMatches(
  workspace: string,
  snapshot: ReviewDecisionsSnapshot,
): boolean {
  const path = join(workspace, REVIEW_DECISIONS_FILE);
  try {
    const current = readReviewDecisionsRaw(path);
    return current === snapshot.raw;
  } catch {
    return false;
  }
}

function renderFinding(finding: ReviewFinding): string[] {
  const line = finding.location.line ? `:${finding.location.line}` : '';
  return [
    `### ${finding.severity} ${finding.id} — ${finding.title}`,
    '',
    `- 评审轴：${finding.axis}`,
    `- 位置：${finding.location.path}${line}`,
    `- 规则来源：${finding.ruleSource}`,
    `- 实际影响：${finding.impact}`,
    `- 建议处理：${finding.recommendation}`,
    `- 需要人工决策：${finding.requiresHumanDecision ? '是' : '否'}`,
    '',
  ];
}

export function renderFinalReviewMarkdown(state: FinalReviewState): string {
  const lines = [
    '# coding-x 本地最终 Review',
    '',
    '> 这是被 Git 忽略的本地反馈，不是 GitHub 共享凭证，也不能证明模型判断一定正确。',
    '',
    `- 本地 Review：${state.status}`,
    `- 交付状态：${state.deliveryStatus}`,
    `- PR：#${state.binding.prNumber}`,
    `- base：${state.binding.baseSha}`,
    `- head：${state.binding.headSha}`,
    `- Runner：${state.binding.runner} / ${state.binding.model} / ${state.binding.runnerVersion}`,
    `- 风险触发：${state.risk.triggered ? state.risk.reasons.join('；') : '否'}`,
    '',
  ];
  for (const axis of state.axes) {
    lines.push(`## ${axis.axis} — ${axis.status}`, '', axis.summary, '');
    if (axis.findings.length === 0) lines.push('- 无 finding', '');
    else axis.findings.forEach((finding) => lines.push(...renderFinding(finding)));
  }
  lines.push(
    '## GitHub 远端',
    '',
    `- 状态：${state.remote.status}`,
    ...state.remote.checks.map(
      (check) =>
        `- ${check.name}：${check.status}/${check.conclusion ?? 'pending'}（${check.appSlug}）`,
    ),
    ...state.remote.rulesetErrors.map((error) => `- 规则漂移：${error}`),
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function writeFinalReviewState(workspace: string, state: FinalReviewState): void {
  // 正式 run 已在持锁时冻结 workspace；它若被整体替换，这里必须在 mkdir/写入前失败。
  if (assertRegisteredWorkspacePath(join(workspace, REVIEW_STATE_FILE)) === null) {
    mkdirSync(workspace, { recursive: true });
  }
  try {
    // Markdown 只是阅读副本，权威 JSON 必须最后写入。任一写失败都删除 JSON，
    // 避免调用方报错退出却留下一个可被 status 继续当作 ready 的半提交结果。
    writeFileAtomicSync(join(workspace, REVIEW_MARKDOWN_FILE), renderFinalReviewMarkdown(state));
    writeFileAtomicSync(join(workspace, REVIEW_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    try {
      invalidateFinalReviewState(workspace);
    } catch {
      // 路径若被替换成目录，清理阅读副本可能失败；权威 JSON 在上面最后写且
      // 调用前已失效。保留原始写入错误给调用方，不能把清理错误伪装成根因。
    }
    try {
      removeRegisteredWorkspaceFileSync(join(workspace, REVIEW_STATE_FILE), true);
    } catch {
      // 非普通路径本身也无法被 readFinalReviewState 解析为 ready。
    }
    throw error;
  }
}

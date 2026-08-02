import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { digestFinalReviewMechanicalEnvironment } from '../engine/story-validation-currentness.js';
import {
  digestQualityContract,
  parseQualityContract,
  type QualityContract,
} from '../quality/contract.js';
import { type GitHubReviewReadClient } from '../quality/github.js';
import { CODING_X_VERSION } from '../version.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { createReviewBinding, digestReviewBinding } from './binding.js';
import { digest } from './common.js';
import {
  createManagedReviewObservation,
  type ManagedReviewObservation,
  type ManagedReviewTermination,
} from './managed-observation.js';
import { validateP1DeferralIssue } from './decisions.js';
import {
  revalidateReviewContext,
  runReviewPreflight,
  type ReviewPreflightContext,
} from './preflight.js';
import { readRunnerVersion } from './runner.js';
import { readFinalReviewState, readReviewDecisions } from './state.js';
import { observeStoryValidationCurrentness } from './story-validation-observation.js';
import {
  REVIEW_DECISIONS_FILE,
  REVIEW_DECISIONS_SCHEMA_VERSION,
  REVIEW_STATE_FILE,
  type FinalReviewState,
  type ReviewBinding,
  type ReviewDecision,
  type ReviewDecisionAction,
  type ReviewFinding,
} from './types.js';

export interface ReviewDecisionRequest {
  readonly schemaVersion: 1;
  readonly findingId: string;
  readonly action: ReviewDecisionAction;
  readonly operator: string;
  readonly evidence?: string;
  readonly issue?: number;
}

export interface RecordReviewDecisionOptions {
  readonly session: WorkspaceSession;
  readonly root: string;
  readonly request: ReviewDecisionRequest;
  readonly contract: QualityContract;
  readonly client?: GitHubReviewReadClient;
  readonly observation?: ManagedReviewObservation;
  readonly termination?: ManagedReviewTermination;
  readonly now?: () => Date;
  readonly readHead?: () => string | Promise<string>;
  /** Test-only race seam. Production reconstructs and revalidates the complete binding. */
  readonly readBinding?: () =>
    | ReviewBinding
    | DecisionBindingObservation
    | Promise<ReviewBinding | DecisionBindingObservation>;
  /** Test-only race seam. Production callers do not provide this. */
  readonly beforeCommit?: () => void | Promise<void>;
  /** Test-only post-write race seam. Production callers do not provide this. */
  readonly afterCommit?: () => void | Promise<void>;
}

interface DecisionBindingObservation {
  readonly binding: ReviewBinding;
  readonly storyObservationToken: string;
}

export async function readBoundReviewDecisionContract(
  session: WorkspaceSession,
  root: string,
  observation: ManagedReviewObservation = createManagedReviewObservation({ session, root }),
): Promise<QualityContract> {
  const workspace = session.lease.workspace.path;
  const review = readFinalReviewState(workspace);
  if (review.status !== 'ready') {
    invalid(
      review.status === 'missing'
        ? '缺少当前 Final Review；请先重新运行 coding-x'
        : `Final Review 无效：${review.error}`,
    );
  }
  let raw: string;
  try {
    raw = await observation.git(['show', `${review.state.binding.baseSha}:.coding-x/quality.json`]);
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    invalid(
      `无法读取 Final Review 绑定的默认分支质量契约：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid('Final Review 绑定的默认分支质量契约不是合法 JSON');
  }
  const parsed = parseQualityContract(value);
  if (parsed.status !== 'ready') {
    invalid(`Final Review 绑定的默认分支质量契约无效：${parsed.errors.join('；')}`);
  }
  if (parsed.digest !== review.state.binding.qualityContractDigest) {
    invalid('默认分支质量契约摘要与 Final Review 绑定不一致');
  }
  return parsed.contract;
}

function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', message);
}

function strictRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function strictString(value: unknown, name: string, maximumBytes = 4096): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    invalid(`${name} 必须是有界非空字符串`);
  }
  return value.trim();
}

export function parseReviewDecisionRequest(value: unknown): ReviewDecisionRequest {
  const input = strictRecord(value, 'review decision request');
  const allowed = new Set([
    'schemaVersion',
    'findingId',
    'action',
    'operator',
    'evidence',
    'issue',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalid(`review decision request 含未知字段 ${key}`);
  }
  for (const key of ['schemaVersion', 'findingId', 'action', 'operator']) {
    if (!Object.hasOwn(input, key)) invalid(`review decision request 缺少 ${key}`);
  }
  if (input.schemaVersion !== 1) invalid('review decision request schemaVersion 不受支持');
  const action = input.action;
  if (
    action !== 'counterevidence' &&
    action !== 'p1-deferred' &&
    action !== 'acknowledged' &&
    action !== 'fix-requested'
  ) {
    invalid('review decision request action 非法');
  }
  const evidence =
    input.evidence === undefined
      ? undefined
      : strictString(input.evidence, 'review decision request evidence', 32 * 1024);
  if (
    input.issue !== undefined &&
    (!Number.isInteger(input.issue) || (input.issue as number) < 1)
  ) {
    invalid('review decision request issue 必须是正整数');
  }
  return {
    schemaVersion: 1,
    findingId: strictString(input.findingId, 'review decision request findingId'),
    action,
    operator: strictString(input.operator, 'review decision request operator'),
    ...(evidence === undefined ? {} : { evidence }),
    ...(input.issue === undefined ? {} : { issue: input.issue as number }),
  };
}

async function currentGitHead(observation: ManagedReviewObservation): Promise<string> {
  try {
    const value = (await observation.git(['rev-parse', '--verify', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
      invalid('当前 Git HEAD 不是完整对象标识');
    }
    return value;
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    invalid(`无法读取当前 Git HEAD：${error instanceof Error ? error.message : String(error)}`);
  }
}

function findCurrentFinding(findings: readonly ReviewFinding[], findingId: string): ReviewFinding {
  const matches = findings.filter((finding) => finding.id === findingId);
  if (matches.length !== 1) {
    invalid(
      matches.length === 0
        ? `当前 Final Review 不存在 finding ${findingId}`
        : `当前 Final Review 中 finding ${findingId} 不唯一`,
    );
  }
  return matches[0];
}

function validateAction(request: ReviewDecisionRequest, finding: ReviewFinding): void {
  if (request.action === 'acknowledged') {
    if (
      (finding.severity !== 'P2' && finding.severity !== 'Info') ||
      finding.requiresHumanDecision
    ) {
      invalid('acknowledged 只适用于不要求人工决策的 P2 或 Info finding');
    }
    if (request.issue !== undefined || request.evidence !== undefined) {
      invalid('acknowledged 不接受 evidence 或 issue');
    }
    return;
  }
  if (request.action === 'counterevidence') {
    if (!request.evidence || request.evidence.trim().length < 20) {
      invalid('counterevidence 必须提供不少于 20 个字符的具体反证');
    }
    if (request.issue !== undefined) invalid('counterevidence 不接受 issue');
    return;
  }
  if (request.action === 'p1-deferred') {
    if (finding.severity !== 'P1' || request.issue === undefined) {
      invalid('p1-deferred 只适用于 P1 finding，且必须关联 Issue');
    }
    if (request.evidence !== undefined)
      invalid('p1-deferred 的理由应记录在 Issue，不接受 evidence');
    return;
  }
  if (request.issue !== undefined) invalid('fix-requested 不接受 issue');
}

function createCurrentBindingReader(options: {
  session: WorkspaceSession;
  root: string;
  contract: QualityContract;
  review: FinalReviewState;
  observation: ManagedReviewObservation;
  termination?: ManagedReviewTermination;
}): () => Promise<DecisionBindingObservation> {
  let context: ReviewPreflightContext | null = null;
  return async () => {
    const storyBefore = await observeStoryValidationCurrentness({
      projectRoot: options.root,
      workspace: options.session.lease.workspace.path,
      session: options.session,
      ...(options.termination ? { termination: options.termination } : {}),
    });
    if (storyBefore.status !== 'ready' || storyBefore.storyValidationDigest === null) {
      const message =
        storyBefore.status === 'ready' ? 'Story 验收凭证集合已失效' : storyBefore.message;
      invalid(`Story 验收当前性无法重核：${message}`);
    }
    if (context === null) {
      const preflight = await runReviewPreflight({
        root: options.root,
        workspace: options.session.lease.workspace.path,
        currentContract: options.contract,
        observation: options.observation,
      });
      if (preflight.status !== 'ready') {
        invalid(`Final Review binding 无法重核：${preflight.message}`);
      }
      context = preflight.context;
    }

    let runnerVersion: string;
    try {
      runnerVersion = await readRunnerVersion({
        session: options.session,
        runner: options.review.binding.runner,
        projectRoot: options.root,
        termination: options.termination,
      });
    } catch (error) {
      invalid(
        `Final Review Runner 版本无法重核：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const revalidated = await revalidateReviewContext(
      context,
      options.session.lease.workspace.path,
      options.observation,
    );
    if (!revalidated.ok) invalid(revalidated.message);
    const storyAfter = await observeStoryValidationCurrentness({
      projectRoot: options.root,
      workspace: options.session.lease.workspace.path,
      session: options.session,
      ...(options.termination ? { termination: options.termination } : {}),
    });
    if (storyAfter.status !== 'ready' || storyAfter.storyValidationDigest === null) {
      const message =
        storyAfter.status === 'ready' ? 'Story 验收凭证集合已失效' : storyAfter.message;
      invalid(`Story 验收当前性无法重核：${message}`);
    }
    if (
      storyBefore.observationToken !== storyAfter.observationToken ||
      storyBefore.headSha !== storyAfter.headSha ||
      storyAfter.headSha !== context.headSha ||
      storyBefore.storyValidationDigest !== storyAfter.storyValidationDigest
    ) {
      invalid('重核 Final Review binding 期间 Story 验收权威输入发生变化');
    }
    return {
      binding: createReviewBinding({
        context,
        risk: options.review.risk,
        codingXVersion: CODING_X_VERSION,
        runner: options.review.binding.runner,
        model: options.review.binding.model,
        runnerVersion,
        storyValidationDigest: storyAfter.storyValidationDigest,
        validationEnvironmentDigest: digestFinalReviewMechanicalEnvironment({
          contract: context.baseContract,
          headSha: context.headSha,
        }),
      }),
      storyObservationToken: storyAfter.observationToken,
    };
  };
}

interface RawWorkspaceFileSnapshot {
  readonly status: 'ready' | 'missing';
  readonly digest: string;
  readonly bytes: Buffer | null;
}

const MAX_DECISION_ARTIFACT_BYTES = 16 * 1024 * 1024;

interface DecisionArtifactsSnapshot {
  readonly review: FinalReviewState;
  readonly reviewFile: RawWorkspaceFileSnapshot;
  readonly reviewDigest: string;
  readonly bindingDigest: string;
  readonly findingsDigest: string;
  readonly decisionsFile: RawWorkspaceFileSnapshot;
  readonly decisionsDigest: string;
  readonly decisions: ReturnType<typeof readReviewDecisions>;
}

interface DecisionCheckpoint {
  readonly artifacts: DecisionArtifactsSnapshot;
  readonly binding: ReviewBinding;
  readonly storyObservationToken: string;
  readonly headSha: string;
}

function workspaceFileSnapshot(path: string): RawWorkspaceFileSnapshot {
  let descriptor: number | null = null;
  let pathObserved = false;
  try {
    const linkedBefore = lstatSync(path);
    pathObserved = true;
    if (
      linkedBefore.isSymbolicLink() ||
      !linkedBefore.isFile() ||
      linkedBefore.size > MAX_DECISION_ARTIFACT_BYTES
    ) {
      invalid(`${path} 必须是至多 ${MAX_DECISION_ARTIFACT_BYTES} 字节的普通文件`);
    }
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== linkedBefore.dev ||
      opened.ino !== linkedBefore.ino ||
      opened.size !== linkedBefore.size
    ) {
      invalid(`${path} 在打开时发生身份变化`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) invalid(`${path} 在读取时提前结束`);
      offset += count;
    }
    const openedAfter = fstatSync(descriptor);
    const linkedAfter = lstatSync(path);
    if (
      linkedAfter.isSymbolicLink() ||
      !linkedAfter.isFile() ||
      openedAfter.dev !== opened.dev ||
      openedAfter.ino !== opened.ino ||
      openedAfter.size !== opened.size ||
      openedAfter.mtimeMs !== opened.mtimeMs ||
      openedAfter.ctimeMs !== opened.ctimeMs ||
      linkedAfter.dev !== opened.dev ||
      linkedAfter.ino !== opened.ino
    ) {
      invalid(`${path} 在读取期间发生变化`);
    }
    return {
      status: 'ready',
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes,
    };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (code === 'ENOENT' && !pathObserved) {
      return { status: 'missing', digest: 'missing', bytes: null };
    }
    if (error instanceof WorkspaceSafetyError) throw error;
    return invalid(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function sameWorkspaceFile(
  left: RawWorkspaceFileSnapshot,
  right: RawWorkspaceFileSnapshot,
): boolean {
  return left.status === right.status && left.digest === right.digest;
}

function parsedWorkspaceJsonDigest(
  file: RawWorkspaceFileSnapshot,
  name: string,
  missingValue?: unknown,
): string {
  if (file.status === 'missing') {
    if (missingValue !== undefined) return digest(missingValue);
    invalid(`缺少 ${name}`);
  }
  try {
    return digest(JSON.parse(file.bytes!.toString('utf8')));
  } catch (error) {
    invalid(`${name} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readDecisionArtifacts(workspace: string): DecisionArtifactsSnapshot {
  const reviewPath = join(workspace, REVIEW_STATE_FILE);
  const decisionsPath = join(workspace, REVIEW_DECISIONS_FILE);
  const reviewFileBefore = workspaceFileSnapshot(reviewPath);
  const decisionsFileBefore = workspaceFileSnapshot(decisionsPath);
  const review = readFinalReviewState(workspace);
  if (review.status !== 'ready') {
    invalid(
      review.status === 'missing'
        ? '缺少当前 Final Review；请先重新运行 coding-x'
        : `Final Review 无效：${review.error}`,
    );
  }
  if (review.state.schemaVersion !== 2) {
    invalid('旧 Final Review 不能记录新裁决；请重新运行 coding-x');
  }
  let decisions: ReturnType<typeof readReviewDecisions>;
  try {
    decisions = readReviewDecisions(workspace);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  const reviewFileAfter = workspaceFileSnapshot(reviewPath);
  const decisionsFileAfter = workspaceFileSnapshot(decisionsPath);
  if (
    !sameWorkspaceFile(reviewFileBefore, reviewFileAfter) ||
    !sameWorkspaceFile(decisionsFileBefore, decisionsFileAfter)
  ) {
    invalid('读取裁决上下文期间 Final Review 或已有裁决发生变化');
  }
  if (parsedWorkspaceJsonDigest(reviewFileAfter, REVIEW_STATE_FILE) !== digest(review.state)) {
    invalid('Final Review 完整文件与严格解析结果不一致');
  }
  if (
    parsedWorkspaceJsonDigest(decisionsFileAfter, REVIEW_DECISIONS_FILE, {
      schemaVersion: REVIEW_DECISIONS_SCHEMA_VERSION,
      decisions: [],
    }) !== digest(decisions)
  ) {
    invalid('已有裁决完整文件与严格解析结果不一致');
  }
  const findings = review.state.axes.flatMap((axis) => axis.findings);
  return {
    review: review.state,
    reviewFile: reviewFileAfter,
    reviewDigest: digest(review.state),
    bindingDigest: digestReviewBinding(review.state.binding),
    findingsDigest: digest(findings),
    decisionsFile: decisionsFileAfter,
    decisionsDigest: digest(decisions),
    decisions,
  };
}

function sameDecisionArtifacts(
  left: DecisionArtifactsSnapshot,
  right: DecisionArtifactsSnapshot,
): boolean {
  return (
    sameWorkspaceFile(left.reviewFile, right.reviewFile) &&
    left.reviewDigest === right.reviewDigest &&
    left.bindingDigest === right.bindingDigest &&
    left.findingsDigest === right.findingsDigest &&
    sameWorkspaceFile(left.decisionsFile, right.decisionsFile) &&
    left.decisionsDigest === right.decisionsDigest
  );
}

function normalizeBindingObservation(
  value: ReviewBinding | DecisionBindingObservation,
): DecisionBindingObservation {
  if ('binding' in value) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(value.storyObservationToken)) {
      invalid('Story 验收观察令牌非法');
    }
    return value;
  }
  return {
    binding: value,
    storyObservationToken: digest({ testBinding: digestReviewBinding(value) }),
  };
}

async function observeDecisionCheckpoint(options: {
  workspace: string;
  readBinding: () =>
    | ReviewBinding
    | DecisionBindingObservation
    | Promise<ReviewBinding | DecisionBindingObservation>;
  readHead: () => string | Promise<string>;
}): Promise<DecisionCheckpoint> {
  const artifactsBefore = readDecisionArtifacts(options.workspace);
  const binding = normalizeBindingObservation(await options.readBinding());
  const headSha = await options.readHead();
  const artifactsAfter = readDecisionArtifacts(options.workspace);
  if (!sameDecisionArtifacts(artifactsBefore, artifactsAfter)) {
    invalid('重核裁决当前性期间 Final Review、finding 或已有裁决发生变化');
  }
  return {
    artifacts: artifactsAfter,
    binding: binding.binding,
    storyObservationToken: binding.storyObservationToken,
    headSha,
  };
}

function assertSameCheckpoint(
  phase: string,
  expected: DecisionCheckpoint,
  current: DecisionCheckpoint,
): void {
  if (!sameDecisionArtifacts(expected.artifacts, current.artifacts)) {
    invalid(`${phase} Final Review、finding 或已有裁决已变化；未写入决定`);
  }
  if (digestReviewBinding(current.binding) !== digestReviewBinding(expected.binding)) {
    invalid(`${phase} Final Review binding 已变化；请重新运行 coding-x`);
  }
  if (current.storyObservationToken !== expected.storyObservationToken) {
    invalid(`${phase} Story 验收权威输入已变化；请重新运行 coding-x`);
  }
  if (current.headSha !== expected.headSha) {
    invalid(`${phase} Git HEAD 发生变化；未写入决定`);
  }
}

function isolateDecisionSession(options: RecordReviewDecisionOptions, message: string): never {
  if (options.session.state === 'open') options.session.retainLeaseForIsolation();
  throw new WorkspaceSafetyError('isolated', message);
}

async function rollbackWrittenDecision(options: {
  command: RecordReviewDecisionOptions;
  workspace: string;
  original: RawWorkspaceFileSnapshot;
  written: RawWorkspaceFileSnapshot;
}): Promise<void> {
  try {
    const path = join(options.workspace, REVIEW_DECISIONS_FILE);
    const current = workspaceFileSnapshot(path);
    if (!sameWorkspaceFile(current, options.written)) {
      isolateDecisionSession(
        options.command,
        '裁决写入后的当前性检查失败，且裁决文件又被并发改写；workspace 已隔离',
      );
    }
    if (options.original.status === 'missing') {
      await options.command.session.writer.removeFile(REVIEW_DECISIONS_FILE);
    } else {
      await options.command.session.writer.writeFile(
        REVIEW_DECISIONS_FILE,
        options.original.bytes!,
      );
    }
    const restored = workspaceFileSnapshot(path);
    if (!sameWorkspaceFile(restored, options.original)) {
      isolateDecisionSession(
        options.command,
        '裁决写入后发生漂移且无法证明原裁决已恢复；workspace 已隔离',
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceSafetyError && error.code === 'isolated') throw error;
    isolateDecisionSession(
      options.command,
      `裁决写入后发生漂移且无法安全读取或恢复原裁决；workspace 已隔离：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Appends one user-authorized decision while binding engine-issued HEAD, time, finding and policy.
 * The caller cannot provide paths, timestamps, or a head SHA.
 */
export async function recordReviewDecision(
  options: RecordReviewDecisionOptions,
): Promise<ReviewDecision> {
  if (options.session.lease.owner.command !== 'review-decision') {
    invalid('review decision 必须使用 review-decision workspace session');
  }
  const request = parseReviewDecisionRequest(options.request);
  const workspace = options.session.lease.workspace.path;
  const observation =
    options.observation ??
    createManagedReviewObservation({
      session: options.session,
      root: options.root,
      termination: options.termination,
    });
  const seedArtifacts = readDecisionArtifacts(workspace);
  if (
    digestQualityContract(options.contract) !== seedArtifacts.review.binding.qualityContractDigest
  ) {
    invalid('提供的质量契约与 Final Review 绑定不一致');
  }
  const readBinding =
    options.readBinding ??
    createCurrentBindingReader({
      session: options.session,
      root: options.root,
      contract: options.contract,
      review: seedArtifacts.review,
      observation,
      termination: options.termination,
    });
  const readHead = options.readHead ?? (() => currentGitHead(observation));
  const initial = await observeDecisionCheckpoint({ workspace, readBinding, readHead });
  if (!sameDecisionArtifacts(seedArtifacts, initial.artifacts)) {
    invalid('建立裁决初始快照期间 Final Review、finding 或已有裁决发生变化');
  }
  const expectedBindingDigest = initial.artifacts.bindingDigest;
  if (digestReviewBinding(initial.binding) !== expectedBindingDigest) {
    invalid('当前重建的 Final Review binding 与已保存 Review 不一致；请重新运行 coding-x');
  }
  if (initial.headSha !== initial.artifacts.review.binding.headSha) {
    invalid('当前 Git HEAD 与 Final Review 绑定不一致；请重新运行 coding-x');
  }
  const finding = findCurrentFinding(
    initial.artifacts.review.axes.flatMap((axis) => axis.findings),
    request.findingId,
  );
  validateAction(request, finding);

  const assertCurrent = async (phase: string): Promise<void> => {
    const current = await observeDecisionCheckpoint({ workspace, readBinding, readHead });
    assertSameCheckpoint(phase, initial, current);
  };

  const client = options.client ?? observation.github;
  const validateDeferralIssue = async (): Promise<void> => {
    if (request.action === 'p1-deferred') {
      if (!client.getIssue) invalid('当前 GitHub 适配器无法核验延期 Issue');
      const issue = await client.getIssue(options.contract.repository.fullName, request.issue!);
      const errors = validateP1DeferralIssue(
        issue,
        options.contract.exceptions.p1.maxDays,
        (options.now ?? (() => new Date()))(),
      );
      if (errors.length > 0) invalid(`延期 Issue 无效：${errors.join('；')}`);
    }
  };
  await validateDeferralIssue();
  await assertCurrent('延期 Issue 查询后');

  const at = (options.now ?? (() => new Date()))().toISOString();
  const decision: ReviewDecision = {
    findingId: finding.id,
    headSha: initial.artifacts.review.binding.headSha,
    reviewBindingDigest: expectedBindingDigest,
    action: request.action,
    operator: request.operator,
    at,
    ...(request.evidence === undefined ? {} : { evidence: request.evidence }),
    ...(request.issue === undefined ? {} : { issue: request.issue }),
  };

  await options.beforeCommit?.();
  await assertCurrent('beforeCommit 后');
  await validateDeferralIssue();
  await assertCurrent('第二次延期 Issue 查询后');
  await assertCurrent('最终写入前');
  await options.session.lease.verify();
  const nextDecisions: ReturnType<typeof readReviewDecisions> = {
    schemaVersion: REVIEW_DECISIONS_SCHEMA_VERSION,
    decisions: [...initial.artifacts.decisions.decisions, decision],
  };
  const serialized = `${JSON.stringify(nextDecisions, null, 2)}\n`;
  await options.session.writer.writeFile(REVIEW_DECISIONS_FILE, serialized);
  const writtenFile: RawWorkspaceFileSnapshot = {
    status: 'ready',
    digest: `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
    bytes: Buffer.from(serialized, 'utf8'),
  };
  const expectedPostWrite: DecisionCheckpoint = {
    ...initial,
    artifacts: {
      ...initial.artifacts,
      decisionsFile: writtenFile,
      decisionsDigest: digest(nextDecisions),
      decisions: nextDecisions,
    },
  };
  try {
    await options.afterCommit?.();
    const postWrite = await observeDecisionCheckpoint({ workspace, readBinding, readHead });
    assertSameCheckpoint('裁决写入后', expectedPostWrite, postWrite);
  } catch (error) {
    await rollbackWrittenDecision({
      command: options,
      workspace,
      original: initial.artifacts.decisionsFile,
      written: writtenFile,
    });
    invalid(
      `裁决写入后当前性发生变化，已恢复原裁决：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return decision;
}

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
import {
  REVIEW_DECISIONS_FILE,
  REVIEW_DECISIONS_SCHEMA_VERSION,
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
  readonly readBinding?: () => ReviewBinding | Promise<ReviewBinding>;
  /** Test-only race seam. Production callers do not provide this. */
  readonly beforeCommit?: () => void | Promise<void>;
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
}): () => Promise<ReviewBinding> {
  let context: ReviewPreflightContext | undefined;
  return async () => {
    if (!context) {
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
    return createReviewBinding({
      context,
      risk: options.review.risk,
      codingXVersion: CODING_X_VERSION,
      runner: options.review.binding.runner,
      model: options.review.binding.model,
      runnerVersion,
    });
  };
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
  const review = readFinalReviewState(workspace);
  if (review.status !== 'ready') {
    invalid(
      review.status === 'missing'
        ? '缺少当前 Final Review；请先重新运行 coding-x'
        : `Final Review 无效：${review.error}`,
    );
  }
  if (digestQualityContract(options.contract) !== review.state.binding.qualityContractDigest) {
    invalid('提供的质量契约与 Final Review 绑定不一致');
  }
  const expectedBindingDigest = digestReviewBinding(review.state.binding);
  const readBinding =
    options.readBinding ??
    createCurrentBindingReader({
      session: options.session,
      root: options.root,
      contract: options.contract,
      review: review.state,
      observation,
      termination: options.termination,
    });
  const assertCurrentBinding = async (phase: string): Promise<void> => {
    const current = await readBinding();
    if (digestReviewBinding(current) !== expectedBindingDigest) {
      invalid(`${phase} Final Review binding 已变化；请重新运行 coding-x`);
    }
  };
  await assertCurrentBinding('记录裁决前');

  const readHead = options.readHead ?? (() => currentGitHead(observation));
  const initialHead = await readHead();
  if (initialHead !== review.state.binding.headSha) {
    invalid('当前 Git HEAD 与 Final Review 绑定不一致；请重新运行 coding-x');
  }
  const finding = findCurrentFinding(
    review.state.axes.flatMap((axis) => axis.findings),
    request.findingId,
  );
  validateAction(request, finding);

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

  const current = readReviewDecisions(workspace);
  const currentDecisionsDigest = digest(current);
  const at = (options.now ?? (() => new Date()))().toISOString();
  const decision: ReviewDecision = {
    findingId: finding.id,
    headSha: review.state.binding.headSha,
    reviewBindingDigest: expectedBindingDigest,
    action: request.action,
    operator: request.operator,
    at,
    ...(request.evidence === undefined ? {} : { evidence: request.evidence }),
    ...(request.issue === undefined ? {} : { issue: request.issue }),
  };

  await options.beforeCommit?.();
  await validateDeferralIssue();
  await assertCurrentBinding('提交裁决前');
  if ((await readHead()) !== initialHead) {
    invalid('裁决过程中 Git HEAD 发生变化；未写入决定');
  }
  if (digest(readReviewDecisions(workspace)) !== currentDecisionsDigest) {
    invalid('裁决过程中已有决定发生变化；未写入决定');
  }
  await options.session.lease.verify();
  await options.session.writer.writeFile(
    REVIEW_DECISIONS_FILE,
    `${JSON.stringify(
      {
        schemaVersion: REVIEW_DECISIONS_SCHEMA_VERSION,
        decisions: [...current.decisions, decision],
      },
      null,
      2,
    )}\n`,
  );
  return decision;
}

import { appendQualityReceipt, nextReceiptRound } from './receipt.js';
import { readQualityContract, readQualityExceptions } from './contract.js';
import {
  GitHubClient,
  parseGitHubPullRequestEvent,
} from './github.js';
import { gitHead, type GitDiffBundle } from './git.js';
import {
  parseReviewIntent,
  selectReviewSpecPaths,
  type ReviewIntent,
} from './intent.js';
import { assessDeepReviewRisk } from './risk.js';
import {
  buildReviewPrompts,
  estimateReviewPromptTokens,
  preSplitReviewPromptShard,
  splitReviewPromptShard,
  type ReviewPromptShard,
  type ReviewSource,
} from './prompts.js';
import { callGitHubModel, type ModelFailureReason } from './model.js';
import {
  evaluateReviewModelResult,
  renderReviewCheck,
  validateReviewOutputGrounding,
} from './review.js';
import type {
  QualityError,
  QualityReceipt,
  ReviewAxis,
  ReviewModelOutput,
} from './types.js';

const CHECK_NAMES: Record<ReviewAxis, string> = {
  spec: 'coding-x / spec-review',
  standards: 'coding-x / standards-review',
  deep: 'coding-x / deep-review',
};
const SOURCE_COUNT_LIMIT = 100;
const SOURCE_TOTAL_LIMIT = 500 * 1024;
const SOURCE_FILE_LIMIT = 128 * 1024;
const MODEL_SHARD_LIMIT = 8;
const MODEL_PROMPT_TOKEN_BUDGET = 7_000;
const MODEL_CALL_PACE_MS = 6_500;
const AGGREGATE_FINDING_LIMIT = 50;

export type ModelCall = (opts: {
  token: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  axis: ReviewAxis;
}) => Promise<
  | { status: 'valid'; output: ReviewModelOutput; error: null }
  | {
      status: 'invalid';
      output: null;
      error: string;
      reason?: ModelFailureReason;
    }
>;

const SEVERITY_RANK = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
} as const;

function aggregateReviewOutputs(
  outputs: ReviewModelOutput[],
): ReviewModelOutput | null {
  const findings = new Map<string, ReviewModelOutput['findings'][number]>();
  for (const output of outputs) {
    for (const finding of output.findings) {
      const current = findings.get(finding.id);
      if (!current || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current.severity]) {
        findings.set(finding.id, finding);
      }
    }
  }
  if (findings.size > AGGREGATE_FINDING_LIMIT) return null;
  return {
    summary: outputs.length === 1
      ? outputs[0].summary
      : `完整覆盖 ${outputs.length} 个隔离输入分片；合并后发现 ${findings.size} 项问题。`,
    findings: [...findings.values()],
  };
}

function matchesSelector(path: string, selector: string): boolean {
  const normalized = selector.replace(/\\/g, '/');
  return normalized.endsWith('/') ? path.startsWith(normalized) : path === normalized;
}

async function collectRemoteSources(
  client: GitHubClient,
  ref: string,
  selectors: string[],
): Promise<ReviewSource[]> {
  const tree = await client.getTreePaths(ref);
  const paths = tree.filter((path) => selectors.some((selector) => matchesSelector(path, selector)));
  return readRemoteSources(client, ref, paths, false);
}

async function readRemoteSources(
  client: GitHubClient,
  ref: string,
  paths: string[],
  allowEmpty: boolean,
): Promise<ReviewSource[]> {
  if (paths.length === 0 && allowEmpty) return [];
  if (paths.length === 0) throw new Error('没有找到任何评审来源文件');
  if (paths.length > SOURCE_COUNT_LIMIT) throw new Error('评审来源文件超过 100 个');
  const sources: ReviewSource[] = [];
  let total = 0;
  for (const path of paths.sort()) {
    const content = await client.getTextFile(path, ref, SOURCE_FILE_LIMIT);
    total += Buffer.byteLength(content);
    if (total > SOURCE_TOTAL_LIMIT) throw new Error('评审来源超过总读取上限');
    sources.push({ path, content });
  }
  return sources;
}

function fallbackIntent(title: string, body: string): ReviewIntent {
  const context = [title, body].filter(Boolean).join('\n\n').trim() || 'PR 未提供文字背景';
  return {
    intent: context,
    acceptanceCriteria: '未提供（Spec 轴会阻断）',
    nonGoals: '未提供（Spec 轴会阻断）',
    verification: '未提供（Spec 轴会阻断）',
  };
}

function receiptWithError(opts: {
  workspace: string;
  axis: ReviewAxis;
  now: Date;
  repository: string | null;
  baseSha: string | null;
  headSha: string | null;
  contractSha256: string | null;
  model?: string;
  deepRequired?: boolean;
  deepReasons?: string[];
  error: QualityError;
  started: number;
}): QualityReceipt {
  return {
    version: 1,
    kind: 'review',
    round: nextReceiptRound(opts.workspace, 'review', opts.axis),
    status: 'unverifiable',
    at: opts.now.toISOString(),
    repository: opts.repository,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    contractSha256: opts.contractSha256,
    axis: opts.axis,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.deepRequired === undefined ? {} : { deepRequired: opts.deepRequired }),
    ...(opts.deepReasons === undefined ? {} : { deepReasons: opts.deepReasons }),
    findings: [],
    exceptions: [],
    errors: [opts.error],
    durationMs: Date.now() - opts.started,
  };
}

async function publish(
  client: GitHubClient,
  receipt: QualityReceipt,
): Promise<{ id: number; url: string | null }> {
  const rendered = renderReviewCheck(receipt);
  return client.createCheckRun({
    name: CHECK_NAMES[receipt.axis!],
    headSha: receipt.headSha!,
    status: receipt.status,
    title: rendered.title,
    summary: rendered.summary,
    text: rendered.text,
  });
}

export async function runGitHubReviewAxis(opts: {
  root: string;
  workspace: string;
  eventPath: string;
  axis: ReviewAxis;
  token: string;
  modelToken?: string;
  client?: GitHubClient;
  modelCall?: ModelCall;
  modelPause?: (ms: number) => Promise<void>;
  modelPaceMs?: number;
  now?: Date;
}): Promise<{ receipt: QualityReceipt; check: { id: number; url: string | null } | null }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  let event;
  try {
    event = parseGitHubPullRequestEvent(opts.eventPath);
  } catch (error) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: null,
      baseSha: null,
      headSha: null,
      contractSha256: null,
      error: { code: 'github-event-invalid', message: error instanceof Error ? error.message : String(error) },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: null };
  }
  const client = opts.client ?? new GitHubClient(opts.token, event.repository);
  const contractRead = readQualityContract(opts.root);
  if (contractRead.status !== 'valid') {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: null,
      error: {
        code: 'contract-invalid',
        message: contractRead.status === 'missing'
          ? '默认分支缺少 .coding-x/quality.json'
          : contractRead.errors.join('；'),
      },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const contract = contractRead.contract;
  const baseIdentityValid = contract.github.repository === event.repository
    && contract.github.defaultBranch === event.baseRef;
  let localBase: string | null = null;
  try {
    localBase = gitHead(opts.root);
  } catch {
    // Report through the shared identity error below.
  }
  if (!baseIdentityValid || localBase !== event.baseSha) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      error: {
        code: 'trusted-base-mismatch',
        message: '本次评审未运行在事件指定的默认分支 base SHA 与契约上',
      },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }

  let current;
  try {
    current = await client.getPullIdentity(event.number);
  } catch (error) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      error: { code: 'github-pr-read-failed', message: error instanceof Error ? error.message : String(error) },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  if (current.headSha !== event.headSha || current.baseSha !== event.baseSha) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      error: { code: 'stale-head', message: `PR 已变化，当前 head=${current.headSha}` },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }

  const intentRead = parseReviewIntent(current.body);
  if (opts.axis === 'spec' && intentRead.status === 'invalid') {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      error: { code: 'intent-missing', message: `PR 缺少：${intentRead.missing.join('、')}` },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const intent = intentRead.status === 'valid'
    ? intentRead.intent
    : fallbackIntent(current.title, current.body);
  const specification = intentRead.status === 'valid'
    ? intentRead.specification
    : null;

  let diff: string;
  let files: Awaited<ReturnType<GitHubClient['getPullFiles']>>;
  try {
    [diff, files] = await Promise.all([
      client.getPullDiff(event.number),
      client.getPullFiles(event.number),
    ]);
  } catch (error) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      error: { code: 'github-diff-read-failed', message: error instanceof Error ? error.message : String(error) },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const incompleteFiles = files.filter((file) =>
    file.status !== 'removed' && file.patch === null);
  if ((files.length > 0 && diff.trim() === '') || incompleteFiles.length > 0) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      error: {
        code: 'diff-incomplete',
        message: incompleteFiles.length > 0
          ? `GitHub 未提供完整 patch：${incompleteFiles.slice(0, 10).map((file) => file.filename).join('、')}`
          : 'GitHub 返回了文件列表，但 diff 为空',
      },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const lineCounts = new Map<string, number | null>();
  await Promise.all(files.slice(0, 100).map(async (file) => {
    try {
      const text = await client.getTextFile(
        file.filename,
        event.headSha,
        Math.max(128 * 1024, contract.review.deepReview.largeFileLines * 500),
      );
      lineCounts.set(file.filename, text.split(/\r?\n/).length);
    } catch {
      lineCounts.set(file.filename, null);
    }
  }));
  const bundle: GitDiffBundle = {
    baseSha: event.baseSha,
    headSha: event.headSha,
    diff,
    changedFiles: files.map((file) => file.filename),
    numstat: files.map((file) => ({
      path: file.filename,
      added: file.patch === null && file.status !== 'removed' ? null : file.additions,
      deleted: file.patch === null && file.status !== 'removed' ? null : file.deletions,
    })),
  };
  const risk = assessDeepReviewRisk(
    bundle,
    contract.review.deepReview,
    (path) => lineCounts.has(path) ? lineCounts.get(path)! : null,
  );
  if (opts.axis === 'deep' && !risk.required) {
    try {
      const latest = await client.getPullIdentity(event.number);
      if (latest.headSha !== event.headSha || latest.baseSha !== event.baseSha) {
        const receipt = receiptWithError({
          workspace: opts.workspace,
          axis: 'deep',
          now,
          repository: event.repository,
          baseSha: event.baseSha,
          headSha: event.headSha,
          contractSha256: contractRead.sha256,
          model: contract.review.model,
          deepRequired: false,
          deepReasons: [],
          error: {
            code: 'stale-head',
            message: `风险判定后 PR 身份已变化，当前 head=${latest.headSha}`,
          },
          started,
        });
        appendQualityReceipt(opts.workspace, receipt);
        return { receipt, check: await publish(client, receipt) };
      }
    } catch (error) {
      const receipt = receiptWithError({
        workspace: opts.workspace,
        axis: 'deep',
        now,
        repository: event.repository,
        baseSha: event.baseSha,
        headSha: event.headSha,
        contractSha256: contractRead.sha256,
        model: contract.review.model,
        deepRequired: false,
        deepReasons: [],
        error: {
          code: 'github-pr-recheck-failed',
          message: error instanceof Error ? error.message : String(error),
        },
        started,
      });
      appendQualityReceipt(opts.workspace, receipt);
      return { receipt, check: await publish(client, receipt) };
    }
    const receipt: QualityReceipt = {
      version: 1,
      kind: 'review',
      round: nextReceiptRound(opts.workspace, 'review', 'deep'),
      status: 'passed',
      at: now.toISOString(),
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      axis: 'deep',
      model: contract.review.model,
      deepRequired: false,
      deepReasons: [],
      findings: [],
      exceptions: [],
      errors: [],
      durationMs: Date.now() - started,
    };
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }

  const selectors = opts.axis === 'spec'
    ? contract.review.specSources
    : contract.review.standardsSources;
  const sourceRef = opts.axis === 'spec' ? event.headSha : event.baseSha;
  let sources: ReviewSource[];
  try {
    if (opts.axis === 'spec') {
      if (!specification) throw new Error('PR 没有可用的关联规格声明');
      const tree = await client.getTreePaths(sourceRef);
      const available = tree.filter((path) =>
        selectors.some((selector) => matchesSelector(path, selector)));
      const selected = selectReviewSpecPaths(
        specification,
        available,
        files.map((file) => file.filename),
      );
      sources = await readRemoteSources(client, sourceRef, selected, true);
    } else {
      sources = await collectRemoteSources(client, sourceRef, selectors);
    }
  } catch (error) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: { code: 'review-source-invalid', message: error instanceof Error ? error.message : String(error) },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const modelCall = opts.modelCall ?? callGitHubModel;
  const modelPause = opts.modelPause
    ?? (opts.modelCall ? async () => {} : async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const modelPaceMs = opts.modelPaceMs ?? MODEL_CALL_PACE_MS;
  const changedFiles = files.map((file) => file.filename);
  const diffByFile = new Map(files.map((file) => [file.filename, file.patch ?? '']));
  const initialShard: ReviewPromptShard = { sources, diff, fragmented: false };
  const initialPrompts = buildReviewPrompts(opts.axis, {
    repository: event.repository,
    baseSha: event.baseSha,
    headSha: event.headSha,
    contractSha256: contractRead.sha256,
    intent,
    changedFiles,
    diff,
    sources,
    allSourcePaths: sources.map((source) => source.path),
    deepReasons: risk.reasons,
    fragmented: false,
  });
  if (initialPrompts.status === 'invalid') {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: { code: 'review-input-too-large', message: initialPrompts.error },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const promptForShard = (shard: ReviewPromptShard) => buildReviewPrompts(opts.axis, {
    repository: event.repository,
    baseSha: event.baseSha,
    headSha: event.headSha,
    contractSha256: contractRead.sha256,
    intent,
    changedFiles,
    diff: shard.diff,
    sources: shard.sources,
    allSourcePaths: sources.map((source) => source.path),
    deepReasons: risk.reasons,
    fragmented: shard.fragmented,
  });
  const prepared = preSplitReviewPromptShard(initialShard, {
    maxShards: MODEL_SHARD_LIMIT,
    maxWeight: MODEL_PROMPT_TOKEN_BUDGET,
    weight: (shard) => {
      const prompts = promptForShard(shard);
      return prompts.status === 'valid'
        ? estimateReviewPromptTokens(prompts.system, prompts.user)
        : Number.POSITIVE_INFINITY;
    },
  });
  if (!prepared.withinBudget) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: {
        code: 'review-input-too-large',
        message: `完整输入需要多于 ${MODEL_SHARD_LIMIT} 个无损分片；请缩小评审来源或拆分 PR`,
      },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const pending = [...prepared.shards];
  const modelOutputs: ReviewModelOutput[] = [];
  let reviewError: QualityError | null = null;
  let modelCallCount = 0;
  while (pending.length > 0) {
    const shard = pending.shift()!;
    const prompts = promptForShard(shard);
    if (prompts.status === 'invalid') {
      reviewError = { code: 'review-input-too-large', message: prompts.error };
      break;
    }
    if (modelCallCount > 0 && modelPaceMs > 0) await modelPause(modelPaceMs);
    modelCallCount += 1;
    let modelResult: Awaited<ReturnType<ModelCall>>;
    try {
      modelResult = await modelCall({
        token: opts.modelToken ?? opts.token,
        model: contract.review.model,
        systemPrompt: prompts.system,
        userPrompt: prompts.user,
        axis: opts.axis,
      });
    } catch (error) {
      modelResult = {
        status: 'invalid',
        output: null,
        error: `模型调用异常：${error instanceof Error ? error.message : String(error)}`,
        reason: 'provider-error',
      };
    }
    if (modelResult.status === 'valid') {
      const groundingError = validateReviewOutputGrounding(modelResult.output, {
        diff: shard.diff,
        sources: shard.sources,
        diffByFile,
      });
      if (groundingError) {
        reviewError = { code: 'model-output-invalid', message: groundingError };
        break;
      }
      modelOutputs.push(modelResult.output);
      continue;
    }
    const inputTooLarge = modelResult.reason === 'input-too-large'
      || /HTTP 413.*tokens_limit_reached/s.test(modelResult.error);
    if (!inputTooLarge) {
      reviewError = { code: 'model-output-invalid', message: modelResult.error };
      break;
    }
    const split = splitReviewPromptShard(shard);
    if (!split || modelOutputs.length + pending.length + split.length > MODEL_SHARD_LIMIT) {
      reviewError = {
        code: 'review-input-too-large',
        message: `完整输入超过 GitHub Models 单次额度，且需要多于 ${MODEL_SHARD_LIMIT} 个分片；请缩小评审来源或拆分 PR`,
      };
      break;
    }
    pending.unshift(...split);
  }
  if (reviewError) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: reviewError,
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const modelOutput = aggregateReviewOutputs(modelOutputs);
  if (!modelOutput) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: {
        code: 'model-output-invalid',
        message: `分片评审合并后超过 ${AGGREGATE_FINDING_LIMIT} 个问题，请缩小 PR`,
      },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const changedFileSet = new Set([
    ...changedFiles,
    ...sources.map((source) => source.path),
  ]);
  const outOfScopeFinding = modelOutput.findings.find((finding) =>
    !changedFileSet.has(finding.file));
  if (outOfScopeFinding) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: {
        code: 'model-output-invalid',
        message: `finding 指向既非变更文件也非评审来源的路径：${outOfScopeFinding.file}`,
      },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  try {
    const latest = await client.getPullIdentity(event.number);
    if (latest.headSha !== event.headSha || latest.baseSha !== event.baseSha) {
      const receipt = receiptWithError({
        workspace: opts.workspace,
        axis: opts.axis,
        now,
        repository: event.repository,
        baseSha: event.baseSha,
        headSha: event.headSha,
        contractSha256: contractRead.sha256,
        model: contract.review.model,
        deepRequired: opts.axis === 'deep' ? risk.required : undefined,
        deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
        error: {
          code: 'stale-head',
          message: `模型返回前 PR 身份已变化，当前 head=${latest.headSha}`,
        },
        started,
      });
      appendQualityReceipt(opts.workspace, receipt);
      return { receipt, check: await publish(client, receipt) };
    }
  } catch (error) {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: {
        code: 'github-pr-recheck-failed',
        message: error instanceof Error ? error.message : String(error),
      },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const exceptionsRead = readQualityExceptions(opts.root, contract.exceptionsFile);
  if (exceptionsRead.status !== 'valid') {
    const receipt = receiptWithError({
      workspace: opts.workspace,
      axis: opts.axis,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      model: contract.review.model,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: {
        code: 'exceptions-invalid',
        message: exceptionsRead.status === 'missing'
          ? `默认分支缺少异常记录文件：${exceptionsRead.path}`
          : exceptionsRead.errors.join('；'),
      },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const evaluated = evaluateReviewModelResult(
    modelOutput,
    exceptionsRead.value.exceptions,
    event.headSha,
    now,
    contract.exceptionPolicy.deferrableSeverities,
  );
  const round = nextReceiptRound(opts.workspace, 'review', opts.axis);
  const receipt: QualityReceipt = {
    version: 1,
    kind: 'review',
    round,
    status: evaluated.status,
    at: now.toISOString(),
    repository: event.repository,
    baseSha: event.baseSha,
    headSha: event.headSha,
    contractSha256: contractRead.sha256,
    axis: opts.axis,
    model: contract.review.model,
    ...(opts.axis === 'deep'
      ? { deepRequired: risk.required, deepReasons: risk.reasons }
      : {}),
    reviewSummary: evaluated.summary,
    findings: evaluated.findings.map((finding) => ({
      ...finding,
      headSha: event.headSha,
      round,
    })),
    exceptions: evaluated.exceptionIds,
    errors: [],
    durationMs: Date.now() - started,
  };
  appendQualityReceipt(opts.workspace, receipt);
  return { receipt, check: await publish(client, receipt) };
}

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
import { callCopilotModel, type ModelFailureReason } from './model.js';
import {
  evaluateReviewModelResult,
  renderReviewCheck,
  validateReviewOutputGrounding,
  validateReviewOutputSemantics,
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
const MODEL_CALL_PACE_MS = 0;
const AGGREGATE_FINDING_LIMIT = 50;

function correctionSystemPrompt(system: string, reason: string): string {
  return [
    system,
    '调用方机械拒绝了上一份输出。下面的拒绝原因由调用方生成，不来自仓库数据：',
    reason,
    '请从头重审同一份用户数据并返回一份完整 JSON；不得沿用上一份 summary 或 findings。',
    '如果上一份 finding 只是正向确认、测试覆盖说明或明确表示无需修改，请删除该 finding，'
      + '只在 summary 中陈述正向结论。若保留真实缺陷，evidence 必须逐字摘录当前分片中'
      + ' finding.file 对应的 source 或 diff；引用 diff 代码时可省略每行补丁控制前缀。',
  ].join('\n\n');
}

function correctionReasonForOutput(
  output: ReviewModelOutput,
  shard: ReviewPromptShard,
  diffByFile: ReadonlyMap<string, string>,
): string | null {
  if (validateReviewOutputSemantics(output)) {
    return '上一份 finding 实际表示无需修改或无需行动，不能作为缺陷。';
  }
  if (validateReviewOutputGrounding(output, {
    diff: shard.diff,
    sources: shard.sources,
    diffByFile,
  })) {
    return '上一份 finding 的 evidence 不是当前分片中对应文件的逐字原文。';
  }
  return null;
}

export type ModelCall = (opts: {
  token: string;
  model: string;
  cliVersion: string;
  systemPrompt: string;
  userPrompt: string;
  axis: ReviewAxis;
}) => Promise<
  | {
      status: 'valid';
      output: ReviewModelOutput;
      error: null;
      model?: string;
      premiumRequests?: number;
    }
  | {
      status: 'invalid';
      output: null;
      error: string;
      reason?: ModelFailureReason;
      model?: string;
      premiumRequests?: number;
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
  modelCalls?: number;
  premiumRequests?: number;
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
    ...(opts.modelCalls === undefined ? {} : { modelCalls: opts.modelCalls }),
    ...(opts.premiumRequests === undefined ? {} : { premiumRequests: opts.premiumRequests }),
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
  let receiptModel = `${contract.review.provider}:${contract.review.model}`;
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
      model: receiptModel,
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
      model: receiptModel,
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
      model: receiptModel,
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
      model: receiptModel,
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
      model: receiptModel,
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
      model: receiptModel,
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
          model: receiptModel,
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
        model: receiptModel,
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
      model: receiptModel,
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
      model: receiptModel,
      deepRequired: opts.axis === 'deep' ? risk.required : undefined,
      deepReasons: opts.axis === 'deep' ? risk.reasons : undefined,
      error: { code: 'review-source-invalid', message: error instanceof Error ? error.message : String(error) },
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: await publish(client, receipt) };
  }
  const modelCall = opts.modelCall ?? callCopilotModel;
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
      model: receiptModel,
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
      model: receiptModel,
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
  let premiumRequests = 0;
  const observedModels = new Set<string>();
  const invokeModel = async (
    prompts: { system: string; user: string },
    systemPrompt = prompts.system,
  ): Promise<Awaited<ReturnType<ModelCall>>> => {
    if (modelCallCount > 0 && modelPaceMs > 0) await modelPause(modelPaceMs);
    modelCallCount += 1;
    try {
      const result = await modelCall({
        token: opts.token,
        model: contract.review.model,
        cliVersion: contract.review.copilotCliVersion,
        systemPrompt,
        userPrompt: prompts.user,
        axis: opts.axis,
      });
      premiumRequests += result.premiumRequests ?? 0;
      if (result.model) {
        observedModels.add(result.model);
        receiptModel = `${contract.review.provider}:${result.model}`;
      }
      if (observedModels.size > 1) {
        return {
          status: 'invalid',
          output: null,
          error: `同一评审轴使用了不一致的实际模型：${[...observedModels].sort().join('、')}`,
          reason: 'invalid-output',
        };
      }
      return result;
    } catch (error) {
      return {
        status: 'invalid',
        output: null,
        error: `模型调用异常：${error instanceof Error ? error.message : String(error)}`,
        reason: 'provider-error',
      };
    }
  };
  while (pending.length > 0) {
    const shard = pending.shift()!;
    const prompts = promptForShard(shard);
    if (prompts.status === 'invalid') {
      reviewError = { code: 'review-input-too-large', message: prompts.error };
      break;
    }
    let modelResult = await invokeModel(prompts);
    const initialOutputError = modelResult.status === 'valid'
      ? correctionReasonForOutput(modelResult.output, shard, diffByFile)
      : modelResult.reason === 'invalid-output'
        ? '上一份输出不符合要求的 JSON 结构。'
        : null;
    if (initialOutputError) {
      modelResult = await invokeModel(
        prompts,
        correctionSystemPrompt(prompts.system, initialOutputError),
      );
    }
    if (modelResult.status === 'valid') {
      const outputError = validateReviewOutputSemantics(modelResult.output)
        ?? validateReviewOutputGrounding(modelResult.output, {
          diff: shard.diff,
          sources: shard.sources,
          diffByFile,
        });
      if (outputError) {
        reviewError = { code: 'model-output-invalid', message: outputError };
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
        message: `完整输入超过 AI provider 单次额度，且需要多于 ${MODEL_SHARD_LIMIT} 个分片；请缩小评审来源或拆分 PR`,
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
      model: receiptModel,
      modelCalls: modelCallCount,
      premiumRequests,
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
      model: receiptModel,
      modelCalls: modelCallCount,
      premiumRequests,
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
      model: receiptModel,
      modelCalls: modelCallCount,
      premiumRequests,
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
        model: receiptModel,
        modelCalls: modelCallCount,
        premiumRequests,
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
      model: receiptModel,
      modelCalls: modelCallCount,
      premiumRequests,
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
      model: receiptModel,
      modelCalls: modelCallCount,
      premiumRequests,
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
    model: receiptModel,
    modelCalls: modelCallCount,
    premiumRequests,
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

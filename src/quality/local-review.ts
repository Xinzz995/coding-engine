import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AgentKind } from '../engine/agent.js';
import { writeFileAtomicSync } from '../engine/fs-atomic.js';
import { readQualityContract, readQualityExceptions } from './contract.js';
import {
  collectGitDiff,
  gitText,
  readTextAtRef,
  trackedPathsAtRef,
} from './git.js';
import { parseReviewIntent } from './intent.js';
import { assessDeepReviewRisk } from './risk.js';
import {
  appendQualityReceipt,
  nextReceiptRound,
} from './receipt.js';
import {
  buildReviewPrompts,
  type ReviewSource,
} from './prompts.js';
import { evaluateReviewModelResult } from './review.js';
import { runReadOnlyReviewAgent } from './review-agent.js';
import type {
  QualityReceipt,
  QualityStatus,
  ReviewAxis,
  ReviewModelOutput,
} from './types.js';

type AgentCall = (opts: {
  kind: AgentKind;
  axis: ReviewAxis;
  prompt: string;
  cwd: string;
  model?: string;
}) => Promise<
  | { status: 'valid'; output: ReviewModelOutput; error: null; durationMs: number }
  | { status: 'invalid'; output: null; error: string; durationMs: number }
>;

function sourcePaths(root: string, ref: string, selectors: string[]): string[] {
  return trackedPathsAtRef(root, ref, selectors);
}

function sourcesAtRef(root: string, ref: string, selectors: string[]): ReviewSource[] {
  const paths = sourcePaths(root, ref, selectors);
  if (paths.length === 0) throw new Error('没有找到评审来源');
  if (paths.length > 100) throw new Error('评审来源文件超过 100 个');
  let total = 0;
  return paths.map((path) => {
    const content = readTextAtRef(root, ref, path, 128 * 1024);
    total += Buffer.byteLength(content);
    if (total > 500 * 1024) throw new Error('评审来源超过总读取上限');
    return { path, content };
  });
}

function errorReceipt(opts: {
  workspace: string;
  now: Date;
  axis: ReviewAxis;
  repository: string | null;
  baseSha: string | null;
  headSha: string | null;
  contractSha256: string | null;
  model?: string;
  code: string;
  message: string;
  durationMs?: number;
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
    ...(opts.model ? { model: opts.model } : {}),
    findings: [],
    exceptions: [],
    errors: [{ code: opts.code, message: opts.message }],
    durationMs: opts.durationMs ?? 0,
  };
}

function overallStatus(receipts: QualityReceipt[]): QualityStatus {
  if (receipts.some((receipt) => receipt.status === 'unverifiable')) return 'unverifiable';
  if (receipts.some((receipt) => receipt.status === 'failed')) return 'failed';
  return 'passed';
}

function renderLocalSummary(receipts: QualityReceipt[]): string {
  return [
    '# coding-x 本地质量评审',
    '',
    '> 这是本地反馈，不是共享交付凭证。GitHub PR 对最新提交独立重跑后才形成门禁结论。',
    '',
    ...receipts.flatMap((receipt) => [
      `## ${receipt.axis}: ${receipt.status}`,
      '',
      `- head: \`${receipt.headSha ?? 'unavailable'}\``,
      `- findings: ${receipt.findings.length}`,
      `- exceptions: ${receipt.exceptions.join('、') || '无'}`,
      ...receipt.errors.map((error) => `- ${error.code}: ${error.message}`),
      ...receipt.findings.map((finding) =>
        `- [${finding.severity}] ${finding.file}${finding.line ? `:${finding.line}` : ''} ${finding.title}`),
      '',
    ]),
    '## 交付凭证',
    '',
    '无。本文件位于 agent 可写 workspace，仅帮助提交前发现问题。',
    '',
  ].join('\n');
}

export async function runLocalQualityReview(opts: {
  root: string;
  workspace: string;
  baseRef: string;
  intentPath: string;
  kind: AgentKind;
  model?: string;
  agentCall?: AgentCall;
  now?: Date;
}): Promise<{ status: QualityStatus; receipts: QualityReceipt[]; summaryPath: string }> {
  const now = opts.now ?? new Date();
  const summaryPath = join(opts.workspace, 'quality', 'review-latest.md');
  const dirty = gitText(opts.root, ['status', '--porcelain']);
  if (dirty !== '') {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      axis: 'spec',
      repository: null,
      baseSha: null,
      headSha: null,
      contractSha256: null,
      code: 'worktree-dirty',
      message: '本地评审要求已提交且干净的工作树，避免结果绑定不完整内容',
    });
    appendQualityReceipt(opts.workspace, receipt);
    writeFileAtomicSync(summaryPath, renderLocalSummary([receipt]));
    return { status: 'unverifiable', receipts: [receipt], summaryPath };
  }
  const contractRead = readQualityContract(opts.root);
  if (contractRead.status !== 'valid') {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      axis: 'spec',
      repository: null,
      baseSha: null,
      headSha: null,
      contractSha256: null,
      code: 'contract-invalid',
      message: contractRead.status === 'missing' ? '缺少质量契约' : contractRead.errors.join('；'),
    });
    appendQualityReceipt(opts.workspace, receipt);
    writeFileAtomicSync(summaryPath, renderLocalSummary([receipt]));
    return { status: 'unverifiable', receipts: [receipt], summaryPath };
  }
  if (!existsSync(opts.intentPath) || !statSync(opts.intentPath).isFile()) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      axis: 'spec',
      repository: contractRead.contract.github.repository,
      baseSha: null,
      headSha: null,
      contractSha256: contractRead.sha256,
      model: opts.model,
      code: 'intent-file-missing',
      message: `意图文件不存在：${opts.intentPath}`,
    });
    appendQualityReceipt(opts.workspace, receipt);
    writeFileAtomicSync(summaryPath, renderLocalSummary([receipt]));
    return { status: 'unverifiable', receipts: [receipt], summaryPath };
  }
  const intentRead = parseReviewIntent(readFileSync(opts.intentPath, 'utf8'));
  const diff = collectGitDiff(opts.root, opts.baseRef);
  const risk = assessDeepReviewRisk(diff, contractRead.contract.review.deepReview, (path) => {
    try {
      const content = readTextAtRef(opts.root, diff.headSha, path, 2 * 1024 * 1024);
      return content.split(/\r?\n/).length;
    } catch {
      return null;
    }
  });
  const exceptionsRead = readQualityExceptions(opts.root, contractRead.contract.exceptionsFile);
  const receipts: QualityReceipt[] = [];
  const agentCall = opts.agentCall ?? runReadOnlyReviewAgent;
  const runAxis = async (axis: ReviewAxis): Promise<QualityReceipt> => {
    if (axis === 'spec' && intentRead.status === 'invalid') {
      return errorReceipt({
        workspace: opts.workspace,
        now,
        axis,
        repository: contractRead.contract.github.repository,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        contractSha256: contractRead.sha256,
        model: opts.model,
        code: 'intent-missing',
        message: `意图文件缺少：${intentRead.missing.join('、')}`,
      });
    }
    if (axis === 'deep' && !risk.required) {
      return {
        version: 1,
        kind: 'review',
        round: nextReceiptRound(opts.workspace, 'review', axis),
        status: 'passed',
        at: now.toISOString(),
        repository: contractRead.contract.github.repository,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        contractSha256: contractRead.sha256,
        axis,
        ...(opts.model ? { model: opts.model } : {}),
        deepRequired: false,
        deepReasons: [],
        findings: [],
        exceptions: [],
        errors: [],
        durationMs: 0,
      };
    }
    if (exceptionsRead.status !== 'valid') {
      return errorReceipt({
        workspace: opts.workspace,
        now,
        axis,
        repository: contractRead.contract.github.repository,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        contractSha256: contractRead.sha256,
        model: opts.model,
        code: 'exceptions-invalid',
        message: exceptionsRead.status === 'missing'
          ? `缺少异常记录文件：${exceptionsRead.path}`
          : exceptionsRead.errors.join('；'),
      });
    }
    const selectors = axis === 'spec'
      ? contractRead.contract.review.specSources
      : axis === 'standards'
        ? contractRead.contract.review.standardsSources
        : [...new Set([
            ...contractRead.contract.review.specSources,
            ...contractRead.contract.review.standardsSources,
          ])];
    let sources: ReviewSource[];
    try {
      sources = sourcesAtRef(
        opts.root,
        axis === 'spec' ? diff.headSha : diff.baseSha,
        selectors,
      );
    } catch (error) {
      return errorReceipt({
        workspace: opts.workspace,
        now,
        axis,
        repository: contractRead.contract.github.repository,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        contractSha256: contractRead.sha256,
        model: opts.model,
        code: 'review-source-invalid',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const intent = intentRead.status === 'valid' ? intentRead.intent : {
      intent: 'Spec 信息缺失',
      acceptanceCriteria: 'Spec 信息缺失',
      nonGoals: 'Spec 信息缺失',
      verification: 'Spec 信息缺失',
    };
    const prompts = buildReviewPrompts(axis, {
      repository: contractRead.contract.github.repository,
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      contractSha256: contractRead.sha256,
      intent,
      changedFiles: diff.changedFiles,
      diff: diff.diff,
      sources,
      deepReasons: risk.reasons,
    });
    if (prompts.status === 'invalid') {
      return errorReceipt({
        workspace: opts.workspace,
        now,
        axis,
        repository: contractRead.contract.github.repository,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        contractSha256: contractRead.sha256,
        model: opts.model,
        code: 'review-input-invalid',
        message: prompts.error,
      });
    }
    let model: Awaited<ReturnType<AgentCall>>;
    try {
      model = await agentCall({
        kind: opts.kind,
        axis,
        prompt: `${prompts.system}\n\n${prompts.user}`,
        cwd: opts.root,
        ...(opts.model ? { model: opts.model } : {}),
      });
    } catch (error) {
      model = {
        status: 'invalid',
        output: null,
        error: `只读 reviewer 调用异常：${error instanceof Error ? error.message : String(error)}`,
        durationMs: 0,
      };
    }
    if (model.status === 'invalid') {
      return errorReceipt({
        workspace: opts.workspace,
        now,
        axis,
        repository: contractRead.contract.github.repository,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        contractSha256: contractRead.sha256,
        model: opts.model,
        code: 'model-output-invalid',
        message: model.error,
        durationMs: model.durationMs,
      });
    }
    const changedFileSet = new Set([
      ...diff.changedFiles,
      ...sources.map((source) => source.path),
    ]);
    const outOfScopeFinding = model.output.findings.find((finding) =>
      !changedFileSet.has(finding.file));
    if (outOfScopeFinding) {
      return errorReceipt({
        workspace: opts.workspace,
        now,
        axis,
        repository: contractRead.contract.github.repository,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        contractSha256: contractRead.sha256,
        model: opts.model,
        code: 'model-output-invalid',
        message: `finding 指向既非变更文件也非评审来源的路径：${outOfScopeFinding.file}`,
      });
    }
    const evaluated = evaluateReviewModelResult(
      model.output,
      exceptionsRead.value.exceptions,
      diff.headSha,
      now,
      contractRead.contract.exceptionPolicy.deferrableSeverities,
    );
    const round = nextReceiptRound(opts.workspace, 'review', axis);
    return {
      version: 1,
      kind: 'review',
      round,
      status: evaluated.status,
      at: now.toISOString(),
      repository: contractRead.contract.github.repository,
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      contractSha256: contractRead.sha256,
      axis,
      ...(opts.model ? { model: opts.model } : {}),
      ...(axis === 'deep' ? { deepRequired: true, deepReasons: risk.reasons } : {}),
      reviewSummary: evaluated.summary,
      findings: evaluated.findings.map((finding) => ({
        ...finding,
        headSha: diff.headSha,
        round,
      })),
      exceptions: evaluated.exceptionIds,
      errors: [],
      durationMs: model.durationMs,
    };
  };
  const [spec, standards] = await Promise.all([runAxis('spec'), runAxis('standards')]);
  for (const receipt of [spec, standards]) {
    receipts.push(receipt);
    appendQualityReceipt(opts.workspace, receipt);
  }
  const interrupted = [spec, standards].find((receipt) =>
    receipt.errors.some((error) => error.message.includes('reviewer 被 SIG')));
  const deep = interrupted
    ? errorReceipt({
        workspace: opts.workspace,
        now,
        axis: 'deep',
        repository: contractRead.contract.github.repository,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        contractSha256: contractRead.sha256,
        model: opts.model,
        code: 'review-interrupted',
        message: `前序评审被中断，未启动深度评审：${interrupted.errors[0]?.message ?? 'unknown'}`,
      })
    : await runAxis('deep');
  receipts.push(deep);
  appendQualityReceipt(opts.workspace, deep);
  writeFileAtomicSync(summaryPath, renderLocalSummary(receipts));
  return { status: overallStatus(receipts), receipts, summaryPath };
}

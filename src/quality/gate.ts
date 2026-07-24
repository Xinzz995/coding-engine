import { createHash } from 'node:crypto';
import type { ProjectChecksResult } from './checks.js';
import { runProjectChecks } from './checks.js';
import {
  readQualityContract,
  readQualityContractAtRef,
  readQualityContractFile,
  type ContractReadResult,
} from './contract.js';
import {
  GitHubClient,
  parseGitHubPullRequestEvent,
} from './github.js';
import { gitHead, gitText } from './git.js';
import {
  appendQualityReceipt,
  nextReceiptRound,
} from './receipt.js';
import type {
  QualityError,
  QualityReceipt,
  QualityStatus,
} from './types.js';

const SHA_RE = /^[0-9a-f]{40}$/i;

function errorReceipt(opts: {
  workspace: string;
  now: Date;
  repository: string | null;
  baseSha: string | null;
  headSha: string | null;
  contractSha256: string | null;
  code: string;
  message: string;
  started: number;
}): QualityReceipt {
  return {
    version: 1,
    kind: 'checks',
    round: nextReceiptRound(opts.workspace, 'checks'),
    status: 'unverifiable',
    at: opts.now.toISOString(),
    repository: opts.repository,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    contractSha256: opts.contractSha256,
    findings: [],
    exceptions: [],
    errors: [{ code: opts.code, message: opts.message }],
    durationMs: Date.now() - opts.started,
  };
}

function readTrustedContract(opts: {
  root: string;
  contractFile?: string;
  contractRef?: string;
}): ContractReadResult {
  if (opts.contractFile && opts.contractRef) {
    return {
      status: 'invalid',
      path: opts.contractFile,
      errors: ['--contract-file 与 --contract-ref 不能同时使用'],
    };
  }
  if (opts.contractFile) return readQualityContractFile(opts.root, opts.contractFile);
  if (opts.contractRef) return readQualityContractAtRef(opts.root, opts.contractRef);
  return readQualityContract(opts.root);
}

function checkErrors(result: ProjectChecksResult): QualityError[] {
  return result.results
    .filter((item) => item.status !== 'passed')
    .map((item) => ({
      code: item.errorCode ?? 'project-check-failed',
      message: `${item.id}: ${item.diagnosticTail || `退出码 ${item.exitCode ?? 'unavailable'}`}`,
    }));
}

export async function runProjectQualityGate(opts: {
  root: string;
  workspace: string;
  baseSha: string;
  headSha: string;
  contractFile?: string;
  contractRef?: string;
  timeoutMs?: number;
  now?: Date;
}): Promise<{ receipt: QualityReceipt; checks: ProjectChecksResult | null }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  if (!SHA_RE.test(opts.baseSha) || !SHA_RE.test(opts.headSha)) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: null,
      baseSha: SHA_RE.test(opts.baseSha) ? opts.baseSha : null,
      headSha: SHA_RE.test(opts.headSha) ? opts.headSha : null,
      contractSha256: null,
      code: 'commit-identity-invalid',
      message: 'base/head 必须是完整的 40 位 Git 提交',
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, checks: null };
  }
  let actualHead: string;
  try {
    actualHead = gitHead(opts.root);
  } catch (error) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: null,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      contractSha256: null,
      code: 'git-head-unavailable',
      message: error instanceof Error ? error.message : String(error),
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, checks: null };
  }
  if (actualHead !== opts.headSha) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: null,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      contractSha256: null,
      code: 'stale-head',
      message: `工作树提交 ${actualHead} 与要求的 PR head ${opts.headSha} 不一致`,
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, checks: null };
  }
  const contractRead = readTrustedContract(opts);
  if (contractRead.status !== 'valid') {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: null,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      contractSha256: null,
      code: 'contract-invalid',
      message: contractRead.status === 'missing' ? '缺少质量契约' : contractRead.errors.join('；'),
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, checks: null };
  }
  let changedFiles: string[];
  try {
    const changed = gitText(opts.root, [
      'diff',
      '--name-only',
      `${opts.baseSha}...${opts.headSha}`,
      '--',
    ]);
    changedFiles = changed === '' ? [] : changed.split('\n');
  } catch (error) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: contractRead.contract.github.repository,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      contractSha256: contractRead.sha256,
      code: 'diff-unavailable',
      message: error instanceof Error ? error.message : String(error),
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, checks: null };
  }
  const checks = await runProjectChecks(
    contractRead.contract.checks,
    opts.root,
    opts.timeoutMs,
    changedFiles,
  );
  const receipt: QualityReceipt = {
    version: 1,
    kind: 'checks',
    round: nextReceiptRound(opts.workspace, 'checks'),
    status: checks.status,
    at: now.toISOString(),
    repository: contractRead.contract.github.repository,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    contractSha256: contractRead.sha256,
    findings: [],
    exceptions: [],
    errors: checkErrors(checks),
    durationMs: Date.now() - started,
  };
  appendQualityReceipt(opts.workspace, receipt);
  return { receipt, checks };
}

function projectJobStatus(result: string): QualityStatus {
  if (result === 'success') return 'passed';
  if (result === 'failure') return 'failed';
  return 'unverifiable';
}

export async function publishProjectCheck(opts: {
  root: string;
  workspace: string;
  eventPath: string;
  jobResult: string;
  token: string;
  client?: GitHubClient;
  now?: Date;
}): Promise<{ receipt: QualityReceipt; check: { id: number; url: string | null } | null }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  let event;
  try {
    event = parseGitHubPullRequestEvent(opts.eventPath);
  } catch (error) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: null,
      baseSha: null,
      headSha: null,
      contractSha256: null,
      code: 'github-event-invalid',
      message: error instanceof Error ? error.message : String(error),
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: null };
  }
  const client = opts.client ?? new GitHubClient(opts.token, event.repository);
  const contractRead = readQualityContract(opts.root);
  if (contractRead.status !== 'valid') {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: null,
      code: 'contract-invalid',
      message: contractRead.status === 'missing' ? '默认分支缺少质量契约' : contractRead.errors.join('；'),
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: null };
  }
  let current;
  try {
    current = await client.getPullIdentity(event.number);
  } catch (error) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      code: 'github-pr-read-failed',
      message: error instanceof Error ? error.message : String(error),
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: null };
  }
  const trustedHead = current.headSha === event.headSha
    && current.baseSha === event.baseSha
    && current.baseRef === event.baseRef
    && contractRead.contract.github.repository === event.repository
    && contractRead.contract.github.defaultBranch === event.baseRef;
  if (!trustedHead) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      code: 'stale-head',
      message: 'PR 或默认分支身份已经变化，拒绝发布旧项目检查结果',
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: null };
  }
  let localBase: string | null = null;
  try {
    localBase = gitHead(opts.root);
  } catch {
    // The mismatch is handled below.
  }
  if (localBase !== event.baseSha) {
    const receipt = errorReceipt({
      workspace: opts.workspace,
      now,
      repository: event.repository,
      baseSha: event.baseSha,
      headSha: event.headSha,
      contractSha256: contractRead.sha256,
      code: 'trusted-base-mismatch',
      message: '发布者没有运行在事件指定的默认分支 base SHA',
      started,
    });
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, check: null };
  }
  const status = projectJobStatus(opts.jobResult);
  const receipt: QualityReceipt = {
    version: 1,
    kind: 'checks',
    round: nextReceiptRound(opts.workspace, 'checks'),
    status,
    at: now.toISOString(),
    repository: event.repository,
    baseSha: event.baseSha,
    headSha: event.headSha,
    contractSha256: contractRead.sha256,
    findings: [],
    exceptions: [],
    errors: status === 'passed' ? [] : [{
      code: status === 'failed' ? 'project-checks-failed' : 'project-checks-unavailable',
      message: `隔离项目检查 job 结果：${opts.jobResult}`,
    }],
    durationMs: Date.now() - started,
  };
  appendQualityReceipt(opts.workspace, receipt);
  const check = await client.createCheckRun({
    name: 'coding-x / project-checks',
    headSha: event.headSha,
    status,
    title: status === 'passed' ? '项目检查通过' : '项目检查未通过',
    summary: status === 'passed'
      ? '可信默认分支工作流在无敏感权限环境中执行了项目命令。'
      : `项目检查状态：${status}`,
    text: receipt.errors.map((error) => `${error.code}: ${error.message}`).join('\n') || '全部通过',
  });
  return { receipt, check };
}

export function contractDigest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

import { join } from 'node:path';
import {
  asStrictRecord,
  parseStrictJson,
  requireDigest,
  requireExactKeys,
} from '../workspace-safety/baseline-contract.js';
import { readStableFile } from '../workspace-safety/stable-file.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { parseIssueExecutionContract } from './issue-execution-contract.js';
import type { Prd } from './prd.js';

export const ISSUE_WORKSPACE_IDENTITY_FILE = 'issue-run-identity.json' as const;
export const ISSUE_WORKSPACE_IDENTITY_SCHEMA_VERSION = 1 as const;
const MAX_IDENTITY_BYTES = 64 * 1024;
const RUN_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface IssueWorkspaceIdentity {
  readonly schemaVersion: typeof ISSUE_WORKSPACE_IDENTITY_SCHEMA_VERSION;
  readonly repository: string;
  readonly issueNumber: number;
  readonly bodyDigest: string;
  readonly branch: string;
  readonly pullRequest: number;
  readonly runId: string;
  readonly sourcePrd: string;
  readonly executionContractDigest: string;
}

export type IssueWorkspaceIdentityRead =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly error: string }
  | { readonly status: 'ready'; readonly identity: IssueWorkspaceIdentity };

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new Error(`${label} 非法`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value as number;
}

export function parseIssueWorkspaceIdentity(value: unknown): IssueWorkspaceIdentity {
  const record = asStrictRecord(value, 'Issue workspace identity');
  requireExactKeys(
    record,
    [
      'schemaVersion',
      'repository',
      'issueNumber',
      'bodyDigest',
      'branch',
      'pullRequest',
      'runId',
      'sourcePrd',
      'executionContractDigest',
    ],
    'Issue workspace identity',
  );
  if (record.schemaVersion !== ISSUE_WORKSPACE_IDENTITY_SCHEMA_VERSION) {
    throw new Error('Issue workspace identity 版本不受支持');
  }
  const repository = boundedText(record.repository, 'Issue workspace repository');
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error('Issue workspace repository 必须是 owner/name');
  }
  const issueNumber = positiveInteger(record.issueNumber, 'Issue workspace issueNumber');
  const bodyDigest = requireDigest(record.bodyDigest, 'Issue workspace bodyDigest');
  const branch = boundedText(record.branch, 'Issue workspace branch');
  if (branch !== `codex/issue-${issueNumber}`) {
    throw new Error('Issue workspace branch 与 Issue 编号不一致');
  }
  const pullRequest = positiveInteger(record.pullRequest, 'Issue workspace pullRequest');
  const runId = boundedText(record.runId, 'Issue workspace runId');
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('Issue workspace runId 非法');
  const sourcePrd = boundedText(record.sourcePrd, 'Issue workspace sourcePrd');
  const executionContractDigest = requireDigest(
    record.executionContractDigest,
    'Issue workspace executionContractDigest',
  );
  return {
    schemaVersion: ISSUE_WORKSPACE_IDENTITY_SCHEMA_VERSION,
    repository,
    issueNumber,
    bodyDigest,
    branch,
    pullRequest,
    runId,
    sourcePrd,
    executionContractDigest,
  };
}

export function renderIssueWorkspaceIdentity(identity: IssueWorkspaceIdentity): string {
  const parsed = parseIssueWorkspaceIdentity(identity);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function readIssueWorkspaceIdentity(workspace: string): IssueWorkspaceIdentityRead {
  const file = readStableFile(join(workspace, ISSUE_WORKSPACE_IDENTITY_FILE), {
    label: 'Issue workspace identity',
    maxBytes: MAX_IDENTITY_BYTES,
  });
  if (file.status === 'missing') return { status: 'missing' };
  if (file.status === 'invalid') return { status: 'invalid', error: file.diagnostic };
  try {
    return {
      status: 'ready',
      identity: parseIssueWorkspaceIdentity(
        parseStrictJson(file.bytes, 'Issue workspace identity'),
      ),
    };
  } catch (error) {
    return {
      status: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function sameIssueWorkspaceIdentity(
  left: IssueWorkspaceIdentity,
  right: IssueWorkspaceIdentity,
): boolean {
  return renderIssueWorkspaceIdentity(left) === renderIssueWorkspaceIdentity(right);
}

export function issueWorkspaceIdentityMatchesPrd(
  identity: IssueWorkspaceIdentity,
  prd: Pick<
    Prd,
    | 'project'
    | 'branchName'
    | 'description'
    | 'sourcePrd'
    | 'executionContract'
    | 'executionContractDigest'
  >,
): boolean {
  const runIds = [...prd.description.matchAll(/^Issue-Run-ID:\s*(sha256:[0-9a-f]{64})\s*$/gmu)];
  const execution = parseIssueExecutionContract(prd.executionContract);
  return (
    execution.ok &&
    execution.digest === identity.executionContractDigest &&
    prd.project === identity.repository &&
    prd.branchName === identity.branch &&
    prd.sourcePrd === identity.sourcePrd &&
    prd.executionContractDigest === identity.executionContractDigest &&
    runIds.length === 1 &&
    runIds[0][1] === identity.runId
  );
}

export async function ensureIssueWorkspaceIdentity(
  session: WorkspaceSession,
  expected: IssueWorkspaceIdentity,
): Promise<void> {
  const parsedExpected = parseIssueWorkspaceIdentity(expected);
  const before = readIssueWorkspaceIdentity(session.writer.workspacePath);
  if (before.status === 'invalid') {
    throw new Error(`Issue workspace identity 不可用：${before.error}`);
  }
  if (before.status === 'ready') {
    if (!sameIssueWorkspaceIdentity(before.identity, parsedExpected)) {
      throw new Error('Issue workspace 已永久绑定其他 Issue 运行');
    }
    return;
  }
  await session.writer.writeFile(
    ISSUE_WORKSPACE_IDENTITY_FILE,
    renderIssueWorkspaceIdentity(parsedExpected),
  );
  const after = readIssueWorkspaceIdentity(session.writer.workspacePath);
  if (after.status !== 'ready' || !sameIssueWorkspaceIdentity(after.identity, parsedExpected)) {
    throw new Error('Issue workspace identity 写入后无法精确回读');
  }
}

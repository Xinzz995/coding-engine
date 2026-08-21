import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  applyPrdV1CandidateDigest,
  runApplyPrdV1Mutation,
  type ApplyPrdV1Candidate,
  type ApplyPrdV1Request,
} from '../workspace-safety/product-mutations.js';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession } from '../workspace-safety/session.js';
import { digestBytes } from '../workspace-safety/filesystem.js';
import { readStableFile } from '../workspace-safety/stable-file.js';
import {
  deriveQualityChecks,
  readQualityContract,
  type QualityContract,
  type QualityContractReadResult,
  type QualityPlatform,
} from '../quality/contract.js';
import { GhGitHubQualityClient } from '../quality/github-unmanaged.js';
import type { Prd } from '../engine/prd.js';
import type { AgentKind } from '../engine/agent.js';
import { tryReadPrd } from '../engine/prd.js';
import {
  parseIssueExecutionContract,
  qualityPlatformForNode,
  reconcileIssueExecutionContract,
  reconcileIssueRemoteAuthority,
  type IssueExecutionContract,
} from '../engine/issue-execution-contract.js';

export const READY_FOR_AGENT_LABEL = 'ready-for-agent' as const;
export const ISSUE_RUN_COMMENT_MARKER = '<!-- coding-x-issue-run-v1 -->' as const;
export const ISSUE_RUN_BOOTSTRAP_COMMENT_MARKER =
  '<!-- coding-x-issue-run-bootstrap-v1 -->' as const;
export const ISSUE_RUN_SCHEMA_VERSION = 1 as const;
const ISSUE_RUN_ID_DOMAIN = 'coding-x-issue-run-v2' as const;
const MAX_ISSUE_SOURCE_BYTES = 2 * 1024 * 1024;

export interface IssueRunCommandInvocation {
  readonly command: 'git' | 'gh';
  readonly args: readonly string[];
  readonly cwd: string;
}

export type IssueRunCommandExecutor = (invocation: IssueRunCommandInvocation) => string;

export interface ReadyIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly goal: string;
  readonly nonGoals: string;
  readonly acceptanceCriteria: string[];
  readonly executionContract: IssueExecutionContract;
  readonly executionContractDigest: string;
  readonly risk: string;
  readonly readyAt: string;
  readonly bodyDigest: string;
}

export interface IssueEngineEvidence {
  readonly reviewBindingDigest?: string;
  readonly storyValidationDigest?: string;
  readonly candidateProofDigest?: string;
  readonly reusedFinalReview?: boolean;
  readonly remoteRefreshDurationMs?: number;
}

export interface IssueEngineResult {
  readonly exitCode: number;
  readonly message: string;
  readonly evidence?: IssueEngineEvidence;
}

export interface IssueRunState {
  readonly schemaVersion: typeof ISSUE_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly readyAt: string;
  readonly branch: string;
  readonly pullRequest: number;
  readonly pullRequestUrl: string;
  readonly phase: 'prepared' | 'running' | 'waiting-remote' | 'failed' | 'trusted';
  readonly activeMs: number;
  readonly continuations: number;
  readonly currentHead: string;
  readonly lastExitCode: number | null;
  readonly message: string;
  readonly updatedAt: string;
  readonly evidence: IssueEngineEvidence;
  readonly trustedAt?: string;
  readonly readyToTrustedMs?: number;
  readonly waitingMs?: number;
}

export interface IssueRunResult {
  readonly exitCode: number;
  readonly phase: IssueRunState['phase'];
  readonly branch: string;
  readonly pullRequest: number;
  readonly pullRequestUrl: string;
  readonly workspace: string;
  readonly state: IssueRunState;
}

interface RepositoryObservation {
  readonly nameWithOwner: string;
  readonly defaultBranch: string;
}

interface PullRequestObservation {
  readonly number: number;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
}

interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly htmlUrl: string;
  readonly login: string;
  readonly association: string;
}

interface IssueRunComment {
  readonly id: number;
  readonly htmlUrl: string;
  readonly state: IssueRunState;
}

interface IssueRunBootstrapState {
  readonly schemaVersion: typeof ISSUE_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly readyAt: string;
  readonly branch: string;
  readonly phase: 'prepared' | 'failed';
  readonly activeMs: number;
  readonly continuations: number;
  readonly currentHead: string;
  readonly message: string;
  readonly updatedAt: string;
}

interface IssueRunBootstrapComment {
  readonly id: number;
  readonly htmlUrl: string;
  readonly state: IssueRunBootstrapState;
}

function defaultExecutor(invocation: IssueRunCommandInvocation): string {
  return execFileSync(invocation.command, [...invocation.args], {
    cwd: invocation.cwd,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function json(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} 非法`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} 非法`);
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} 不是合法时间`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${label} 不是 SHA-256 摘要`);
  return result;
}

function gitSha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{40}$/u.test(result)) throw new Error(`${label} 不是完整 Git commit`);
  return result;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function flattenUnknownPages(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 不是数组`);
  const flattened: unknown[] = [];
  for (const entry of value as unknown[]) {
    if (Array.isArray(entry)) flattened.push(...(entry as unknown[]));
    else flattened.push(entry);
  }
  return flattened;
}

function visibleSection(value: string): string {
  let cursor = 0;
  let visible = '';
  while (cursor < value.length) {
    const start = value.indexOf('<!--', cursor);
    if (start === -1) {
      visible += value.slice(cursor);
      break;
    }
    visible += value.slice(cursor, start);
    const end = value.indexOf('-->', start + 4);
    if (end === -1 || value.slice(start + 4, end).includes('<!--')) {
      throw new Error('ready Issue 包含畸形 HTML 注释');
    }
    cursor = end + 3;
  }
  if (visible.includes('<!--') || visible.includes('-->')) {
    throw new Error('ready Issue 包含畸形 HTML 注释');
  }
  return visible.trim();
}

function issueSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...body.matchAll(/^#{2,3}\s+(.+?)\s*$/gmu)];
  for (const [index, match] of matches.entries()) {
    const title = match[1].trim();
    if (sections.has(title)) throw new Error(`ready Issue 包含重复章节：${title}`);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    sections.set(title, visibleSection(body.slice(start, end)));
  }
  return sections;
}

function executionContract(value: string): {
  contract: IssueExecutionContract;
  digest: string;
} {
  if (value === '') {
    throw new Error(
      'ready Issue 缺少版本化执行合同；未启动的旧 Issue 可按当前模板补齐并重新添加 ready-for-agent 标签；已有运行评论、分支或 PR 的旧 Issue 必须保留原现场并新建 Issue，不能冒充同一运行迁移',
    );
  }
  const match = /^```json\s*\r?\n([\s\S]+?)\r?\n```$/u.exec(value);
  if (!match) throw new Error('ready Issue 执行合同必须是唯一一个 JSON fenced block');
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]) as unknown;
  } catch (error) {
    throw new Error(
      `ready Issue 执行合同不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseIssueExecutionContract(raw);
  if (!parsed.ok) throw new Error(`ready Issue 执行合同无效：${parsed.errors.join('；')}`);
  return { contract: parsed.contract, digest: parsed.digest };
}

function currentReadyAt(events: unknown): string | null {
  let readyAt: string | null = null;
  const sorted = flattenUnknownPages(events, 'GitHub Issue events')
    .map((entry) => record(entry, 'GitHub Issue event'))
    .map((event) => ({
      event,
      createdAt: timestamp(event.created_at, 'GitHub Issue event 时间'),
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const { event, createdAt } of sorted) {
    const label =
      typeof event.label === 'object' && event.label !== null && !Array.isArray(event.label)
        ? (event.label as Record<string, unknown>).name
        : undefined;
    if (label !== READY_FOR_AGENT_LABEL) continue;
    if (event.event === 'labeled') readyAt = createdAt;
    if (event.event === 'unlabeled') readyAt = null;
  }
  return readyAt;
}

export function parseReadyIssue(issueValue: unknown, eventValue: unknown): ReadyIssue {
  const issue = record(issueValue, 'GitHub Issue');
  if (issue.state !== 'open' || issue.pull_request !== undefined) {
    throw new Error('只接受开放的普通 Issue');
  }
  if (!Array.isArray(issue.labels)) throw new Error('GitHub Issue labels 非法');
  const labels = issue.labels.map((entry) =>
    text(record(entry, 'Issue label').name, 'Issue label'),
  );
  if (!labels.includes(READY_FOR_AGENT_LABEL)) {
    throw new Error(`Issue 缺少 ${READY_FOR_AGENT_LABEL} 标签`);
  }
  const readyAt = currentReadyAt(eventValue);
  if (readyAt === null) throw new Error(`无法确认当前 ${READY_FOR_AGENT_LABEL} 标签事件`);
  const body = typeof issue.body === 'string' ? issue.body : '';
  const sections = issueSections(body);
  const goal = sections.get('本次目标') ?? '';
  const nonGoals = sections.get('明确的非目标') ?? '';
  const risk = sections.get('风险说明') ?? '';
  const parsedExecution = executionContract(sections.get('执行合同') ?? '');
  const acceptanceCriteria = [...parsedExecution.contract.storyAcceptance.criteria];
  const missing = [
    ...(goal ? [] : ['本次目标']),
    ...(nonGoals ? [] : ['明确的非目标']),
    ...(risk ? [] : ['风险说明']),
  ];
  if (missing.length > 0) throw new Error(`ready Issue 缺少可执行内容：${missing.join('、')}`);
  return {
    number: positiveInteger(issue.number, 'Issue number'),
    title: text(issue.title, 'Issue title'),
    url: text(issue.html_url, 'Issue URL'),
    body,
    goal,
    nonGoals,
    acceptanceCriteria,
    executionContract: parsedExecution.contract,
    executionContractDigest: parsedExecution.digest,
    risk,
    readyAt,
    bodyDigest: digest({ domain: 'coding-x-ready-issue-body-v1', body }),
  };
}

export function issueRunId(repository: string, issue: ReadyIssue): string {
  return digest({
    domain: ISSUE_RUN_ID_DOMAIN,
    repository,
    issueNumber: issue.number,
    readyAt: issue.readyAt,
    bodyDigest: issue.bodyDigest,
    executionContractDigest: issue.executionContractDigest,
  });
}

function parseRepository(value: unknown): RepositoryObservation {
  const root = record(value, 'GitHub 仓库');
  const defaultRef = record(root.defaultBranchRef, 'GitHub 默认分支');
  return {
    nameWithOwner: text(root.nameWithOwner, 'GitHub 仓库名'),
    defaultBranch: text(defaultRef.name, 'GitHub 默认分支名'),
  };
}

function parsePullRequests(value: unknown): PullRequestObservation[] {
  if (!Array.isArray(value)) throw new Error('GitHub PR 列表不是数组');
  return value.map((entry, index) => {
    const root = record(entry, `GitHub PR[${index}]`);
    if (root.state !== 'OPEN' && root.state !== 'CLOSED' && root.state !== 'MERGED') {
      throw new Error(`GitHub PR[${index}] state 非法`);
    }
    if (typeof root.isDraft !== 'boolean') throw new Error(`GitHub PR[${index}] draft 非法`);
    return {
      number: positiveInteger(root.number, `GitHub PR[${index}] number`),
      state: root.state,
      isDraft: root.isDraft,
      headRefOid: text(root.headRefOid, `GitHub PR[${index}] head`),
      baseRefName: text(root.baseRefName, `GitHub PR[${index}] base`),
      url: text(root.url, `GitHub PR[${index}] URL`),
      title: text(root.title, `GitHub PR[${index}] title`),
      body: typeof root.body === 'string' ? root.body : '',
    };
  });
}

function normalizedIdentityText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
}

function assertPullRequestIntent(
  pullRequest: PullRequestObservation,
  issue: ReadyIssue,
  sourcePath: string,
): void {
  if (pullRequest.title !== issue.title) throw new Error('Issue PR 标题已偏离冻结 Issue 标题');
  const sections = issueSections(pullRequest.body);
  const expected = new Map<string, string>([
    ['本次目标', issue.goal],
    ['明确的非目标', issue.nonGoals],
    ['Spec 与验收标准来源', `${sourcePath}\n\nCloses #${issue.number}`],
    ['风险说明', issue.risk],
  ]);
  for (const [name, value] of expected) {
    if (normalizedIdentityText(sections.get(name) ?? '') !== normalizedIdentityText(value)) {
      throw new Error(`Issue PR 的“${name}”已偏离冻结 Issue 意图`);
    }
  }
}

function parseComments(value: unknown): IssueComment[] {
  return flattenUnknownPages(value, 'GitHub Issue comments').map((entry, index) => {
    const root = record(entry, `GitHub Issue comment[${index}]`);
    const user = record(root.user, `GitHub Issue comment[${index}].user`);
    return {
      id: positiveInteger(root.id, `GitHub Issue comment[${index}].id`),
      body: typeof root.body === 'string' ? root.body : '',
      htmlUrl: text(root.html_url, `GitHub Issue comment[${index}] URL`),
      login: text(user.login, `GitHub Issue comment[${index}] user`),
      association: text(root.author_association, `GitHub Issue comment[${index}] association`),
    };
  });
}

function parseIssueRunState(value: unknown): IssueRunState {
  const root = record(value, 'Issue run state');
  if (root.schemaVersion !== ISSUE_RUN_SCHEMA_VERSION) throw new Error('Issue run schema 非法');
  if (
    !['prepared', 'running', 'waiting-remote', 'failed', 'trusted'].includes(String(root.phase))
  ) {
    throw new Error('Issue run phase 非法');
  }
  const evidenceValue = record(root.evidence, 'Issue run evidence');
  const evidenceDigest = (key: keyof IssueEngineEvidence): string | undefined => {
    const value = evidenceValue[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
      throw new Error(`Issue run evidence.${key} 非法`);
    }
    return value;
  };
  const reviewBindingDigest = evidenceDigest('reviewBindingDigest');
  const storyValidationDigest = evidenceDigest('storyValidationDigest');
  const candidateProofDigest = evidenceDigest('candidateProofDigest');
  const reusedFinalReview = evidenceValue.reusedFinalReview;
  if (reusedFinalReview !== undefined && typeof reusedFinalReview !== 'boolean') {
    throw new Error('Issue run evidence.reusedFinalReview 非法');
  }
  const remoteRefreshDurationMs = evidenceValue.remoteRefreshDurationMs;
  if (
    remoteRefreshDurationMs !== undefined &&
    (!Number.isSafeInteger(remoteRefreshDurationMs) || (remoteRefreshDurationMs as number) < 0)
  ) {
    throw new Error('Issue run evidence.remoteRefreshDurationMs 非法');
  }
  const evidence: IssueEngineEvidence = {
    ...(reviewBindingDigest === undefined ? {} : { reviewBindingDigest }),
    ...(storyValidationDigest === undefined ? {} : { storyValidationDigest }),
    ...(candidateProofDigest === undefined ? {} : { candidateProofDigest }),
    ...(reusedFinalReview === undefined ? {} : { reusedFinalReview }),
    ...(remoteRefreshDurationMs === undefined
      ? {}
      : { remoteRefreshDurationMs: remoteRefreshDurationMs as number }),
  };
  const lastExitCode = root.lastExitCode;
  if (lastExitCode !== null && !Number.isSafeInteger(lastExitCode)) {
    throw new Error('Issue run lastExitCode 非法');
  }
  return {
    schemaVersion: ISSUE_RUN_SCHEMA_VERSION,
    runId: sha256(root.runId, 'Issue run id'),
    repository: text(root.repository, 'Issue run repository'),
    issueNumber: positiveInteger(root.issueNumber, 'Issue run number'),
    readyAt: timestamp(root.readyAt, 'Issue run readyAt'),
    branch: text(root.branch, 'Issue run branch'),
    pullRequest: positiveInteger(root.pullRequest, 'Issue run PR'),
    pullRequestUrl: text(root.pullRequestUrl, 'Issue run PR URL'),
    phase: root.phase as IssueRunState['phase'],
    activeMs: nonNegativeInteger(root.activeMs, 'Issue run activeMs'),
    continuations: nonNegativeInteger(root.continuations, 'Issue run continuations'),
    currentHead: gitSha(root.currentHead, 'Issue run head'),
    lastExitCode: lastExitCode as number | null,
    message: text(root.message, 'Issue run message'),
    updatedAt: timestamp(root.updatedAt, 'Issue run updatedAt'),
    evidence,
    ...(root.trustedAt === undefined ? {} : { trustedAt: timestamp(root.trustedAt, 'trustedAt') }),
    ...(root.readyToTrustedMs === undefined
      ? {}
      : {
          readyToTrustedMs: nonNegativeInteger(root.readyToTrustedMs, 'readyToTrustedMs'),
        }),
    ...(root.waitingMs === undefined
      ? {}
      : { waitingMs: nonNegativeInteger(root.waitingMs, 'waitingMs') }),
  };
}

function stateFromComment(body: string): IssueRunState | null {
  const first = body.indexOf(ISSUE_RUN_COMMENT_MARKER);
  if (first < 0) return null;
  if (body.indexOf(ISSUE_RUN_COMMENT_MARKER, first + ISSUE_RUN_COMMENT_MARKER.length) >= 0) {
    throw new Error('Issue run 评论包含重复 marker');
  }
  const match = /```json\s*\n([\s\S]+?)\n```\s*$/u.exec(body);
  if (!match) throw new Error('Issue run 评论缺少状态 JSON');
  return parseIssueRunState(json(match[1], 'Issue run 评论状态'));
}

function bootstrapStateFromComment(body: string): IssueRunBootstrapState | null {
  const first = body.indexOf(ISSUE_RUN_BOOTSTRAP_COMMENT_MARKER);
  if (first < 0) return null;
  if (
    body.indexOf(
      ISSUE_RUN_BOOTSTRAP_COMMENT_MARKER,
      first + ISSUE_RUN_BOOTSTRAP_COMMENT_MARKER.length,
    ) >= 0
  ) {
    throw new Error('Issue run 预备评论包含重复 marker');
  }
  const match = /```json\s*\n([\s\S]+?)\n```\s*$/u.exec(body);
  if (!match) throw new Error('Issue run 预备评论缺少状态 JSON');
  const root = record(json(match[1], 'Issue run 预备评论状态'), 'Issue run 预备状态');
  if (
    root.schemaVersion !== ISSUE_RUN_SCHEMA_VERSION ||
    (root.phase !== 'prepared' && root.phase !== 'failed')
  ) {
    throw new Error('Issue run 预备状态 schema 或 phase 非法');
  }
  return {
    schemaVersion: ISSUE_RUN_SCHEMA_VERSION,
    runId: sha256(root.runId, 'Issue run 预备 id'),
    repository: text(root.repository, 'Issue run 预备 repository'),
    issueNumber: positiveInteger(root.issueNumber, 'Issue run 预备 number'),
    readyAt: timestamp(root.readyAt, 'Issue run 预备 readyAt'),
    branch: text(root.branch, 'Issue run 预备 branch'),
    phase: root.phase,
    activeMs: nonNegativeInteger(root.activeMs, 'Issue run 预备 activeMs'),
    continuations: nonNegativeInteger(root.continuations, 'Issue run 预备 continuations'),
    currentHead: gitSha(root.currentHead, 'Issue run 预备 head'),
    message: text(root.message, 'Issue run 预备 message'),
    updatedAt: timestamp(root.updatedAt, 'Issue run 预备 updatedAt'),
  };
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours}h ${minutes}m ${rest}s`;
}

export function renderIssueRunComment(state: IssueRunState): string {
  const phase = {
    prepared: '已准备',
    running: '运行中',
    'waiting-remote': '等待远端检查',
    failed: '失败，等待维护者处理或继续',
    trusted: '可信 PR 已就绪',
  }[state.phase];
  const metric =
    state.phase === 'trusted'
      ? `\n- ready → 可信 PR：${duration(state.readyToTrustedMs ?? 0)}\n- 实际运行：${duration(state.activeMs)}\n- 等待：${duration(state.waitingMs ?? 0)}`
      : '';
  const evidence = Object.entries(state.evidence)
    .map(([key, value]) => `- ${key}: \`${value}\``)
    .join('\n');
  return [
    ISSUE_RUN_COMMENT_MARKER,
    '',
    '## coding-x 单 Issue 运行',
    '',
    `状态：${phase}`,
    '',
    `- 运行：\`${state.runId}\``,
    `- 分支：\`${state.branch}\``,
    `- PR：${state.pullRequestUrl}`,
    `- 当前提交：\`${state.currentHead}\``,
    `- 继续次数：${state.continuations}`,
    `- 结果：${state.message}${metric}`,
    ...(evidence ? ['', '证据：', evidence] : []),
    '',
    '```json',
    JSON.stringify(state, null, 2),
    '```',
  ].join('\n');
}

function renderIssueRunBootstrapComment(state: IssueRunBootstrapState): string {
  return [
    ISSUE_RUN_BOOTSTRAP_COMMENT_MARKER,
    '',
    '## coding-x 单 Issue 运行',
    '',
    `状态：${state.phase === 'prepared' ? '正在建立分支和 PR' : '建立分支或 PR 失败'}`,
    '',
    `- 运行：\`${state.runId}\``,
    `- 分支：\`${state.branch}\``,
    '- PR：尚未建立',
    `- 当前提交：\`${state.currentHead}\``,
    `- 继续次数：${state.continuations}`,
    `- 结果：${state.message}`,
    '',
    '```json',
    JSON.stringify(state, null, 2),
    '```',
  ].join('\n');
}

function renderSourcePrd(options: {
  issue: ReadyIssue;
  runId: string;
  branch: string;
  date: string;
}): string {
  const { issue } = options;
  return `---
title: ${JSON.stringify(`Issue #${issue.number}: ${issue.title}`)}
status: active
updated: ${options.date}
scope: root
---

# Issue #${issue.number}: ${issue.title}

> GitHub Issue: ${issue.url}
> Issue-Run-ID: ${options.runId}
> Issue-Body-Digest: ${issue.bodyDigest}
> Issue-Execution-Contract-Digest: ${issue.executionContractDigest}
> Issue-Remote-Check-Mode: ${issue.executionContract.remoteDelivery.mode}
> Issue-Remote-Check-IDs: ${issue.executionContract.remoteDelivery.checkIds.join(',') || '-'}
> Ready-At: ${issue.readyAt}

## Goals

${issue.goal}

## Non-Goals

${issue.nonGoals}

## Risk

${issue.risk}

## User Stories

### US-001: 完成 Issue #${issue.number}

${issue.goal}

#### Execution Contract

\`\`\`json
${JSON.stringify(issue.executionContract, null, 2)}
\`\`\`

#### Acceptance Criteria

${issue.acceptanceCriteria.map((item) => `- [ ] ${item}`).join('\n')}

## Delivery Boundary

- 只在分支 \`${options.branch}\` 和对应 PR 内交付；不自动合并、不发布。
- Builder 的自述不构成完成；以引擎凭证、最终 Review 和当前 PR 远端总闸为准。
`;
}

function renderPrdJson(options: {
  repository: string;
  issue: ReadyIssue;
  runId: string;
  branch: string;
  sourcePath: string;
  contract: QualityContract;
  contractDigest: string;
}): Prd {
  return {
    project: options.repository,
    branchName: options.branch,
    description: `${options.issue.goal}\n\nIssue-Run-ID: ${options.runId}`,
    sourcePrd: options.sourcePath,
    qualityContractDigest: options.contractDigest,
    qualityChecks: deriveQualityChecks(options.contract),
    executionContract: structuredClone(options.issue.executionContract),
    executionContractDigest: options.issue.executionContractDigest,
    userStories: [
      {
        id: 'US-001',
        title: options.issue.title,
        description: [
          options.issue.goal,
          `明确的非目标：\n${options.issue.nonGoals}`,
          `风险说明：\n${options.issue.risk}`,
          `来源：${options.issue.url}`,
        ].join('\n\n'),
        acceptanceCriteria: options.issue.acceptanceCriteria,
        priority: 1,
      },
    ],
  };
}

function renderPullRequestBody(issue: ReadyIssue, sourcePath: string): string {
  return [
    '## 本次目标',
    issue.goal,
    '## 明确的非目标',
    issue.nonGoals,
    '## Spec 与验收标准来源',
    `${sourcePath}\n\nCloses #${issue.number}`,
    '## 验证方式',
    '由 coding-x 运行 Story 验收、最终 Review 与当前提交的 GitHub 总闸。',
    '## 风险说明',
    issue.risk,
    '## 深度评审',
    '- [ ] 我主动要求深度结构评审',
    '## 延期与政策例外',
    'P1-Deferral: 无\nPolicy-Exception: 无',
  ].join('\n\n');
}

function sourceBindings(source: string): {
  runId: string;
  bodyDigest: string;
  executionContractDigest: string;
} {
  const runId = /^> Issue-Run-ID:\s*(sha256:[0-9a-f]{64})\s*$/mu.exec(source)?.[1];
  const bodyDigest = /^> Issue-Body-Digest:\s*(sha256:[0-9a-f]{64})\s*$/mu.exec(source)?.[1];
  const executionContractDigest =
    /^> Issue-Execution-Contract-Digest:\s*(sha256:[0-9a-f]{64})\s*$/mu.exec(source)?.[1];
  if (!runId || !bodyDigest || !executionContractDigest) {
    throw new Error('Issue 源 PRD 缺少运行身份绑定');
  }
  const remoteModes = source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('> Issue-Remote-Check-Mode: '))
    .map((line) => line.slice('> Issue-Remote-Check-Mode: '.length));
  const remoteCheckIds = source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('> Issue-Remote-Check-IDs: '))
    .map((line) => line.slice('> Issue-Remote-Check-IDs: '.length));
  if (remoteModes.length !== 1 || remoteCheckIds.length !== 1) {
    throw new Error('Issue 源 PRD 的远端检查绑定必须各出现一次');
  }
  const contractMatches = [
    ...source.matchAll(
      /^#### Execution Contract\s*\r?\n+```json\s*\r?\n([\s\S]+?)\r?\n```/gmu,
    ),
  ];
  if (contractMatches.length !== 1) throw new Error('Issue 源 PRD 必须包含唯一执行合同快照');
  const contractJson = contractMatches[0][1];
  let contractValue: unknown;
  try {
    contractValue = JSON.parse(contractJson) as unknown;
  } catch (error) {
    throw new Error(
      `Issue 源 PRD 执行合同不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsedContract = parseIssueExecutionContract(contractValue);
  if (!parsedContract.ok || parsedContract.digest !== executionContractDigest) {
    throw new Error('Issue 源 PRD 执行合同与冻结摘要不一致');
  }
  const expectedRemoteIds = parsedContract.contract.remoteDelivery.checkIds.join(',') || '-';
  if (
    remoteModes[0] !== parsedContract.contract.remoteDelivery.mode ||
    remoteCheckIds[0] !== expectedRemoteIds
  ) {
    throw new Error('Issue 源 PRD 的远端检查绑定与执行合同不一致');
  }
  return { runId, bodyDigest, executionContractDigest };
}

function readIssueSource(path: string): Buffer {
  const source = readStableFile(path, {
    label: 'Issue 源 PRD',
    maxBytes: MAX_ISSUE_SOURCE_BYTES,
  });
  if (source.status === 'missing') throw new Error('Issue 源 PRD 不存在');
  if (source.status === 'invalid')
    throw new Error(`Issue 源 PRD 不可稳定读取：${source.diagnostic}`);
  return source.bytes;
}

function workspaceInsideRoot(root: string, workspace: string): string {
  const absolute = resolve(root, workspace);
  const rel = relative(resolve(root), absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Issue workspace 必须位于项目根内且不能等于项目根');
  }
  return absolute;
}

async function initializeIssueWorkspace(options: {
  root: string;
  workspace: string;
  repository: string;
  issue: ReadyIssue;
  runId: string;
  branch: string;
  sourcePath: string;
}): Promise<void> {
  await bootstrapWorkspace({ workspacePath: options.workspace });
  const existing = tryReadPrd(join(options.workspace, 'prd.json'));
  if (existing !== null) {
    const parsedExecution = parseIssueExecutionContract(existing.executionContract);
    if (
      existing.branchName !== options.branch ||
      existing.sourcePrd !== options.sourcePath ||
      !existing.description.includes(`Issue-Run-ID: ${options.runId}`) ||
      existing.executionContractDigest !== options.issue.executionContractDigest ||
      !parsedExecution.ok ||
      parsedExecution.digest !== options.issue.executionContractDigest
    ) {
      throw new Error('Issue workspace 已绑定其他运行，拒绝接管');
    }
    return;
  }
  const quality = readQualityContract(options.root);
  if (quality.status !== 'ready') throw new Error(`质量契约不可用：${quality.status}`);
  const source = readIssueSource(join(options.root, options.sourcePath));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: options.root,
    encoding: 'utf8',
  }).trim();
  const prd = renderPrdJson({
    repository: options.repository,
    issue: options.issue,
    runId: options.runId,
    branch: options.branch,
    sourcePath: options.sourcePath,
    contract: quality.contract,
    contractDigest: quality.digest,
  });
  const candidate: ApplyPrdV1Candidate = {
    prd: `${JSON.stringify(prd, null, 2)}\n`,
    state: null,
    progress: '# Progress\n',
  };
  const request: ApplyPrdV1Request = {
    schemaVersion: 1,
    mode: 'replace-feature',
    source: { bytes: source, digest: digestBytes(source) },
    git: { expectedHead: head, currentHead: head },
    quality: { expectedDigest: quality.digest, currentDigest: quality.digest },
    candidate: {
      ...candidate,
      digest: applyPrdV1CandidateDigest('replace-feature', candidate),
    },
  };
  const lease = await acquireWorkspaceLease({
    workspacePath: options.workspace,
    command: 'apply-prd',
  });
  const session = createWorkspaceSession(lease);
  try {
    await runApplyPrdV1Mutation(session, request, {
      projectRoot: options.root,
      runtimeMode: 'formal',
    });
    await session.close();
  } catch (error) {
    if (session.state === 'open') await session.close();
    throw error;
  }
}

function statusPaths(output: string): string[] {
  const entries = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4) throw new Error('git status 返回非法记录');
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      const previous = entries[index + 1];
      if (!previous) throw new Error('git status rename 记录不完整');
      paths.push(previous);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function remoteHead(output: string): string | null {
  const match = /^([0-9a-f]{40})\s+refs\/heads\//u.exec(output.trim());
  return match?.[1] ?? null;
}

function currentQualityPlatform(platform: NodeJS.Platform = process.platform): QualityPlatform {
  const qualityPlatform = qualityPlatformForNode(platform);
  if (qualityPlatform === null) {
    throw new Error(`当前平台 ${platform} 不受 ready Issue 执行合同支持`);
  }
  return qualityPlatform;
}

function qualityReadDiagnostic(read: Exclude<QualityContractReadResult, { status: 'ready' }>): string {
  if (read.status === 'missing') return '质量契约不存在';
  if (read.status === 'invalid') return read.errors.join('；');
  return read.error;
}

function issueRunComment(comments: IssueComment[], login: string): IssueRunComment | null {
  const matches = comments.flatMap((comment) => {
    if (comment.login.toLowerCase() !== login.toLowerCase() || comment.association !== 'OWNER') {
      return [];
    }
    const state = stateFromComment(comment.body);
    return state === null ? [] : [{ id: comment.id, htmlUrl: comment.htmlUrl, state }];
  });
  if (matches.length > 1) throw new Error('Issue 存在多条 owner 运行状态评论；请保留一条');
  return matches[0] ?? null;
}

function issueRunBootstrapComment(
  comments: IssueComment[],
  login: string,
): IssueRunBootstrapComment | null {
  const matches = comments.flatMap((comment) => {
    if (comment.login.toLowerCase() !== login.toLowerCase() || comment.association !== 'OWNER') {
      return [];
    }
    const state = bootstrapStateFromComment(comment.body);
    return state === null ? [] : [{ id: comment.id, htmlUrl: comment.htmlUrl, state }];
  });
  if (matches.length > 1) throw new Error('Issue 存在多条 owner 预备状态评论；请保留一条');
  return matches[0] ?? null;
}

export async function runReadyIssue(options: {
  readonly root: string;
  readonly workspaceBase: string;
  readonly issueNumber: number;
  /** production CLI always passes the selected runner; tests default to the only trusted runner. */
  readonly runner?: AgentKind;
  readonly runEngine: (context: {
    readonly workspace: string;
    readonly branch: string;
    readonly pullRequest: number;
  }) => Promise<IssueEngineResult>;
  readonly refreshEngine?: (context: {
    readonly workspace: string;
    readonly branch: string;
    readonly pullRequest: number;
  }) => Promise<IssueEngineResult | null>;
  readonly executor?: IssueRunCommandExecutor;
  readonly now?: () => Date;
  /** @internal Deterministic contract/platform seam; production reads the current repository. */
  readonly qualityContractReader?: (root: string) => QualityContractReadResult;
  /** @internal Deterministic live Ruleset seam; production reads GitHub before any Agent starts. */
  readonly remoteAuthorityReader?: (input: {
    readonly repository: string;
    readonly contract: QualityContract;
  }) => readonly string[];
  /** @internal Deterministic platform seam; production uses process.platform. */
  readonly platform?: QualityPlatform;
  /** @internal deterministic orchestration seam; production uses the safe workspace mutation. */
  readonly initializeWorkspace?: typeof initializeIssueWorkspace;
}): Promise<IssueRunResult> {
  const root = realpathSync(options.root);
  const execute = options.executor ?? defaultExecutor;
  const now = options.now ?? (() => new Date());
  const run = (command: 'git' | 'gh', args: readonly string[]): string =>
    execute({ command, args, cwd: root }).trim();
  const initialStatus = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const repository = parseRepository(
    json(run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']), 'GitHub 仓库'),
  );
  const login = text(
    record(json(run('gh', ['api', 'user']), 'GitHub 当前用户'), 'GitHub 当前用户').login,
    'GitHub 当前用户',
  );
  const owner = repository.nameWithOwner.split('/')[0];
  if (login.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Issue 入口当前只允许仓库 owner ${owner} 运行，当前用户为 ${login}`);
  }
  const readCurrentIssue = (): ReadyIssue =>
    parseReadyIssue(
      json(
        run('gh', ['api', `repos/${repository.nameWithOwner}/issues/${options.issueNumber}`]),
        'GitHub Issue',
      ),
      json(
        run('gh', [
          'api',
          '--paginate',
          '--slurp',
          `repos/${repository.nameWithOwner}/issues/${options.issueNumber}/events?per_page=100`,
        ]),
        'GitHub Issue events',
      ),
    );
  const issue = readCurrentIssue();
  if (issue.number !== options.issueNumber) throw new Error('GitHub 返回了错误的 Issue');
  const runId = issueRunId(repository.nameWithOwner, issue);
  const assertIssueIdentityCurrent = (): void => {
    const current = readCurrentIssue();
    if (
      current.number !== issue.number ||
      issueRunId(repository.nameWithOwner, current) !== runId ||
      current.bodyDigest !== issue.bodyDigest ||
      current.executionContractDigest !== issue.executionContractDigest ||
      current.readyAt !== issue.readyAt
    ) {
      throw new Error('Issue 内容或标签事件已变化；旧运行身份已失效');
    }
  };
  const branch = `codex/issue-${issue.number}`;
  const sourcePath = `docs/prds/prd-issue-${issue.number}.md`;
  const expectedSourcePrd = renderSourcePrd({
    issue,
    runId,
    branch,
    date: issue.readyAt.slice(0, 10),
  });
  const workspace = workspaceInsideRoot(root, join(options.workspaceBase, `issue-${issue.number}`));
  const readComments = () =>
    parseComments(
      json(
        run('gh', [
          'api',
          '--paginate',
          '--slurp',
          `repos/${repository.nameWithOwner}/issues/${issue.number}/comments?per_page=100`,
        ]),
        'GitHub Issue comments',
      ),
    );
  const initialComments = readComments();
  let comment = issueRunComment(initialComments, login);
  let bootstrapComment = issueRunBootstrapComment(initialComments, login);
  if (comment && bootstrapComment) {
    throw new Error('Issue 同时存在正式和预备运行状态评论；请保留一条');
  }
  const boundState = comment?.state ?? bootstrapComment?.state;
  if (
    boundState &&
    (boundState.runId !== runId ||
      boundState.repository !== repository.nameWithOwner ||
      boundState.issueNumber !== issue.number ||
      boundState.readyAt !== issue.readyAt ||
      boundState.branch !== branch)
  ) {
    throw new Error('Issue 状态评论已绑定其他运行');
  }
  const previousActive = boundState?.activeMs ?? 0;
  const continuations = (boundState?.continuations ?? 0) + 1;
  const started = now();
  const headAtEntry = run('git', ['rev-parse', 'HEAD']);
  const writeComment = (
    existing: { readonly id: number; readonly htmlUrl: string } | null,
    body: string,
  ): { id: number; htmlUrl: string } => {
    if (existing) {
      run('gh', [
        'api',
        '--method',
        'PATCH',
        `repos/${repository.nameWithOwner}/issues/comments/${existing.id}`,
        '--field',
        `body=${body}`,
      ]);
      return existing;
    }
    const created = record(
      json(
        run('gh', [
          'api',
          '--method',
          'POST',
          `repos/${repository.nameWithOwner}/issues/${issue.number}/comments`,
          '--field',
          `body=${body}`,
        ]),
        'GitHub Issue 状态评论',
      ),
      'GitHub Issue 状态评论',
    );
    return {
      id: positiveInteger(created.id, '状态评论 id'),
      htmlUrl: text(created.html_url, '状态评论 URL'),
    };
  };
  const publishBootstrap = (state: IssueRunBootstrapState): IssueRunBootstrapComment => {
    const written = writeComment(bootstrapComment, renderIssueRunBootstrapComment(state));
    return { ...written, state };
  };
  if (comment) {
    const state: IssueRunState = {
      ...comment.state,
      phase: 'prepared',
      activeMs: previousActive,
      continuations,
      currentHead: headAtEntry,
      lastExitCode: null,
      message: '正在核对或建立唯一分支和草稿 PR',
      updatedAt: started.toISOString(),
    };
    writeComment(comment, renderIssueRunComment(state));
    comment = { ...comment, state };
  } else {
    bootstrapComment = publishBootstrap({
      schemaVersion: ISSUE_RUN_SCHEMA_VERSION,
      runId,
      repository: repository.nameWithOwner,
      issueNumber: issue.number,
      readyAt: issue.readyAt,
      branch,
      phase: 'prepared',
      activeMs: previousActive,
      continuations,
      currentHead: headAtEntry,
      message: '正在建立唯一分支和草稿 PR',
      updatedAt: started.toISOString(),
    });
  }
  const publishEntryFailure = (error: unknown): void => {
    const failedAt = now();
    let currentHead = headAtEntry;
    try {
      currentHead = run('git', ['rev-parse', 'HEAD']);
    } catch {
      // 保留入口开始时已经核对的提交；报告原始失败优先。
    }
    const message = `Issue 入口准备失败：${error instanceof Error ? error.message : String(error)}`;
    if (comment) {
      const state: IssueRunState = {
        ...comment.state,
        phase: 'failed',
        activeMs: previousActive + Math.max(0, failedAt.getTime() - started.getTime()),
        currentHead,
        lastExitCode: 2,
        message,
        updatedAt: failedAt.toISOString(),
      };
      writeComment(comment, renderIssueRunComment(state));
      comment = { ...comment, state };
      return;
    }
    bootstrapComment = publishBootstrap({
      ...bootstrapComment!.state,
      phase: 'failed',
      activeMs: previousActive + Math.max(0, failedAt.getTime() - started.getTime()),
      currentHead,
      message,
      updatedAt: failedAt.toISOString(),
    });
  };

  let pullRequest: PullRequestObservation | undefined;
  const sourceAbsolute = join(root, sourcePath);
  const assertSourceCurrent = (): void => {
    const source = readIssueSource(sourceAbsolute).toString('utf8');
    if (normalizedIdentityText(source) !== normalizedIdentityText(expectedSourcePrd)) {
      throw new Error('Issue 源 PRD 正文已偏离冻结 Issue 意图');
    }
    const bindings = sourceBindings(source);
    if (
      bindings.runId !== runId ||
      bindings.bodyDigest !== issue.bodyDigest ||
      bindings.executionContractDigest !== issue.executionContractDigest
    ) {
      throw new Error('Issue 源 PRD 已变化；旧运行身份已失效');
    }
  };
  const remoteAuthorityReader =
    options.remoteAuthorityReader ??
    ((input: { readonly repository: string; readonly contract: QualityContract }) => {
      const client = new GhGitHubQualityClient();
      return reconcileIssueRemoteAuthority(
        input.contract,
        client.listRulesets(input.repository),
      );
    });
  const assertExecutionContractCapability = (readRemoteAuthority: boolean): void => {
    if ((options.runner ?? 'codex') !== 'codex') {
      throw new Error(
        `ready Issue 当前只能使用 codex 完成可信 Validator 闭环；${options.runner} 只能开发，拒绝在 Builder 后才发现无法签发凭证`,
      );
    }
    const quality = (options.qualityContractReader ?? readQualityContract)(root);
    if (quality.status !== 'ready') {
      throw new Error(`执行合同无法对账：${qualityReadDiagnostic(quality)}`);
    }
    const reconciliation = reconcileIssueExecutionContract(
      issue.executionContract,
      quality.contract,
      options.platform ?? currentQualityPlatform(),
    );
    if (!reconciliation.ok) {
      throw new Error(`执行合同无法启动：${reconciliation.errors.join('；')}`);
    }
    if (readRemoteAuthority) {
      const remoteErrors = remoteAuthorityReader({
        repository: repository.nameWithOwner,
        contract: quality.contract,
      });
      if (remoteErrors.length > 0) {
        throw new Error(`执行合同远端权威来源不可用：${remoteErrors.join('；')}`);
      }
    }
  };
  try {
    if (initialStatus !== '') {
      throw new Error('Issue 入口要求干净工作树；请先提交或处理现有改动');
    }
    assertExecutionContractCapability(true);
    const currentBranch = run('git', ['branch', '--show-current']);
    if (currentBranch !== repository.defaultBranch && currentBranch !== branch) {
      throw new Error(`Issue 入口只能从 ${repository.defaultBranch} 或 ${branch} 运行`);
    }

    const localBranch = run('git', ['branch', '--list', branch]).trim() !== '';
    const remoteBranch = remoteHead(
      run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]),
    );
    if (currentBranch !== branch) {
      if (localBranch) {
        run('git', ['switch', branch]);
      } else if (remoteBranch) {
        run('git', ['fetch', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
        run('git', ['switch', branch]);
      } else {
        run('git', ['fetch', '--quiet', 'origin', repository.defaultBranch]);
        const localHead = run('git', ['rev-parse', 'HEAD']);
        const defaultHead = run('git', [
          'rev-parse',
          `refs/remotes/origin/${repository.defaultBranch}`,
        ]);
        if (localHead !== defaultHead) {
          throw new Error(`本地 ${repository.defaultBranch} 不是最新远端提交；请先快进同步`);
        }
        run('git', ['switch', '-c', branch]);
      }
    }
    // 目标分支可能已有不同质量契约；在任何源 PRD 提交或 Agent 前按切换后的实际内容再核对。
    assertExecutionContractCapability(false);

    let pullRequests = parsePullRequests(
      json(
        run('gh', [
          'pr',
          'list',
          '--repo',
          repository.nameWithOwner,
          '--head',
          branch,
          '--state',
          'all',
          '--json',
          'number,state,isDraft,headRefOid,baseRefName,url,title,body',
        ]),
        'GitHub PR 列表',
      ),
    );
    if (pullRequests.length > 1) throw new Error('同一 Issue 分支存在多个 PR，拒绝猜测');
    pullRequest = pullRequests[0];
    if (
      pullRequest &&
      (pullRequest.state !== 'OPEN' || pullRequest.baseRefName !== repository.defaultBranch)
    ) {
      throw new Error('Issue 对应 PR 已关闭、合并或目标分支错误，不能继续原运行');
    }

    if (!pullRequest) {
      const existingSource = readStableFile(sourceAbsolute, {
        label: 'Issue 源 PRD',
        maxBytes: MAX_ISSUE_SOURCE_BYTES,
      });
      if (existingSource.status === 'invalid') {
        throw new Error(`Issue 源 PRD 不可稳定读取：${existingSource.diagnostic}`);
      }
      if (existingSource.status === 'ready') {
        assertSourceCurrent();
        const tracked = run('git', ['ls-files', '--', sourcePath]);
        if (tracked !== sourcePath) throw new Error('已有 Issue 源 PRD 尚未提交，拒绝自动接管');
      } else {
        if (remoteBranch) throw new Error('远端 Issue 分支缺少源 PRD，拒绝自动接管');
        mkdirSync(dirname(sourceAbsolute), { recursive: true });
        writeFileSync(
          sourceAbsolute,
          renderSourcePrd({
            issue,
            runId,
            branch,
            date: issue.readyAt.slice(0, 10),
          }),
        );
        run('git', ['add', '--', sourcePath]);
        run('git', ['commit', '-m', `docs: 从 Issue #${issue.number} 建立执行意图`]);
      }
      if (!remoteBranch) run('git', ['push', '-u', 'origin', branch]);
      run('gh', [
        'pr',
        'create',
        '--repo',
        repository.nameWithOwner,
        '--draft',
        '--base',
        repository.defaultBranch,
        '--head',
        branch,
        '--title',
        issue.title,
        '--body',
        renderPullRequestBody(issue, sourcePath),
      ]);
      pullRequests = parsePullRequests(
        json(
          run('gh', [
            'pr',
            'list',
            '--repo',
            repository.nameWithOwner,
            '--head',
            branch,
            '--state',
            'open',
            '--json',
            'number,state,isDraft,headRefOid,baseRefName,url,title,body',
          ]),
          '新建 PR 回读',
        ),
      );
      if (pullRequests.length !== 1) throw new Error('新建草稿 PR 后无法唯一回读');
      pullRequest = pullRequests[0];
    }
  } catch (error) {
    publishEntryFailure(error);
    throw error;
  }
  if (!pullRequest) throw new Error('Issue PR 不可用');
  assertPullRequestIntent(pullRequest, issue, sourcePath);
  const headBefore = run('git', ['rev-parse', 'HEAD']);
  if (
    comment &&
    (comment.state.runId !== runId ||
      comment.state.repository !== repository.nameWithOwner ||
      comment.state.issueNumber !== issue.number ||
      comment.state.readyAt !== issue.readyAt ||
      comment.state.branch !== branch ||
      comment.state.pullRequest !== pullRequest.number ||
      comment.state.pullRequestUrl !== pullRequest.url)
  ) {
    const error = new Error('Issue 状态评论已绑定其他 PR');
    publishEntryFailure(error);
    throw error;
  }
  const publish = (state: IssueRunState): IssueRunComment => {
    const body = renderIssueRunComment(state);
    if (comment) {
      writeComment(comment, body);
      return { ...comment, state };
    }
    const written = writeComment(bootstrapComment, body);
    bootstrapComment = null;
    return { ...written, state };
  };
  const previousEvidence = comment?.state.evidence ?? {};
  comment = publish({
    schemaVersion: ISSUE_RUN_SCHEMA_VERSION,
    runId,
    repository: repository.nameWithOwner,
    issueNumber: issue.number,
    readyAt: issue.readyAt,
    branch,
    pullRequest: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    phase: 'prepared',
    activeMs: previousActive,
    continuations,
    currentHead: headBefore,
    lastExitCode: null,
    message: '分支和 PR 已绑定，正在准备受控工作区',
    updatedAt: started.toISOString(),
    evidence: previousEvidence,
  });

  try {
    assertSourceCurrent();
    await (options.initializeWorkspace ?? initializeIssueWorkspace)({
      root,
      workspace,
      repository: repository.nameWithOwner,
      issue,
      runId,
      branch,
      sourcePath,
    });
    assertIssueIdentityCurrent();
    assertExecutionContractCapability(true);
    assertSourceCurrent();
    const beforeAgentPullRequests = parsePullRequests(
      json(
        run('gh', [
          'pr',
          'list',
          '--repo',
          repository.nameWithOwner,
          '--head',
          branch,
          '--state',
          'all',
          '--json',
          'number,state,isDraft,headRefOid,baseRefName,url,title,body',
        ]),
        'Agent 启动前 PR 回读',
      ),
    );
    if (
      beforeAgentPullRequests.length !== 1 ||
      beforeAgentPullRequests[0].number !== pullRequest.number ||
      beforeAgentPullRequests[0].state !== 'OPEN' ||
      beforeAgentPullRequests[0].baseRefName !== repository.defaultBranch
    ) {
      throw new Error('Agent 启动前 PR 的状态或目标分支已变化');
    }
    assertPullRequestIntent(beforeAgentPullRequests[0], issue, sourcePath);
    comment = publish({
      ...comment.state,
      phase: 'running',
      message: '引擎正在处理当前 Issue',
      updatedAt: started.toISOString(),
    });
  } catch (error) {
    const failedAt = now();
    const failedState: IssueRunState = {
      ...comment.state,
      phase: 'failed',
      activeMs: previousActive + Math.max(0, failedAt.getTime() - started.getTime()),
      currentHead: run('git', ['rev-parse', 'HEAD']),
      lastExitCode: 2,
      message: `Issue 运行准备失败：${error instanceof Error ? error.message : String(error)}`,
      updatedAt: failedAt.toISOString(),
    };
    comment = publish(failedState);
    return {
      exitCode: 2,
      phase: 'failed',
      branch,
      pullRequest: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      workspace,
      state: comment.state,
    };
  }

  let engine: IssueEngineResult;
  const engineContext = {
    workspace,
    branch,
    pullRequest: pullRequest.number,
  };
  try {
    engine =
      (await options.refreshEngine?.(engineContext)) ??
      (await options.runEngine(engineContext));
  } catch (error) {
    engine = {
      exitCode: 2,
      message: `引擎调用异常：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let currentHead = headBefore;
  try {
    assertIssueIdentityCurrent();
    assertSourceCurrent();
    const currentBranchAfter = run('git', ['branch', '--show-current']);
    if (currentBranchAfter !== branch) throw new Error('引擎运行后当前分支发生变化，拒绝推送');
    const dirty = statusPaths(
      run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    );
    const workspaceRelative = relative(root, workspace).split(sep).join('/');
    const unexpected = dirty.filter(
      (path) => path !== workspaceRelative && !path.startsWith(`${workspaceRelative}/`),
    );
    if (unexpected.length > 0) {
      engine = {
        exitCode: 2,
        message: `引擎结束后仍有未提交改动：${unexpected.join('、')}`,
        evidence: engine.evidence,
      };
    }
    currentHead = run('git', ['rev-parse', 'HEAD']);
    const observedRemoteHead = remoteHead(
      run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]),
    );
    let pushed = false;
    if (unexpected.length === 0 && observedRemoteHead !== currentHead) {
      run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      pushed = true;
    }
    const currentPullRequests = parsePullRequests(
      json(
        run('gh', [
          'pr',
          'list',
          '--repo',
          repository.nameWithOwner,
          '--head',
          branch,
          '--state',
          'all',
          '--json',
          'number,state,isDraft,headRefOid,baseRefName,url,title,body',
        ]),
        '引擎运行后 PR 回读',
      ),
    );
    if (
      currentPullRequests.length !== 1 ||
      currentPullRequests[0].number !== pullRequest.number ||
      currentPullRequests[0].state !== 'OPEN' ||
      currentPullRequests[0].baseRefName !== repository.defaultBranch
    ) {
      throw new Error('引擎运行后 PR 已关闭、消失、重复或改变目标分支');
    }
    let currentPullRequest = currentPullRequests[0];
    assertPullRequestIntent(currentPullRequest, issue, sourcePath);
    if (!pushed && currentPullRequest.headRefOid !== currentHead) {
      throw new Error('引擎运行后 PR 最新提交与已验证本地提交不一致');
    }

    if (engine.exitCode === 0 && !pushed && options.refreshEngine) {
      const confirmation = await options.refreshEngine(engineContext);
      if (confirmation === null) {
        engine = {
          exitCode: 6,
          message: '最终信任前无法再次证明现有 Review 与 PR 上下文仍然有效',
          evidence: engine.evidence,
        };
      } else {
        const firstDuration = engine.evidence?.remoteRefreshDurationMs;
        const confirmationDuration = confirmation.evidence?.remoteRefreshDurationMs;
        const totalDuration =
          firstDuration === undefined && confirmationDuration === undefined
            ? undefined
            : (firstDuration ?? 0) + (confirmationDuration ?? 0);
        engine = {
          ...confirmation,
          evidence: {
            ...engine.evidence,
            ...confirmation.evidence,
            ...(totalDuration === undefined
              ? {}
              : { remoteRefreshDurationMs: totalDuration }),
          },
        };
      }
    }

    let phase: IssueRunState['phase'];
    let exitCode = engine.exitCode;
    let message = engine.message;
    if (engine.exitCode === 0 && !pushed) {
      assertIssueIdentityCurrent();
      const finalPullRequests = parsePullRequests(
        json(
          run('gh', [
            'pr',
            'list',
            '--repo',
            repository.nameWithOwner,
            '--head',
            branch,
            '--state',
            'all',
            '--json',
            'number,state,isDraft,headRefOid,baseRefName,url,title,body',
          ]),
          '可信标记前 PR 回读',
        ),
      );
      if (
        finalPullRequests.length !== 1 ||
        finalPullRequests[0].number !== pullRequest.number ||
        finalPullRequests[0].state !== 'OPEN' ||
        finalPullRequests[0].baseRefName !== repository.defaultBranch ||
        finalPullRequests[0].headRefOid !== currentHead
      ) {
        throw new Error('可信标记前 PR 的状态、目标或最新提交已变化');
      }
      currentPullRequest = finalPullRequests[0];
      assertPullRequestIntent(currentPullRequest, issue, sourcePath);
      phase = 'trusted';
      if (currentPullRequest.isDraft) {
        run('gh', ['pr', 'ready', String(pullRequest.number), '--repo', repository.nameWithOwner]);
      }
      message = '当前 PR 最新提交已取得正式本地结论和远端总闸结论；未自动合并';
    } else if (engine.exitCode === 6 || (engine.exitCode === 0 && pushed)) {
      phase = 'waiting-remote';
      exitCode = 6;
      message = pushed
        ? '最新提交已推送，等待当前提交的远端检查；再次运行同一命令继续'
        : engine.message;
    } else {
      phase = 'failed';
    }
    const ended = now();
    const activeMs = previousActive + Math.max(0, ended.getTime() - started.getTime());
    const readyToTrustedMs = Math.max(0, ended.getTime() - Date.parse(issue.readyAt));
    const finalState: IssueRunState = {
      schemaVersion: ISSUE_RUN_SCHEMA_VERSION,
      runId,
      repository: repository.nameWithOwner,
      issueNumber: issue.number,
      readyAt: issue.readyAt,
      branch,
      pullRequest: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      phase,
      activeMs,
      continuations,
      currentHead,
      lastExitCode: exitCode,
      message,
      updatedAt: ended.toISOString(),
      evidence: engine.evidence ?? comment.state.evidence,
      ...(phase === 'trusted'
        ? {
            trustedAt: ended.toISOString(),
            readyToTrustedMs,
            waitingMs: Math.max(0, readyToTrustedMs - activeMs),
          }
        : {}),
    };
    comment = publish(finalState);
    return {
      exitCode,
      phase,
      branch,
      pullRequest: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      workspace,
      state: comment.state,
    };
  } catch (error) {
    const failedAt = now();
    const failedState: IssueRunState = {
      schemaVersion: ISSUE_RUN_SCHEMA_VERSION,
      runId,
      repository: repository.nameWithOwner,
      issueNumber: issue.number,
      readyAt: issue.readyAt,
      branch,
      pullRequest: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      phase: 'failed',
      activeMs: previousActive + Math.max(0, failedAt.getTime() - started.getTime()),
      continuations,
      currentHead,
      lastExitCode: 2,
      message: `Issue 运行收口失败：${error instanceof Error ? error.message : String(error)}`,
      updatedAt: failedAt.toISOString(),
      evidence: engine.evidence ?? comment.state.evidence,
    };
    comment = publish(failedState);
    return {
      exitCode: 2,
      phase: 'failed',
      branch,
      pullRequest: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      workspace,
      state: comment.state,
    };
  }
}

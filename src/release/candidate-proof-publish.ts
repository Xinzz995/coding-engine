import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readStableFile } from '../workspace-safety/stable-file.js';
import {
  CANDIDATE_PROOF_FILE,
  parseCandidateDogfoodProof,
  type CandidateDogfoodProof,
} from './candidate-proof.js';

export const CANDIDATE_PROOF_COMMENT_MARKER = '<!-- coding-x-candidate-proof-v1 -->' as const;

export interface CandidateProofCommandInvocation {
  readonly command: 'git' | 'gh';
  readonly args: readonly string[];
  readonly cwd: string;
}

export type CandidateProofCommandExecutor = (invocation: CandidateProofCommandInvocation) => string;

export interface PublishedCandidateProof {
  readonly status: 'created' | 'updated';
  readonly repository: string;
  readonly pullRequest: number;
  readonly url: string;
  readonly proofDigest: string;
}

interface RepositoryObservation {
  readonly nameWithOwner: string;
  readonly defaultBranchRef: { readonly name: string };
}

interface PullRequestObservation {
  readonly number: number;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly baseRefOid: string;
  readonly mergeStateStatus: string;
  readonly url: string;
}

interface CommentObservation {
  readonly id: number;
  readonly body: string;
  readonly html_url: string;
  readonly user: { readonly login: string };
  readonly author_association: string;
}

function defaultExecutor(invocation: CandidateProofCommandInvocation): string {
  return execFileSync(invocation.command, [...invocation.args], {
    cwd: invocation.cwd,
    encoding: 'utf8',
    timeout: 30_000,
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
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 缺失`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} 非法`);
  return value as number;
}

function flattenUnknownPages(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('GitHub PR comments 不是数组');
  const flattened: unknown[] = [];
  for (const entry of value as unknown[]) {
    if (Array.isArray(entry)) flattened.push(...(entry as unknown[]));
    else flattened.push(entry);
  }
  return flattened;
}

function parseRepository(value: unknown): RepositoryObservation {
  const root = record(value, 'GitHub 仓库观察');
  const defaultBranchRef = record(root.defaultBranchRef, 'GitHub 默认分支');
  return {
    nameWithOwner: text(root.nameWithOwner, 'GitHub 仓库名'),
    defaultBranchRef: { name: text(defaultBranchRef.name, 'GitHub 默认分支名') },
  };
}

function parsePullRequest(value: unknown): PullRequestObservation {
  const root = record(value, 'GitHub PR 观察');
  if (root.state !== 'OPEN' && root.state !== 'CLOSED' && root.state !== 'MERGED') {
    throw new Error('GitHub PR state 非法');
  }
  if (typeof root.isDraft !== 'boolean') throw new Error('GitHub PR isDraft 非法');
  return {
    number: positiveInteger(root.number, 'GitHub PR number'),
    state: root.state,
    isDraft: root.isDraft,
    headRefOid: text(root.headRefOid, 'GitHub PR head'),
    baseRefName: text(root.baseRefName, 'GitHub PR base'),
    baseRefOid: text(root.baseRefOid, 'GitHub PR base commit'),
    mergeStateStatus: text(root.mergeStateStatus, 'GitHub PR merge state'),
    url: text(root.url, 'GitHub PR URL'),
  };
}

function parseComments(value: unknown): CommentObservation[] {
  return flattenUnknownPages(value).map((entry, index) => {
    const root = record(entry, `GitHub PR comment[${index}]`);
    const user = record(root.user, `GitHub PR comment[${index}].user`);
    return {
      id: positiveInteger(root.id, `GitHub PR comment[${index}].id`),
      body: typeof root.body === 'string' ? root.body : '',
      html_url: text(root.html_url, `GitHub PR comment[${index}].html_url`),
      user: { login: text(user.login, `GitHub PR comment[${index}].user.login`) },
      author_association: text(
        root.author_association,
        `GitHub PR comment[${index}].author_association`,
      ),
    };
  });
}

function readProof(workspace: string): CandidateDogfoodProof {
  const path = join(workspace, CANDIDATE_PROOF_FILE);
  const read = readStableFile(path, { label: '候选 Dogfood 证明', maxBytes: 1024 * 1024 });
  if (read.status === 'missing') {
    throw new Error(
      `未找到候选 Dogfood 证明：${path}；若远端检查稍晚完成，请用同一候选 CLI ` +
        '追加 --candidate-evidence <packed.json> 后重试',
    );
  }
  if (read.status === 'invalid') throw new Error(read.diagnostic);
  return parseCandidateDogfoodProof(json(read.bytes.toString('utf8'), '候选 Dogfood 证明'));
}

export function renderCandidateProofComment(proof: CandidateDogfoodProof): string {
  return `${CANDIDATE_PROOF_COMMENT_MARKER}\n\n\`\`\`json\n${JSON.stringify(proof, null, 2)}\n\`\`\``;
}

export function publishCandidateProof(options: {
  readonly root: string;
  readonly workspace: string;
  readonly executor?: CandidateProofCommandExecutor;
}): PublishedCandidateProof {
  const execute = options.executor ?? defaultExecutor;
  const proof = readProof(options.workspace);
  const run = (command: 'git' | 'gh', args: readonly string[]): string =>
    execute({ command, args, cwd: options.root }).trim();
  const headSha = run('git', ['rev-parse', 'HEAD']);
  const branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (headSha !== proof.review.headSha) {
    throw new Error('当前提交与候选证明绑定的提交不一致；请重新完成候选验证');
  }

  const repository = parseRepository(
    json(
      run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']),
      'GitHub 仓库观察',
    ),
  );
  if (
    repository.nameWithOwner !== proof.repository.fullName ||
    repository.defaultBranchRef.name !== proof.repository.defaultBranch
  ) {
    throw new Error('当前 GitHub 仓库与候选证明绑定的仓库或默认分支不一致');
  }
  const owner = repository.nameWithOwner.split('/')[0];
  const login = text(
    record(json(run('gh', ['api', 'user']), 'GitHub 当前用户'), 'GitHub 当前用户').login,
    'GitHub 当前用户 login',
  );
  if (login.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`候选证明只能由仓库 owner ${owner} 发布，当前用户为 ${login}`);
  }

  const pullRequest = parsePullRequest(
    json(
      run('gh', [
        'pr',
        'view',
        branch,
        '--repo',
        repository.nameWithOwner,
        '--json',
        'number,state,isDraft,headRefOid,baseRefName,baseRefOid,mergeStateStatus,url',
      ]),
      'GitHub PR 观察',
    ),
  );
  if (
    pullRequest.number !== proof.review.prNumber ||
    pullRequest.state !== 'OPEN' ||
    pullRequest.isDraft ||
    pullRequest.headRefOid !== headSha ||
    pullRequest.baseRefName !== proof.repository.defaultBranch ||
    pullRequest.baseRefOid !== proof.review.baseSha ||
    pullRequest.mergeStateStatus !== 'CLEAN'
  ) {
    throw new Error('候选证明只可发布到当前提交、Review base 均未变化且可合并的开放非草稿 PR');
  }

  const comments = parseComments(
    json(
      run('gh', [
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository.nameWithOwner}/issues/${pullRequest.number}/comments?per_page=100`,
      ]),
      'GitHub PR comments',
    ),
  );
  const owned = comments.filter(
    (comment) =>
      comment.user.login.toLowerCase() === login.toLowerCase() &&
      comment.author_association === 'OWNER' &&
      comment.body.includes(CANDIDATE_PROOF_COMMENT_MARKER),
  );
  if (owned.length > 1) {
    throw new Error('当前 PR 存在多条 owner 候选证明评论；请保留一条后重试');
  }
  const body = renderCandidateProofComment(proof);
  if (owned.length === 1) {
    run('gh', [
      'api',
      '--method',
      'PATCH',
      `repos/${repository.nameWithOwner}/issues/comments/${owned[0].id}`,
      '--field',
      `body=${body}`,
    ]);
    return {
      status: 'updated',
      repository: repository.nameWithOwner,
      pullRequest: pullRequest.number,
      url: owned[0].html_url,
      proofDigest: proof.proofDigest,
    };
  }
  const created = record(
    json(
      run('gh', [
        'api',
        '--method',
        'POST',
        `repos/${repository.nameWithOwner}/issues/${pullRequest.number}/comments`,
        '--field',
        `body=${body}`,
      ]),
      'GitHub 新建评论',
    ),
    'GitHub 新建评论',
  );
  return {
    status: 'created',
    repository: repository.nameWithOwner,
    pullRequest: pullRequest.number,
    url: text(created.html_url, 'GitHub 新建评论 URL'),
    proofDigest: proof.proofDigest,
  };
}

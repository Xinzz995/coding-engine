import { CODING_X_VERSION } from '../version.js';
import { readQualityContract } from '../quality/contract.js';
import { GhGitHubQualityClient, type GitHubQualityClient } from '../quality/github.js';
import { digest, normalizeText } from './common.js';
import { runReviewPreflight } from './preflight.js';
import { evaluateReviewRemoteState } from './remote.js';
import { assessReviewRisk } from './risk.js';
import { readRunnerVersion } from './runner.js';
import { REVIEW_RULES_DIGEST } from './rules.js';
import { readFinalReviewState, type ReviewStateRead } from './state.js';
import { REVIEW_RULES_VERSION, type ReviewRemoteState } from './types.js';

export interface CurrentReviewStatus {
  read: ReviewStateRead;
  current: boolean;
  staleReasons: string[];
  refreshedRemote?: ReviewRemoteState;
}

export function collectCurrentReviewStatus(options: {
  workspace: string;
  projectRoot?: string;
  client?: GitHubQualityClient;
  refreshRemote?: boolean;
  codingXVersion?: string;
}): CurrentReviewStatus {
  const read = readFinalReviewState(options.workspace);
  if (read.status !== 'ready') return { read, current: false, staleReasons: [] };
  if (!options.projectRoot) return { read, current: true, staleReasons: [] };
  const contract = readQualityContract(options.projectRoot);
  if (contract.status !== 'ready') {
    return { read, current: false, staleReasons: [`质量契约不可用：${contract.status}`] };
  }
  const client = options.client ?? new GhGitHubQualityClient();
  const preflight = runReviewPreflight({
    root: options.projectRoot,
    workspace: options.workspace,
    currentContract: contract.contract,
    client,
  });
  if (preflight.status !== 'ready') {
    return { read, current: false, staleReasons: [preflight.message] };
  }
  const context = preflight.context;
  const saved = read.state.binding;
  const staleReasons: string[] = [];
  const compare = (name: string, actual: string, expected: string) => {
    if (actual !== expected) staleReasons.push(`${name} 已变化`);
  };
  if (saved.prNumber !== context.pullRequest.number) staleReasons.push('PR 编号已变化');
  compare('目标分支', saved.targetBranch, context.pullRequest.baseBranch);
  compare('base SHA', saved.baseSha, context.baseSha);
  compare('head SHA', saved.headSha, context.headSha);
  compare('PR 标题', saved.prTitleDigest, digest(normalizeText(context.pullRequest.title)));
  compare('PR 正文', saved.prBodyDigest, digest(normalizeText(context.pullRequest.body)));
  compare('Spec', saved.specDigest, digest(context.specs));
  compare('工程规范', saved.engineeringStandardsDigest, digest(context.engineeringStandards));
  compare('质量契约', saved.qualityContractDigest, context.baseContractDigest);
  compare('coding-x 版本', saved.codingXVersion, options.codingXVersion ?? CODING_X_VERSION);
  compare('Review 规则版本', saved.reviewRulesVersion, REVIEW_RULES_VERSION);
  compare('Review 规则', saved.reviewRulesDigest, REVIEW_RULES_DIGEST);
  compare('风险判断', saved.riskDigest, assessReviewRisk(context).digest);
  try {
    compare('Runner 版本', saved.runnerVersion, readRunnerVersion(saved.runner));
  } catch (error) {
    staleReasons.push(error instanceof Error ? error.message : String(error));
  }
  const current = staleReasons.length === 0;
  const refreshedRemote = current && options.refreshRemote
    ? evaluateReviewRemoteState({ context, contract: context.baseContract, client })
    : undefined;
  return { read, current, staleReasons, ...(refreshedRemote ? { refreshedRemote } : {}) };
}

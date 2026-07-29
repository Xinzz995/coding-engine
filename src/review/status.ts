import { CODING_X_VERSION } from '../version.js';
import { readQualityContract } from '../quality/contract.js';
import { GhGitHubQualityClient, type GitHubQualityClient } from '../quality/github.js';
import { digest, normalizeText } from './common.js';
import {
  revalidateReviewContext,
  runReviewPreflight,
  type ReviewContextRevalidation,
  type ReviewPreflightResult,
} from './preflight.js';
import { evaluateReviewRemoteState } from './remote.js';
import { unresolvedBlockingFindings } from './decisions.js';
import { applyReviewerDeepReviewRequest, assessReviewRisk } from './risk.js';
import { readRunnerVersion } from './runner.js';
import { REVIEW_RULES_DIGEST } from './rules.js';
import { freezeReviewDecisions, readFinalReviewState, type ReviewStateRead } from './state.js';
import { REVIEW_RULES_VERSION, type ReviewRemoteState } from './types.js';
import type { ReviewDecisionsSnapshot, ReviewFinding } from './types.js';

export interface CurrentReviewStatus {
  read: ReviewStateRead;
  current: boolean;
  staleReasons: string[];
  refreshedRemote?: ReviewRemoteState;
}

export interface ReviewLocalIdentity {
  storyValidationDigest: string | null;
  reviewRoutingDigest: string | null;
}

export function collectCurrentReviewStatus(options: {
  workspace: string;
  projectRoot?: string;
  client?: GitHubQualityClient;
  refreshRemote?: boolean;
  codingXVersion?: string;
  /** status 已按当前 PRD/HEAD 计算的 Story Validator 凭证摘要。 */
  storyValidationDigest?: string | null;
  /** 当前 PRD models 路由政策的规范化摘要。 */
  reviewRoutingDigest?: string | null;
  /** 测试注入点；生产调用始终使用完整 preflight。 */
  preflight?: () => ReviewPreflightResult;
  /** 测试注入点；生产调用在远端查询前后核对真实 Git/PR 身份。 */
  revalidate?: () => ReviewContextRevalidation;
  /** 测试注入点；生产调用读取真实 Ruleset 与检查任务。 */
  remote?: () => ReviewRemoteState;
  /** 测试注入点；生产调用读取真实 Runner 版本。 */
  runnerVersion?: () => string;
  /** 远端查询前后重读 Story 凭证与 PRD 路由，防止本地并发变化复用旧绿色。 */
  localIdentity?: () => ReviewLocalIdentity;
}): CurrentReviewStatus {
  const read = readFinalReviewState(options.workspace);
  if (read.status !== 'ready') return { read, current: false, staleReasons: [] };
  const saved = read.state.binding;
  const savedStateDigest = digest(read.state);
  const staleReasons: string[] = [];
  const addStale = (reason: string) => {
    if (!staleReasons.includes(reason)) staleReasons.push(reason);
  };
  if (options.storyValidationDigest === null || options.storyValidationDigest === undefined) {
    addStale('Story Validator 凭证不完整或已失效');
  } else if (saved.storyValidationDigest !== options.storyValidationDigest) {
    addStale('Story Validator 凭证已变化');
  }
  if (options.reviewRoutingDigest === null || options.reviewRoutingDigest === undefined) {
    addStale('PRD 模型路由无法核对');
  } else if (saved.reviewRoutingDigest !== options.reviewRoutingDigest) {
    addStale('PRD 模型路由已变化');
  }
  const compareReviewDecisions = (): ReviewDecisionsSnapshot | null => {
    try {
      const snapshot = freezeReviewDecisions(options.workspace);
      if (saved.reviewDecisionsDigest !== snapshot.digest) {
        addStale('Review 裁决记录已变化');
      }
      return snapshot;
    } catch (error) {
      addStale(`Review 裁决记录无效：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const deferredP1Findings = (snapshot: ReviewDecisionsSnapshot | null): ReviewFinding[] => {
    if (!snapshot) return [];
    return read.state.axes
      .flatMap((axis) => axis.findings)
      .filter((finding) => {
        if (finding.severity !== 'P1') return false;
        return snapshot.value.decisions
          .filter(
            (decision) =>
              decision.findingId === finding.id && decision.headSha === saved.headSha,
          )
          .at(-1)?.action === 'p1-deferred';
      });
  };
  const compareLocalSources = (phase: string) => {
    const latest = readFinalReviewState(options.workspace);
    if (latest.status !== 'ready' || digest(latest.state) !== savedStateDigest) {
      addStale(`${phase}本地最终 Review 状态已变化`);
    }
    if (!options.localIdentity) return;
    try {
      const current = options.localIdentity();
      if (current.storyValidationDigest === null) {
        addStale(`${phase}Story Validator 凭证不完整或已失效`);
      } else if (current.storyValidationDigest !== saved.storyValidationDigest) {
        addStale(`${phase}Story Validator 凭证已变化`);
      }
      if (current.reviewRoutingDigest === null) {
        addStale(`${phase}PRD 模型路由无法核对`);
      } else if (current.reviewRoutingDigest !== saved.reviewRoutingDigest) {
        addStale(`${phase}PRD 模型路由已变化`);
      }
    } catch (error) {
      addStale(
        `${phase}本地 Review 依赖无法重新核对：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  let decisionsSnapshot = compareReviewDecisions();
  if (deferredP1Findings(decisionsSnapshot).length > 0 && !options.refreshRemote) {
    addStale('P1 延期 Issue 尚未重新核验');
  }
  if (!options.projectRoot) {
    compareLocalSources('状态收集期间');
    return { read, current: staleReasons.length === 0, staleReasons };
  }
  const contract = readQualityContract(options.projectRoot);
  if (contract.status !== 'ready') {
    return { read, current: false, staleReasons: [`质量契约不可用：${contract.status}`] };
  }
  const client = options.client ?? new GhGitHubQualityClient();
  const preflight =
    options.preflight?.() ??
    runReviewPreflight({
      root: options.projectRoot,
      workspace: options.workspace,
      currentContract: contract.contract,
      client,
    });
  if (preflight.status !== 'ready') {
    return { read, current: false, staleReasons: [preflight.message] };
  }
  const context = preflight.context;
  const compare = (name: string, actual: string, expected: string) => {
    if (actual !== expected) addStale(`${name} 已变化`);
  };
  if (saved.prNumber !== context.pullRequest.number) addStale('PR 编号已变化');
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
  const currentRisk = applyReviewerDeepReviewRequest(
    assessReviewRisk(context),
    read.state.axes.some((axis) => axis.axis !== 'deep' && axis.requestDeepReview),
  );
  compare('风险判断', saved.riskDigest, currentRisk.digest);
  const currentRunnerVersion = () =>
    options.runnerVersion?.()
    ?? readRunnerVersion(saved.runner, undefined, { projectRoot: options.projectRoot });
  try {
    compare('Runner 版本', saved.runnerVersion, currentRunnerVersion());
  } catch (error) {
    addStale(error instanceof Error ? error.message : String(error));
  }
  compareLocalSources('本地核对期间');
  if (staleReasons.length > 0 || !options.refreshRemote) {
    return { read, current: staleReasons.length === 0, staleReasons };
  }

  const revalidate = (): ReviewContextRevalidation =>
    options.revalidate?.() ?? revalidateReviewContext(context, client);
  const beforeRemote = revalidate();
  if (!beforeRemote.ok) {
    return { read, current: false, staleReasons: [beforeRemote.message] };
  }
  const refreshedRemote =
    options.remote?.() ??
    evaluateReviewRemoteState({ context, contract: context.baseContract, client });
  const afterRemote = revalidate();
  if (!afterRemote.ok) {
    return {
      read,
      current: false,
      staleReasons: [afterRemote.message],
      refreshedRemote,
    };
  }
  try {
    compare('Runner 版本', saved.runnerVersion, currentRunnerVersion());
  } catch (error) {
    addStale(error instanceof Error ? error.message : String(error));
  }
  decisionsSnapshot = compareReviewDecisions();
  compareLocalSources('远端查询期间');
  const deferredFindings = deferredP1Findings(decisionsSnapshot);
  if (deferredFindings.length > 0 && decisionsSnapshot) {
    const resolution = unresolvedBlockingFindings({
      findings: deferredFindings,
      decisions: decisionsSnapshot.value.decisions,
      headSha: saved.headSha,
      contract: context.baseContract,
      client,
    });
    if (resolution.decisionErrors.length > 0) {
      for (const error of resolution.decisionErrors) addStale(`P1 延期 Issue 已失效：${error}`);
    } else if (resolution.unresolved.length > 0) {
      addStale('P1 延期 Issue 已失效');
    }
    const afterDeferral = revalidate();
    if (!afterDeferral.ok) addStale(afterDeferral.message);
    try {
      compare('Runner 版本', saved.runnerVersion, currentRunnerVersion());
    } catch (error) {
      addStale(error instanceof Error ? error.message : String(error));
    }
    compareReviewDecisions();
    compareLocalSources('P1 延期核验期间');
  }
  return {
    read,
    current: staleReasons.length === 0,
    staleReasons,
    refreshedRemote,
  };
}

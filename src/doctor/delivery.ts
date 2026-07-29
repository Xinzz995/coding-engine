import { join, resolve } from 'node:path';
import { readSafeProjectFileUtf8Sync } from '../engine/safe-control-file.js';
import type { QualityContract } from '../quality/contract.js';
import {
  GITHUB_ACTIONS_APP_ID,
  GhGitHubQualityClient,
  GitHubQualityError,
  type GitHubQualityErrorKind,
  type GitHubIssueInfo,
  type GitHubQualityClient,
  type RequiredStatusCheck,
} from '../quality/github.js';
import { renderManagedGitHubFiles } from '../quality/github-workflows.js';
import { findManagedRuleset, validateManagedRuleset } from '../quality/ruleset.js';
import {
  findManagedReleaseRuleset,
  validateManagedReleaseRuleset,
} from '../quality/release-ruleset.js';
import { validateP1DeferralIssue, validatePolicyExceptionIssue } from '../review/decisions.js';
import { readFinalReviewState, readReviewDecisions } from '../review/state.js';

export interface DeliveryGateIssue {
  file: string;
  message: string;
}

export interface DeliveryGateCheckResult {
  status: 'skipped' | 'local-ready' | 'ready' | 'invalid';
  remoteChecked: boolean;
  remoteFailure: { kind: GitHubQualityErrorKind; attempts: number } | null;
  repository: string | null;
  rulesetId: number | null;
  releaseRulesetId: number | null;
  immutableReleases: boolean | null;
  managedFilesChecked: number;
  exceptionIssuesChecked: number;
  issues: DeliveryGateIssue[];
}

function validateIssue(
  issue: GitHubIssueInfo,
  kind: 'p1' | 'policy',
  contract: QualityContract,
  now: Date,
): string[] {
  return kind === 'p1'
    ? validateP1DeferralIssue(issue, contract.exceptions.p1.maxDays, now)
    : validatePolicyExceptionIssue(issue, contract.exceptions.policy.maxDays, now);
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

const MANAGED_GITHUB_FILE_MAX_BYTES = 4 * 1024 * 1024;

function localIssues(
  root: string,
  workspace: string,
  contract: QualityContract,
): DeliveryGateIssue[] {
  const issues: DeliveryGateIssue[] = [];
  const workspacePath = resolve(root, workspace);
  for (const [relativePath, expected] of Object.entries(renderManagedGitHubFiles(contract))) {
    const path = join(root, relativePath);
    let actual: string | null;
    try {
      actual = readSafeProjectFileUtf8Sync(root, path, {
        maxBytes: MANAGED_GITHUB_FILE_MAX_BYTES,
        allowMissing: true,
      });
    } catch (error) {
      issues.push({
        file: relativePath,
        message: `无法安全读取托管文件：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (actual === null) {
      issues.push({
        file: relativePath,
        message: '缺少由质量契约生成的托管文件；请重跑 coding-x init',
      });
      continue;
    }
    if (normalizeLineEndings(actual) !== normalizeLineEndings(expected)) {
      issues.push({ file: relativePath, message: '内容与当前质量契约的确定性生成结果不一致' });
    }
  }
  try {
    readReviewDecisions(workspacePath);
  } catch (error) {
    issues.push({
      file: join(workspace, 'review-decisions.json'),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const review = readFinalReviewState(workspacePath);
  if (review.status === 'invalid') {
    issues.push({ file: join(workspace, 'final-review.json'), message: review.error });
  } else if (review.status === 'unsupported') {
    issues.push({
      file: join(workspace, 'final-review.json'),
      message: `Final Review v${review.schemaVersion} 已失效；请重新运行 coding-x 生成当前格式`,
    });
  }
  return issues;
}

function currentP1IssueNumbers(root: string, workspace: string): number[] {
  const workspacePath = resolve(root, workspace);
  const review = readFinalReviewState(workspacePath);
  if (review.status !== 'ready') return [];
  const decisions = readReviewDecisions(workspacePath).decisions.filter(
    (decision) => decision.headSha === review.state.binding.headSha,
  );
  const latest = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) latest.set(decision.findingId, decision);
  return [
    ...new Set(
      [...latest.values()]
        .filter((decision) => decision.action === 'p1-deferred')
        .map((decision) => decision.issue ?? 0),
    ),
  ];
}

/** 本地生成物与真实 GitHub 状态的只读漂移检查。 */
export function checkDeliveryGate(options: {
  root: string;
  workspace: string;
  contract: QualityContract | null;
  local: boolean;
  client?: GitHubQualityClient;
  now?: Date;
}): DeliveryGateCheckResult {
  if (!options.contract) {
    return {
      status: 'skipped',
      remoteChecked: false,
      repository: null,
      rulesetId: null,
      remoteFailure: null,
      releaseRulesetId: null,
      immutableReleases: null,
      managedFilesChecked: 0,
      exceptionIssuesChecked: 0,
      issues: [],
    };
  }
  const contract = options.contract;
  const issues = localIssues(options.root, options.workspace, contract);
  const base: DeliveryGateCheckResult = {
    status: issues.length === 0 ? 'local-ready' : 'invalid',
    remoteChecked: false,
    remoteFailure: null,
    repository: contract.repository.fullName,
    rulesetId: null,
    releaseRulesetId: null,
    immutableReleases: null,
    managedFilesChecked: Object.keys(renderManagedGitHubFiles(contract)).length,
    exceptionIssuesChecked: 0,
    issues,
  };
  if (options.local) return base;

  const client = options.client ?? new GhGitHubQualityClient();
  const now = options.now ?? new Date();
  let exceptionIssuesChecked = 0;
  let remoteFailure: DeliveryGateCheckResult['remoteFailure'] = null;
  try {
    const repository = client.discoverRepository(options.root);
    if (
      repository.fullName !== contract.repository.fullName ||
      repository.defaultBranch !== contract.repository.defaultBranch
    ) {
      issues.push({
        file: '.coding-x/quality.json',
        message:
          `契约绑定 ${contract.repository.fullName}/${contract.repository.defaultBranch}，` +
          `实际远端为 ${repository.fullName}/${repository.defaultBranch}`,
      });
    }
    client.verifyDefaultBranch(repository);
    if (contract.github.securityFeatures) {
      if (!client.getSecurityFeatures) {
        issues.push({
          file: 'GitHub Security',
          message: '当前 GitHub 适配器无法核验契约声明的仓库安全功能',
        });
      } else {
        const actual = client.getSecurityFeatures(repository.fullName);
        const labels = {
          dependabotSecurityUpdates: 'Dependabot 自动安全更新',
          secretScanning: '秘密扫描',
          secretScanningPushProtection: '秘密推送保护',
        } as const;
        for (const name of Object.keys(labels) as Array<keyof typeof labels>) {
          const expected = contract.github.securityFeatures[name];
          if (actual[name] !== expected) {
            issues.push({
              file: 'GitHub Security',
              message: `${labels[name]}实际为${actual[name] ? '启用' : '关闭'}，契约要求${expected ? '启用' : '关闭'}`,
            });
          }
        }
      }
    }
    const rulesets = client.listRulesets(repository.fullName);
    const ruleset = findManagedRuleset(rulesets);
    if (!ruleset) {
      issues.push({ file: 'GitHub Ruleset', message: '未找到 coding-x 管理的默认分支 Ruleset' });
    } else {
      base.rulesetId = ruleset.id;
      const expectedChecks: RequiredStatusCheck[] = contract.github.requiredChecks.map(
        (context) => ({
          context,
          integration_id: GITHUB_ACTIONS_APP_ID,
        }),
      );
      for (const message of validateManagedRuleset(
        ruleset,
        expectedChecks,
        contract.github.requiredCodeScanning,
      )) {
        issues.push({ file: `GitHub Ruleset #${ruleset.id}`, message });
      }
    }

    if (contract.release.protectedRefs.length > 0) {
      const releaseRuleset = findManagedReleaseRuleset(rulesets);
      if (!releaseRuleset) {
        issues.push({
          file: 'GitHub Release Ruleset',
          message: '未找到 coding-x 管理的发布标签 Ruleset',
        });
      } else {
        base.releaseRulesetId = releaseRuleset.id;
        for (const message of validateManagedReleaseRuleset(
          releaseRuleset,
          contract.release.protectedRefs,
        )) {
          issues.push({ file: `GitHub Release Ruleset #${releaseRuleset.id}`, message });
        }
      }
    }
    if (contract.github.immutableReleases === true) {
      if (!client.getImmutableReleases) {
        issues.push({
          file: 'GitHub Releases',
          message: '当前 GitHub 适配器无法核验不可变 Release 状态',
        });
      } else {
        base.immutableReleases = client.getImmutableReleases(repository.fullName).enabled;
        if (!base.immutableReleases) {
          issues.push({ file: 'GitHub Releases', message: '不可变 Release 实际为关闭' });
        }
      }
    }

    if (!client.listOpenIssuesByLabel) {
      issues.push({ file: 'GitHub Issues', message: '当前 GitHub 适配器无法检查开放的质量例外' });
    } else {
      for (const kind of ['p1', 'policy'] as const) {
        const label = kind === 'p1' ? 'quality-p1-deferral' : 'quality-policy-exception';
        for (const issue of client.listOpenIssuesByLabel(repository.fullName, label)) {
          exceptionIssuesChecked++;
          for (const message of validateIssue(issue, kind, contract, now)) {
            issues.push({ file: `GitHub Issue #${issue.number}`, message });
          }
        }
      }
    }

    const referenced = currentP1IssueNumbers(options.root, options.workspace);
    for (const number of referenced) {
      if (number < 1) {
        issues.push({
          file: join(options.workspace, 'review-decisions.json'),
          message: 'P1 延期决定缺少 Issue 编号',
        });
        continue;
      }
      if (!client.getIssue) {
        issues.push({
          file: `GitHub Issue #${number}`,
          message: '当前 GitHub 适配器无法核验 P1 延期 Issue',
        });
        continue;
      }
      const issue = client.getIssue(repository.fullName, number);
      exceptionIssuesChecked++;
      for (const message of validateP1DeferralIssue(issue, contract.exceptions.p1.maxDays, now)) {
        issues.push({ file: `GitHub Issue #${number}`, message });
      }
    }
  } catch (error) {
    if (error instanceof GitHubQualityError) {
      remoteFailure = { kind: error.kind, attempts: error.attempts };
      const prefix =
        error.kind === 'transient'
          ? `GitHub 远端暂时不可用，${error.attempts} 次尝试后仍无法完成核验`
          : error.kind === 'unauthenticated'
            ? 'GitHub CLI 未认证，无法完成远端核验'
            : error.kind === 'forbidden'
              ? 'GitHub 权限不足，无法完成远端核验'
              : 'GitHub 返回结果无法完成远端核验';
      issues.push({ file: 'GitHub Probe', message: `${prefix}：${error.detail ?? error.message}` });
    } else {
      remoteFailure = { kind: 'unknown', attempts: 1 };
      issues.push({
        file: 'GitHub Probe',
        message: `GitHub 远端核验异常：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return {
    ...base,
    status: issues.length === 0 ? 'ready' : 'invalid',
    remoteChecked: remoteFailure === null,
    remoteFailure,
    exceptionIssuesChecked,
    issues,
  };
}

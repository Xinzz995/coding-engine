import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readManagedQualityAsset,
  type ManagedQualityAsset,
} from './assets.js';
import {
  readQualityContract,
  readQualityExceptions,
} from './contract.js';
import {
  GitHubClient,
  QUALITY_RELEASE_RULESET_NAME,
  QUALITY_RULESET_NAME,
  verifyQualityBranchRuleset,
  verifyQualityReleaseRuleset,
} from './github.js';
import {
  gitHead,
  gitText,
  repositoryFromRemote,
} from './git.js';
import {
  appendQualityReceipt,
  nextReceiptRound,
} from './receipt.js';
import type {
  QualityError,
  QualityReceipt,
} from './types.js';

const MANAGED_FILES: Array<{
  source: ManagedQualityAsset;
  path: string;
}> = [
  {
    source: 'github/coding-x-project-checks.yml',
    path: join('.github', 'workflows', 'coding-x-project-checks.yml'),
  },
  {
    source: 'github/coding-x-review.yml',
    path: join('.github', 'workflows', 'coding-x-review.yml'),
  },
  {
    source: 'github/coding-x-doctor.yml',
    path: join('.github', 'workflows', 'coding-x-doctor.yml'),
  },
  {
    source: 'github/pull_request_template.md',
    path: join('.github', 'pull_request_template.md'),
  },
];

export interface QualityDoctorCheck {
  id: string;
  status: 'passed' | 'unverifiable';
  message: string;
}

function isTracked(root: string, path: string): boolean {
  try {
    gitText(root, ['ls-files', '--error-unmatch', '--', path]);
    return true;
  } catch {
    return false;
  }
}

function isIgnored(root: string, path: string): boolean {
  try {
    gitText(root, ['check-ignore', '--no-index', '--', path]);
    return true;
  } catch {
    return false;
  }
}

function trackedWorkspacePaths(root: string): string[] | null {
  try {
    const paths = gitText(root, ['ls-files', '--', '.workspace']);
    return paths === '' ? [] : paths.split('\n');
  } catch {
    return null;
  }
}

function errorsOf(checks: QualityDoctorCheck[]): QualityError[] {
  return checks
    .filter((check) => check.status !== 'passed')
    .map((check) => ({ code: check.id, message: check.message }));
}

export async function runQualityDoctor(opts: {
  root: string;
  workspace: string;
  remote: boolean;
  token?: string;
  client?: GitHubClient;
  now?: Date;
}): Promise<{ receipt: QualityReceipt; checks: QualityDoctorCheck[] }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const checks: QualityDoctorCheck[] = [];
  const contractRead = readQualityContract(opts.root);
  if (contractRead.status !== 'valid') {
    checks.push({
      id: 'contract-invalid',
      status: 'unverifiable',
      message: contractRead.status === 'missing' ? '缺少 .coding-x/quality.json' : contractRead.errors.join('；'),
    });
    const receipt: QualityReceipt = {
      version: 1,
      kind: 'doctor',
      round: nextReceiptRound(opts.workspace, 'doctor'),
      status: 'unverifiable',
      at: now.toISOString(),
      repository: null,
      baseSha: null,
      headSha: null,
      contractSha256: null,
      findings: [],
      exceptions: [],
      errors: errorsOf(checks),
      durationMs: Date.now() - started,
    };
    appendQualityReceipt(opts.workspace, receipt);
    return { receipt, checks };
  }
  const contract = contractRead.contract;
  checks.push({
    id: 'contract-valid',
    status: 'passed',
    message: '质量契约结构有效',
  });
  for (const { source, path } of MANAGED_FILES) {
    const absolute = join(opts.root, path);
    const expected = readManagedQualityAsset(source, contract.github.codingXVersion);
    const current = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
    checks.push({
      id: `managed-file:${path}`,
      status: current === expected && isTracked(opts.root, path) ? 'passed' : 'unverifiable',
      message: current === null
        ? `缺少受管文件 ${path}`
        : current !== expected
          ? `受管文件内容漂移 ${path}`
          : isTracked(opts.root, path)
            ? `受管文件内容与 Git 跟踪状态正常：${path}`
            : `受管文件尚未纳入 Git ${path}`,
    });
  }
  checks.push({
    id: 'contract-tracked',
    status: isTracked(opts.root, '.coding-x/quality.json') ? 'passed' : 'unverifiable',
    message: isTracked(opts.root, '.coding-x/quality.json')
      ? '质量契约已纳入 Git'
      : '质量契约必须纳入 Git',
  });
  const workspaceTracked = trackedWorkspacePaths(opts.root);
  const workspaceIgnored = isIgnored(
    opts.root,
    '.workspace/quality/.coding-x-ignore-probe',
  );
  const ignoreFileTracked = isTracked(opts.root, '.gitignore');
  const workspaceIsolated = workspaceIgnored
    && ignoreFileTracked
    && workspaceTracked !== null
    && workspaceTracked.length === 0;
  checks.push({
    id: 'workspace-isolated',
    status: workspaceIsolated ? 'passed' : 'unverifiable',
    message: workspaceTracked === null
      ? '无法核验 .workspace/ 的 Git 跟踪状态'
      : workspaceTracked.length > 0
        ? `.workspace/ 含已跟踪文件：${workspaceTracked.slice(0, 5).join('、')}`
        : !workspaceIgnored
          ? '.workspace/ 未被 Git 忽略'
          : !ignoreFileTracked
            ? '.gitignore 尚未纳入 Git，workspace 隔离规则不持久'
            : '.workspace/ 已由受 Git 管理的忽略规则隔离，且没有文件进入索引',
  });
  const exceptions = readQualityExceptions(opts.root, contract.exceptionsFile);
  if (exceptions.status !== 'valid') {
    checks.push({
      id: 'exceptions-invalid',
      status: 'unverifiable',
      message: exceptions.status === 'missing'
        ? `缺少 ${contract.exceptionsFile}`
        : exceptions.errors.join('；'),
    });
  } else {
    const expired = exceptions.value.exceptions.filter((item) =>
      Date.parse(item.expiresAt) <= now.getTime());
    const unresolvedDeliveries = exceptions.value.deliveries.filter((item) =>
      item.resolvedAt === undefined || Date.parse(item.resolvedAt) > now.getTime());
    const expiredDeliveries = unresolvedDeliveries.filter((item) =>
      Date.parse(item.expiresAt) <= now.getTime());
    const tracked = isTracked(opts.root, contract.exceptionsFile);
    let exceptionMessage: string;
    if (expired.length > 0) {
      exceptionMessage = `存在过期异常：${expired.map((item) => item.id).join('、')}`;
    } else if (unresolvedDeliveries.length > 0) {
      exceptionMessage = `${expiredDeliveries.length > 0 ? '存在过期' : '存在未关闭'}异常交付：${unresolvedDeliveries
        .map((item) => `${item.id}@${item.commitSha.slice(0, 12)}`)
        .join('、')}`;
    } else if (tracked) {
      exceptionMessage = `异常文件已纳入 Git，且没有过期记录：${contract.exceptionsFile}`;
    } else {
      exceptionMessage = `异常文件尚未纳入 Git：${contract.exceptionsFile}`;
    }
    checks.push({
      id: 'exceptions-current',
      status: expired.length === 0 && unresolvedDeliveries.length === 0 && tracked
        ? 'passed'
        : 'unverifiable',
      message: exceptionMessage,
    });
  }
  const remoteRepository = repositoryFromRemote(opts.root);
  checks.push({
    id: 'origin-identity',
    status: remoteRepository === contract.github.repository ? 'passed' : 'unverifiable',
    message: remoteRepository === null
      ? 'origin 不是可识别的 GitHub 仓库'
      : `origin=${remoteRepository}，contract=${contract.github.repository}`,
  });

  if (opts.remote) {
    if (!opts.token) {
      checks.push({
        id: 'github-token-missing',
        status: 'unverifiable',
        message: '完整远端核验需要 GitHub token',
      });
    } else {
      const client = opts.client ?? new GitHubClient(opts.token, contract.github.repository);
      try {
        const repository = await client.getRepository();
        checks.push({
          id: 'github-repository',
          status: repository.fullName === contract.github.repository
            && repository.defaultBranch === contract.github.defaultBranch
            ? 'passed'
            : 'unverifiable',
          message: `远端 ${repository.fullName} 默认分支 ${repository.defaultBranch}`,
        });
        const integrationId = await client.discoverGitHubActionsIntegrationId(
          contract.github.defaultBranch,
        );
        if (integrationId === null) {
          checks.push({
            id: 'github-actions-source',
            status: 'unverifiable',
            message: '默认分支没有可识别的 GitHub Actions Check Run',
          });
        } else {
          const collaborators = await client.countAdditionalPushCollaborators();
          const requiredApprovals = collaborators > 0 ? 1 : 0;
          const summaries = await client.listRulesets();
          const branchSummaries = summaries.filter((item) => item.name === QUALITY_RULESET_NAME);
          if (branchSummaries.length !== 1) {
            checks.push({
              id: 'branch-ruleset',
              status: 'unverifiable',
              message: `期望恰好一个 ${QUALITY_RULESET_NAME}，实际 ${branchSummaries.length}`,
            });
          } else {
            const branch = await client.getRuleset(branchSummaries[0].id);
            const errors = verifyQualityBranchRuleset(branch, {
              branch: contract.github.defaultBranch,
              requiredApprovals,
              requiredChecks: contract.github.requiredChecks.map((context) => ({
                context,
                integration_id: integrationId,
              })),
            });
            checks.push({
              id: 'branch-ruleset',
              status: errors.length === 0 ? 'passed' : 'unverifiable',
              message: errors.join('；') || `ruleset ${branch.id} 已回读核验`,
            });
          }
          if (contract.github.releaseRefs.length > 0) {
            const releaseSummaries = summaries.filter((item) =>
              item.name === QUALITY_RELEASE_RULESET_NAME);
            if (releaseSummaries.length !== 1) {
              checks.push({
                id: 'release-ruleset',
                status: 'unverifiable',
                message: `期望恰好一个 ${QUALITY_RELEASE_RULESET_NAME}，实际 ${releaseSummaries.length}`,
              });
            } else {
              const release = await client.getRuleset(releaseSummaries[0].id);
              const errors = verifyQualityReleaseRuleset(
                release,
                contract.github.releaseRefs,
              );
              checks.push({
                id: 'release-ruleset',
                status: errors.length === 0 ? 'passed' : 'unverifiable',
                message: errors.join('；') || `ruleset ${release.id} 已回读核验`,
              });
            }
          }
        }
      } catch (error) {
        checks.push({
          id: 'github-readback-failed',
          status: 'unverifiable',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else {
    checks.push({
      id: 'remote-not-checked',
      status: 'passed',
      message: '仅检查本地；未证明远端交付门禁就绪',
    });
  }
  let head: string | null = null;
  try {
    head = gitHead(opts.root);
  } catch {
    // Already represented through local Git checks.
  }
  const receipt: QualityReceipt = {
    version: 1,
    kind: 'doctor',
    round: nextReceiptRound(opts.workspace, 'doctor'),
    status: checks.every((check) => check.status === 'passed')
      ? 'passed'
      : 'unverifiable',
    at: now.toISOString(),
    repository: contract.github.repository,
    baseSha: head,
    headSha: head,
    contractSha256: contractRead.sha256,
    findings: [],
    exceptions: [],
    errors: errorsOf(checks),
    durationMs: Date.now() - started,
  };
  appendQualityReceipt(opts.workspace, receipt);
  return { receipt, checks };
}

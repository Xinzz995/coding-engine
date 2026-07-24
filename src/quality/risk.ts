import type { GitDiffBundle } from './git.js';
import type { DeepReviewPolicy } from './types.js';

export interface DeepReviewAssessment {
  required: boolean;
  reasons: string[];
  changedProductionLines: number;
  productionFiles: string[];
}
const RISK_TERMS = /\b(api|public interface|database|migration|transaction|atomic|lock|mutex|concurren|permission|authori[sz]|authenticat|secret|token|recover|rollback|release|publish|deploy)\b/i;
const POLICY_PREFIXES = ['.coding-x/', '.github/workflows/', 'AGENTS.md', 'docs/golden-principles.md'];
const NON_PRODUCTION_PREFIXES = ['docs/', 'test/', 'tests/', '__tests__/', '.github/'];
const NON_PRODUCTION_PARTS = [
  '.test.', '.spec.', '/test/', '/tests/', '__tests__/', '/fixtures/', '/fixture/',
];

function isProductionPath(path: string): boolean {
  if (NON_PRODUCTION_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (NON_PRODUCTION_PARTS.some((part) => path.includes(part))) return false;
  return !/\.(md|txt|rst|lock|json|ya?ml|toml)$/i.test(path);
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const normalized = prefix.replace(/\\/g, '/');
  if (normalized.endsWith('/')) return path.startsWith(normalized);
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function assessDeepReviewRisk(
  diff: GitDiffBundle,
  policy: DeepReviewPolicy,
  lineCountAtHead: (path: string) => number | null,
): DeepReviewAssessment {
  const reasons: string[] = [];
  const productionFiles = diff.changedFiles.filter(isProductionPath);
  const relevantStats = diff.numstat.filter((stat) => isProductionPath(stat.path));
  const unknownStats = relevantStats.filter((stat) => stat.added === null || stat.deleted === null);
  const changedProductionLines = relevantStats.reduce(
    (sum, stat) => sum + (stat.added ?? 0) + (stat.deleted ?? 0),
    0,
  );

  const policyChange = diff.changedFiles.find((path) =>
    POLICY_PREFIXES.some((prefix) => pathMatchesPrefix(path, prefix)));
  if (policyChange) reasons.push(`质量或交付政策发生变化：${policyChange}`);

  const highRisk = diff.changedFiles.find((path) =>
    policy.highRiskPaths.some((prefix) => pathMatchesPrefix(path, prefix)));
  if (highRisk) reasons.push(`命中高风险路径：${highRisk}`);

  if (RISK_TERMS.test(diff.diff)) reasons.push('diff 命中状态、安全、并发、恢复或发布风险词');

  if (unknownStats.length > 0) {
    reasons.push(`无法可靠统计 ${unknownStats[0].path} 的影响范围`);
  }

  if (changedProductionLines >= policy.changedProductionLines) {
    reasons.push(
      `生产代码改动 ${changedProductionLines} 行，达到阈值 ${policy.changedProductionLines}`,
    );
  }

  const topLevelModules = new Set(
    productionFiles.map((path) => path.includes('/') ? path.slice(0, path.indexOf('/')) : '.'),
  );
  if (topLevelModules.size >= 3) {
    reasons.push(`同时触及 ${topLevelModules.size} 个顶层生产模块`);
  }

  for (const path of productionFiles) {
    const count = lineCountAtHead(path);
    if (count === null) {
      reasons.push(`无法读取变更后文件规模：${path}`);
      break;
    }
    if (count >= policy.largeFileLines) {
      reasons.push(`${path} 为 ${count} 行，达到深度评审触发阈值 ${policy.largeFileLines}`);
      break;
    }
  }

  return {
    required: reasons.length > 0,
    reasons: [...new Set(reasons)],
    changedProductionLines,
    productionFiles,
  };
}

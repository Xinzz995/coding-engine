import type { QualityContract, QualityRiskCategory } from '../quality/contract.js';
import { digest, matchesAny } from './common.js';
import type { ReviewFileContent, ReviewPreflightContext } from './preflight.js';
import type { ReviewAxisResult, ReviewRiskAssessment } from './types.js';

const GENERATED_OR_VENDOR = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/__snapshots__/**',
  '**/*.snap',
];

const CATEGORY_PATTERNS: Partial<Record<QualityRiskCategory, RegExp>> = {
  policy: /(?:^|\/)(?:\.coding-x|\.github\/workflows|review|validator|gate|policy)(?:\/|\.|$)/i,
  'public-contract':
    /(?:^|\/)(?:api|public|cli|command|config|schema|plugin|manifest)(?:\/|\.|-|$)/i,
  state: /(?:state|store|cache|session|receipt)/i,
  migration: /(?:migrat|schema-version|upgrade)/i,
  recovery: /(?:recover|repair|rollback|restore|resume)/i,
  idempotency: /(?:idempoten|dedup|replay)/i,
  concurrency: /(?:concurr|parallel|race|mutex|semaphore)/i,
  timeout: /(?:timeout|deadline|abort)/i,
  retry: /(?:retry|backoff|attempt)/i,
  subprocess: /(?:child_process|spawn|execFile|process-tree|subprocess)/i,
  security: /(?:security|auth|permission|credential|secret|token|sandbox|untrusted)/i,
  privacy: /(?:privacy|pii|personal-data|redact)/i,
  'untrusted-input': /(?:untrusted|sanitize|escape|parse|deserialize|input)/i,
  release: /(?:publish|release|version|dist-tag|provenance|oidc)/i,
};

function moduleOf(contract: QualityContract, path: string): string | null {
  const candidates = contract.modules.filter(
    (module) => module.path === '.' || path === module.path || path.startsWith(`${module.path}/`),
  );
  return candidates.sort((a, b) => b.path.length - a.path.length)[0]?.id ?? null;
}

function handWrittenLargeFile(file: ReviewFileContent, generatedPaths: string[]): boolean {
  if (file.head === null) return false;
  if (matchesAny(file.path, [...generatedPaths, ...GENERATED_OR_VENDOR])) return false;
  return file.head.split('\n').length > 1000;
}

export function assessReviewRisk(context: ReviewPreflightContext): ReviewRiskAssessment {
  const categories = new Set<QualityRiskCategory>();
  const reasons: string[] = [];
  const contract = context.baseContract;
  const searchable = `${context.changedFiles.join('\n')}\n${context.diff}`;

  for (const rule of contract.risk.pathRules) {
    const hits = context.changedFiles.filter((path) => matchesAny(path, rule.paths));
    if (hits.length === 0) continue;
    rule.categories.forEach((category) => categories.add(category));
    reasons.push(`项目风险规则命中 ${hits.join('、')}`);
  }
  const highRisk = context.changedFiles.filter((path) =>
    matchesAny(path, contract.risk.highRiskPaths),
  );
  if (highRisk.length > 0) {
    categories.add('high-risk-path');
    reasons.push(`高风险目录命中 ${highRisk.join('、')}`);
  }
  for (const category of contract.risk.defaultCategories) {
    const pattern = CATEGORY_PATTERNS[category];
    if (pattern?.test(searchable)) {
      categories.add(category);
      reasons.push(`变化内容命中 ${category} 风险语义`);
    }
  }

  const changedModules = [
    ...new Set(
      context.changedFiles
        .map((path) => moduleOf(contract, path))
        .filter((value): value is string => value !== null),
    ),
  ].sort();
  if (changedModules.length >= 3) {
    categories.add('cross-module');
    reasons.push(`一次影响 ${changedModules.length} 个模块`);
  }
  const large = context.files.filter((file) => handWrittenLargeFile(file, contract.generatedPaths));
  if (large.length > 0) {
    categories.add('large-file');
    reasons.push(`手写变更文件超过 1000 行：${large.map((file) => file.path).join('、')}`);
  }
  if (/^- \[[xX]\] 我主动要求深度结构评审\s*$/m.test(context.pullRequest.body)) {
    categories.add('reviewer-request');
    reasons.push('PR 作者主动要求深度结构评审');
  }

  const stableCategories = [...categories].sort();
  const stableReasons = [...new Set(reasons)].sort();
  const value = {
    triggered: stableCategories.length > 0,
    categories: stableCategories,
    reasons: stableReasons,
    changedFiles: [...context.changedFiles],
    changedModules,
  };
  return { ...value, digest: digest(value) };
}

/**
 * Rebuild the final risk identity after the two primary Review axes have run.
 *
 * Deep Review is scheduled from the Spec/engineering outputs, so a request emitted by the deep
 * axis itself must not retroactively change the binding. Keeping this rule here lets the writer
 * and every later currentness check derive exactly the same digest from persisted axis results.
 */
export function applyReviewerRequestedDeepReview(
  risk: ReviewRiskAssessment,
  axes: readonly Pick<ReviewAxisResult, 'axis' | 'requestDeepReview'>[],
): ReviewRiskAssessment {
  const requested = axes.some(
    (axis) => (axis.axis === 'spec' || axis.axis === 'engineering') && axis.requestDeepReview,
  );
  if (!requested || risk.categories.includes('reviewer-request')) return risk;
  const value = {
    ...risk,
    triggered: true,
    categories: [...risk.categories, 'reviewer-request' as const].sort(),
    reasons: [...risk.reasons, 'Spec 或工程 Reviewer 主动升级为深度结构评审'].sort(),
  };
  return { ...value, digest: digest({ ...value, digest: undefined }) };
}

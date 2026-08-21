import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKind } from '../engine/agent.js';
import { digest } from './common.js';
import type { ReviewPreflightContext } from './preflight.js';
import { REVIEW_RULES_DIGEST, rulesForAxis } from './rules.js';
import {
  describeReviewTemporaryRetention,
  ReviewTemporaryDirectory,
  ReviewTemporaryDirectoryError,
  type ReviewTemporaryCleanupResult,
} from './temporary-directory.js';
import type { ReviewAxis, ReviewRiskAssessment } from './types.js';

export const DEFAULT_REVIEW_INPUT_LIMIT_BYTES = 512 * 1024;
export const LARGE_CONTEXT_REVIEW_INPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const REVIEW_SCHEMA_LIMIT_BYTES = 128 * 1024;
const REVIEW_MANIFEST_LIMIT_BYTES = 64 * 1024;

export interface ReviewPackage {
  root: string;
  projectRoot: string;
  inputPath: string;
  schemaPath: string;
  schema: string;
  manifestPath: string;
  input: string;
  inputBytes: number;
  digest: string;
  cleanup(): ReviewTemporaryCleanupResult;
  assertUnchanged(): void;
  prepareManagedUse(): void;
  beginManagedUse(): void;
  confirmManagedUseSettled(): void;
}

export interface ReviewMechanicalEvidence {
  status: 'passed';
  headSha: string;
  qualityContractDigest: string;
  validationEnvironmentDigest: string;
  scope: 'all-current-change-applicable-contract-checks';
  selectionMode: 'full' | 'scoped' | 'fallback-full';
  selectedCheckIds: string[];
  skippedCheckIds: string[];
  changeManifestDigest: string | null;
  selectionRequirement: {
    mode: 'scoped' | 'full';
    checkIds: string[];
  } | null;
  selectionReasons: Array<{
    checkId: string;
    sources: Array<'always' | 'path' | 'explicit' | 'full' | 'fallback-full'>;
  }>;
}

function assertMechanicalEvidence(
  context: ReviewPreflightContext,
  evidence: ReviewMechanicalEvidence,
): void {
  const selected = new Set(evidence.selectedCheckIds);
  const skipped = new Set(evidence.skippedCheckIds);
  const declaredCheckIds = (['test', 'build', 'static', 'security'] as const).flatMap(
    (category) => {
      const policy = context.baseContract.checks[category];
      return 'checks' in policy ? policy.checks.map((check) => check.id) : [];
    },
  );
  const observed = new Set([...evidence.selectedCheckIds, ...evidence.skippedCheckIds]);
  const requirement = evidence.selectionRequirement;
  const requiredCheckIds = new Set(requirement?.checkIds ?? []);
  const explicitCheckIds = new Set(
    evidence.selectionReasons
      .filter((reason) => reason.sources.includes('explicit'))
      .map((reason) => reason.checkId),
  );
  const selectionSources = new Set([
    'always',
    'path',
    'explicit',
    'full',
    'fallback-full',
  ]);
  if (
    evidence.status !== 'passed' ||
    evidence.headSha !== context.headSha ||
    evidence.qualityContractDigest !== context.baseContractDigest ||
    !/^sha256:[0-9a-f]{64}$/u.test(evidence.validationEnvironmentDigest) ||
    evidence.scope !== 'all-current-change-applicable-contract-checks' ||
    (evidence.selectionMode !== 'full' &&
      evidence.selectionMode !== 'scoped' &&
      evidence.selectionMode !== 'fallback-full') ||
    evidence.selectedCheckIds.length === 0 ||
    selected.size !== evidence.selectedCheckIds.length ||
    skipped.size !== evidence.skippedCheckIds.length ||
    evidence.selectedCheckIds.some((id) => skipped.has(id)) ||
    observed.size !== declaredCheckIds.length ||
    declaredCheckIds.some((id) => !observed.has(id)) ||
    ((evidence.selectionMode === 'scoped' || requirement !== null) !==
      (typeof evidence.changeManifestDigest === 'string' &&
        /^sha256:[0-9a-f]{64}$/u.test(evidence.changeManifestDigest))) ||
    (requirement !== null &&
      ((requirement.mode !== 'scoped' && requirement.mode !== 'full') ||
        new Set(requirement.checkIds).size !== requirement.checkIds.length ||
        requirement.checkIds.some((id) => !declaredCheckIds.includes(id)) ||
        (requirement.mode === 'full' && requirement.checkIds.length > 0))) ||
    (requirement === null
      ? explicitCheckIds.size > 0
      : requirement.mode === 'full'
        ? evidence.selectionReasons.some(
            (reason) =>
              !reason.sources.includes('full') || reason.sources.includes('explicit'),
          )
        : [...requiredCheckIds].some((id) => !selected.has(id)) ||
          evidence.selectionReasons.some(
            (reason) =>
              explicitCheckIds.has(reason.checkId) !== requiredCheckIds.has(reason.checkId),
          ) ||
          explicitCheckIds.size !== requiredCheckIds.size) ||
    evidence.selectionReasons.length !== evidence.selectedCheckIds.length ||
    evidence.selectionReasons.some(
      (reason, index) =>
        reason.checkId !== evidence.selectedCheckIds[index] ||
        reason.sources.length === 0 ||
        new Set(reason.sources).size !== reason.sources.length ||
        reason.sources.some((source) => !selectionSources.has(source)),
    )
  ) {
    throw new Error('前置机械检查证据未绑定当前 Review 上下文');
  }
}

function modelInputLimit(runner: AgentKind, model: string): number {
  if (/\b1m\b|gpt-5\.6|gpt-5\.5|claude-(?:opus|fable|sonnet)-5/i.test(model)) {
    return LARGE_CONTEXT_REVIEW_INPUT_LIMIT_BYTES;
  }
  // Unknown models are deliberately conservative. No truncation or sharding is allowed.
  return DEFAULT_REVIEW_INPUT_LIMIT_BYTES;
}

export function reviewOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'requestDeepReview', 'unverifiableReason', 'findings'],
    properties: {
      status: { type: 'string', enum: ['passed', 'failed', 'unverifiable'] },
      summary: { type: 'string', minLength: 1, maxLength: 4000 },
      requestDeepReview: { type: 'boolean' },
      unverifiableReason: { type: ['string', 'null'], minLength: 1, maxLength: 2000 },
      findings: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'severity', 'title', 'location', 'ruleSource', 'impact',
            'recommendation', 'requiresHumanDecision',
          ],
          properties: {
            severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'Info'] },
            title: { type: 'string', minLength: 1, maxLength: 300 },
            location: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'line', 'symbol'],
              properties: {
                path: { type: 'string', minLength: 1, maxLength: 1000 },
                line: { type: ['integer', 'null'], minimum: 1 },
                symbol: { type: ['string', 'null'], minLength: 1, maxLength: 500 },
              },
            },
            ruleSource: { type: 'string', minLength: 1, maxLength: 1000 },
            impact: { type: 'string', minLength: 1, maxLength: 2000 },
            recommendation: { type: 'string', minLength: 1, maxLength: 2000 },
            requiresHumanDecision: { type: 'boolean' },
          },
        },
      },
    },
  };
}

function axisInput(
  context: ReviewPreflightContext,
  risk: ReviewRiskAssessment,
  axis: ReviewAxis,
  mechanicalEvidence: ReviewMechanicalEvidence,
): Record<string, unknown> {
  const common = {
    schemaVersion: 1,
    axis,
    binding: {
      prNumber: context.pullRequest.number,
      targetBranch: context.pullRequest.baseBranch,
      baseSha: context.baseSha,
      headSha: context.headSha,
    },
    pullRequest: {
      title: context.pullRequest.title,
      body: context.pullRequest.body,
      sections: context.prSections,
    },
    changedFiles: context.changedFiles,
    files: context.files,
    diff: context.diff,
    history: context.history,
    verificationBoundary: {
      mechanicalChecks: mechanicalEvidence,
      allReviewAxes: {
        owner: 'engine',
        timing: 'evaluated-after-every-required-axis-finishes',
      },
      githubDelivery: {
        owner: 'engine',
        timing: 'evaluated-after-local-review-finishes',
      },
      reviewerScope: 'judge-repository-changes-not-process-completion',
    },
    qualityContract: context.baseContract,
    rules: rulesForAxis(axis),
    reviewRulesDigest: REVIEW_RULES_DIGEST,
  };
  if (axis === 'spec') return { ...common, specs: context.specs };
  if (axis === 'engineering') {
    return { ...common, engineeringStandards: context.engineeringStandards };
  }
  return { ...common, risk, engineeringStandards: context.engineeringStandards };
}

export function createReviewPackage(options: {
  context: ReviewPreflightContext;
  risk: ReviewRiskAssessment;
  axis: ReviewAxis;
  runner: AgentKind;
  model: string;
  mechanicalEvidence: ReviewMechanicalEvidence;
  /** @internal Deterministic initialization failure seams; production leaves this undefined. */
  initializationHooks?: {
    readonly afterInputWrite?: (root: string) => void;
    readonly beforePermissions?: (root: string) => void;
  };
}): ReviewPackage {
  assertMechanicalEvidence(options.context, options.mechanicalEvidence);
  const input = `${JSON.stringify(axisInput(
    options.context,
    options.risk,
    options.axis,
    options.mechanicalEvidence,
  ))}\n`;
  const inputBytes = Buffer.byteLength(input);
  const limit = modelInputLimit(options.runner, options.model);
  if (inputBytes > limit) {
    throw new Error(
      `完整 ${options.axis} Review 输入 ${inputBytes} bytes 超过当前模型保守上限 ${limit} bytes；` +
      '不会截断或自动分片，请拆分 PR',
    );
  }
  const temporary = ReviewTemporaryDirectory.create({
    prefix: 'coding-x-review-',
    projectRoot: options.context.root,
  });
  const root = temporary.root;
  const inputPath = join(root, 'review-input.json');
  const schemaPath = join(root, 'response-schema.json');
  const manifestPath = join(root, 'manifest.json');
  const schema = `${JSON.stringify(reviewOutputSchema())}\n`;
  const manifest = {
    schemaVersion: 1,
    axis: options.axis,
    runner: options.runner,
    model: options.model,
    inputBytes,
    inputDigest: digest(input),
    reviewRulesDigest: REVIEW_RULES_DIGEST,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    writeFileSync(inputPath, input, { encoding: 'utf8', mode: 0o400 });
    options.initializationHooks?.afterInputWrite?.(root);
    writeFileSync(schemaPath, schema, { encoding: 'utf8', mode: 0o400 });
    writeFileSync(manifestPath, manifestBytes, { encoding: 'utf8', mode: 0o400 });
    options.initializationHooks?.beforePermissions?.(root);
    chmodSync(root, 0o500);
    temporary.sealExactTree({
      files: [
        { path: 'review-input.json', bytes: Buffer.from(input), maximumBytes: limit },
        {
          path: 'response-schema.json',
          bytes: Buffer.from(schema),
          maximumBytes: REVIEW_SCHEMA_LIMIT_BYTES,
        },
        {
          path: 'manifest.json',
          bytes: Buffer.from(manifestBytes),
          maximumBytes: REVIEW_MANIFEST_LIMIT_BYTES,
        },
      ],
    });
  } catch (error) {
    const cleanup = temporary.cleanup();
    throw new ReviewTemporaryDirectoryError(
      `${error instanceof Error ? error.message : String(error)}；` +
        (cleanup.status !== 'removed'
          ? `初始化失败现场${describeReviewTemporaryRetention(cleanup)}：${cleanup.reason}`
          : '初始化失败现场已安全清理'),
    );
  }
  return {
    root,
    projectRoot: options.context.root,
    inputPath,
    schemaPath,
    schema,
    manifestPath,
    input,
    inputBytes,
    digest: digest(manifest),
    cleanup: () => temporary.cleanup(),
    assertUnchanged: () => temporary.assertUnchanged(),
    prepareManagedUse: () => temporary.prepareManagedUse(),
    beginManagedUse: () => temporary.beginManagedUse(),
    confirmManagedUseSettled: () => temporary.confirmManagedUseSettled(),
  };
}

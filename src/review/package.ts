import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentKind } from '../engine/agent.js';
import { digest, isOwnedTempDirectory } from './common.js';
import type { ReviewPreflightContext } from './preflight.js';
import { REVIEW_RULES_DIGEST, rulesForAxis } from './rules.js';
import type { ReviewAxis, ReviewRiskAssessment } from './types.js';

export const DEFAULT_REVIEW_INPUT_LIMIT_BYTES = 512 * 1024;
export const LARGE_CONTEXT_REVIEW_INPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export interface ReviewPackage {
  root: string;
  inputPath: string;
  schemaPath: string;
  manifestPath: string;
  input: string;
  inputBytes: number;
  digest: string;
  cleanup(): void;
  assertUnchanged(): void;
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
    required: ['status', 'summary', 'requestDeepReview', 'findings'],
    properties: {
      status: { type: 'string', enum: ['passed', 'failed', 'unverifiable'] },
      summary: { type: 'string', minLength: 1, maxLength: 4000 },
      requestDeepReview: { type: 'boolean' },
      unverifiableReason: { type: 'string', minLength: 1, maxLength: 2000 },
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
              required: ['path'],
              properties: {
                path: { type: 'string', minLength: 1, maxLength: 1000 },
                line: { type: 'integer', minimum: 1 },
                symbol: { type: 'string', minLength: 1, maxLength: 500 },
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

function fileSnapshot(root: string): Record<string, { bytes: number; digest: string }> {
  return Object.fromEntries(readdirSync(root).sort().map((name) => {
    const path = join(root, name);
    const data = readFileSync(path);
    return [name, { bytes: statSync(path).size, digest: digest(data.toString('base64')) }];
  }));
}

export function createReviewPackage(options: {
  context: ReviewPreflightContext;
  risk: ReviewRiskAssessment;
  axis: ReviewAxis;
  runner: AgentKind;
  model: string;
}): ReviewPackage {
  const input = `${JSON.stringify(axisInput(options.context, options.risk, options.axis))}\n`;
  const inputBytes = Buffer.byteLength(input);
  const limit = modelInputLimit(options.runner, options.model);
  if (inputBytes > limit) {
    throw new Error(
      `完整 ${options.axis} Review 输入 ${inputBytes} bytes 超过当前模型保守上限 ${limit} bytes；` +
      '不会截断或自动分片，请拆分 PR',
    );
  }
  const root = mkdtempSync(join(tmpdir(), 'coding-x-review-'));
  const inputPath = join(root, 'review-input.json');
  const schemaPath = join(root, 'response-schema.json');
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(inputPath, input, { encoding: 'utf8', mode: 0o444 });
  writeFileSync(schemaPath, `${JSON.stringify(reviewOutputSchema())}\n`, { encoding: 'utf8', mode: 0o444 });
  const manifest = {
    schemaVersion: 1,
    axis: options.axis,
    runner: options.runner,
    model: options.model,
    inputBytes,
    inputDigest: digest(input),
    reviewRulesDigest: REVIEW_RULES_DIGEST,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o444 });
  chmodSync(root, 0o555);
  const before = fileSnapshot(root);
  const cleanup = () => {
    const target = resolve(root);
    if (!isOwnedTempDirectory(target, 'coding-x-review-')) {
      throw new Error(`拒绝清理非审查临时目录：${target}`);
    }
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    inputPath,
    schemaPath,
    manifestPath,
    input,
    inputBytes,
    digest: digest(manifest),
    cleanup,
    assertUnchanged: () => {
      const after = fileSnapshot(root);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error('Reviewer 改写了只读审查包或产生了额外文件');
      }
    },
  };
}

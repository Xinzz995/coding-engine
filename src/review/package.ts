import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  opendirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { AgentKind } from '../engine/agent.js';
import { readSafeControlFileSync } from '../engine/safe-control-file.js';
import { digest, isOwnedTempDirectory } from './common.js';
import type { ReviewPreflightContext } from './preflight.js';
import { REVIEW_RULES_DIGEST, rulesForAxis } from './rules.js';
import type { ReviewAxis, ReviewRiskAssessment } from './types.js';

export const DEFAULT_REVIEW_INPUT_LIMIT_BYTES = 512 * 1024;
export const LARGE_CONTEXT_REVIEW_INPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const REVIEW_PACKAGE_ENTRY_LIMIT = 3;
const REVIEW_PACKAGE_FILE_MAX_BYTES = LARGE_CONTEXT_REVIEW_INPUT_LIMIT_BYTES;
const REVIEW_PACKAGE_TOTAL_MAX_BYTES = 3 * 1024 * 1024;

interface PathIdentity {
  device: string;
  inode: string;
  mode: string;
  modifiedNs: string;
  changedNs: string;
}

type ReviewPackageSnapshot = Record<
  string,
  { bytes: number; digest: string; identity: PathIdentity }
>;

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

export interface ReviewMechanicalEvidence {
  status: 'passed';
  headSha: string;
  qualityContractDigest: string;
  scope: 'all-current-platform-applicable-contract-checks';
}

function assertMechanicalEvidence(
  context: ReviewPreflightContext,
  evidence: ReviewMechanicalEvidence,
): void {
  if (
    evidence.status !== 'passed' ||
    evidence.headSha !== context.headSha ||
    evidence.qualityContractDigest !== context.baseContractDigest ||
    evidence.scope !== 'all-current-platform-applicable-contract-checks'
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

function pathIdentity(stats: BigIntStats): PathIdentity {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    mode: stats.mode.toString(),
    modifiedNs: stats.mtimeNs.toString(),
    changedNs: stats.ctimeNs.toString(),
  };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof PathIdentity] === right[key as keyof PathIdentity],
  );
}

function packageRootIdentity(root: string): PathIdentity {
  const stats = lstatSync(root, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('审查包根目录已被替换或不再是普通目录');
  }
  return pathIdentity(stats);
}

function sameDirectoryObject(left: PathIdentity, right: PathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
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
            'severity',
            'title',
            'location',
            'ruleSource',
            'impact',
            'recommendation',
            'requiresHumanDecision',
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

function packageFileNames(root: string): string[] {
  const directory = opendirSync(root);
  const names: string[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > REVIEW_PACKAGE_ENTRY_LIMIT) {
        throw new Error(`Reviewer 在审查包中产生了超过 ${REVIEW_PACKAGE_ENTRY_LIMIT} 个目录项`);
      }
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function fileSnapshot(
  root: string,
  expectedNames: string[],
  expectedRoot: PathIdentity,
  previous?: ReviewPackageSnapshot,
): ReviewPackageSnapshot {
  const rootBefore = packageRootIdentity(root);
  if (!sameDirectoryObject(rootBefore, expectedRoot)) {
    throw new Error('Reviewer 替换了审查包根目录或修改了其权限');
  }
  const names = packageFileNames(root);
  const normalizedExpected = [...expectedNames].sort();
  if (JSON.stringify(names) !== JSON.stringify(normalizedExpected)) {
    throw new Error('Reviewer 改写了只读审查包或产生了额外文件');
  }

  let totalBytes = 0;
  const snapshot: ReviewPackageSnapshot = {};
  for (const name of names) {
    const path = join(root, name);
    const identityBefore = pathIdentity(lstatSync(path, { bigint: true }));
    const expectedBytes = previous?.[name]?.bytes;
    const maxBytes = expectedBytes ?? REVIEW_PACKAGE_FILE_MAX_BYTES;
    const data = readSafeControlFileSync(path, { maxBytes });
    if (data === null) throw new Error(`审查包文件在读取前消失：${name}`);
    const identityAfter = pathIdentity(lstatSync(path, { bigint: true }));
    if (!sameIdentity(identityBefore, identityAfter)) {
      throw new Error(`审查包文件在复核期间被替换：${name}`);
    }
    totalBytes += data.length;
    if (totalBytes > REVIEW_PACKAGE_TOTAL_MAX_BYTES) {
      throw new Error(`审查包总量超过 ${REVIEW_PACKAGE_TOTAL_MAX_BYTES} bytes`);
    }
    snapshot[name] = {
      bytes: data.length,
      digest: digest(data.toString('base64')),
      identity: identityAfter,
    };
  }

  if (JSON.stringify(packageFileNames(root)) !== JSON.stringify(normalizedExpected)) {
    throw new Error('Reviewer 在复核期间改写了审查包目录');
  }
  const rootAfter = packageRootIdentity(root);
  if (!sameDirectoryObject(rootAfter, expectedRoot)) {
    throw new Error('Reviewer 在复核期间替换了审查包根目录或修改了其权限');
  }
  return snapshot;
}

export function createReviewPackage(options: {
  context: ReviewPreflightContext;
  risk: ReviewRiskAssessment;
  axis: ReviewAxis;
  runner: AgentKind;
  model: string;
  mechanicalEvidence: ReviewMechanicalEvidence;
}): ReviewPackage {
  assertMechanicalEvidence(options.context, options.mechanicalEvidence);
  const input = `${JSON.stringify(
    axisInput(options.context, options.risk, options.axis, options.mechanicalEvidence),
  )}\n`;
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
  writeFileSync(inputPath, input, { encoding: 'utf8', mode: 0o400 });
  writeFileSync(schemaPath, `${JSON.stringify(reviewOutputSchema())}\n`, {
    encoding: 'utf8',
    mode: 0o400,
  });
  const manifest = {
    schemaVersion: 1,
    axis: options.axis,
    runner: options.runner,
    model: options.model,
    inputBytes,
    inputDigest: digest(input),
    reviewRulesDigest: REVIEW_RULES_DIGEST,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o400,
  });
  chmodSync(root, 0o500);
  const rootIdentity = packageRootIdentity(root);
  const expectedNames = [inputPath, schemaPath, manifestPath].map((path) => basename(path));
  const before = fileSnapshot(root, expectedNames, rootIdentity);
  const cleanup = () => {
    const target = resolve(root);
    if (!isOwnedTempDirectory(target, 'coding-x-review-')) {
      throw new Error(`拒绝清理非审查临时目录：${target}`);
    }
    const current = lstatSync(root, { bigint: true });
    const currentIdentity = pathIdentity(current);
    if (current.isSymbolicLink()) {
      unlinkSync(root);
      throw new Error('审查包根目录已被软链替换；已移除替代软链，但原临时目录可能残留');
    }
    if (!current.isDirectory() || !sameDirectoryObject(currentIdentity, rootIdentity)) {
      throw new Error('审查包根目录身份发生变化，拒绝跟随或清理未知目标');
    }
    chmodSync(root, 0o700);
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
      const after = fileSnapshot(root, expectedNames, rootIdentity, before);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error('Reviewer 改写了只读审查包或产生了额外文件');
      }
    },
  };
}

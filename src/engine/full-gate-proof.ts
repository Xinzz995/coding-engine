import { createHash } from 'node:crypto';
import {
  ENGINE_QUALITY_GATE_EVIDENCE_SCHEMA_VERSION,
  isGitHead,
  isSha256Digest,
  type EngineQualityGateCheckEvidence,
  type EngineQualityGateEvidence,
} from '../contracts/validation-contract.js';
import {
  digestQualityContract,
  type QualityContract,
  type QualityPlatform,
} from '../quality/contract.js';
import {
  CLEAN_VALIDATION_CHECKOUT_VERSION,
  normalizeValidationAdditionalRefs,
  normalizeValidationReferenceAliases,
  type ValidationGitReferenceAlias,
} from '../quality/validation-environment.js';
import type { ContractGateResult } from './gate.js';

export const FULL_GATE_PROOF_SCHEMA_VERSION = 1 as const;
export const FULL_GATE_INPUT_DOMAIN = 'coding-x-full-gate-input-v1' as const;

export interface FullGateInput {
  readonly contract: QualityContract;
  readonly headSha: string;
  readonly defaultBranchGitHead: string;
  readonly additionalRefs?: readonly string[];
  readonly referenceAliases?: readonly ValidationGitReferenceAlias[];
  readonly platform?: QualityPlatform;
}

export interface FullGateProof {
  readonly schemaVersion: typeof FULL_GATE_PROOF_SCHEMA_VERSION;
  readonly status: 'passed';
  readonly inputDigest: string;
  readonly headSha: string;
  readonly defaultBranchGitHead: string;
  readonly qualityContractDigest: string;
  readonly platform: QualityPlatform;
  readonly checks: readonly EngineQualityGateCheckEvidence[];
  readonly result: ContractGateResult & { readonly ok: true; readonly failure: null };
}

const QUALITY_CATEGORIES = ['test', 'build', 'static', 'security'] as const;

function contractCheckEvidence(
  contract: QualityContract,
  platform: QualityPlatform,
): EngineQualityGateCheckEvidence[] {
  const checks: EngineQualityGateCheckEvidence[] = [];
  for (const category of QUALITY_CATEGORIES) {
    const policy = contract.checks[category];
    if (!('checks' in policy)) continue;
    for (const check of policy.checks) {
      if (!check.command.platforms.includes(platform)) continue;
      checks.push({ category, id: check.id, module: check.module });
    }
  }
  return checks;
}

function skippedContractCheckIds(contract: QualityContract, platform: QualityPlatform): string[] {
  const skipped: string[] = [];
  for (const category of QUALITY_CATEGORIES) {
    const policy = contract.checks[category];
    if (!('checks' in policy)) continue;
    for (const check of policy.checks) {
      if (!check.command.platforms.includes(platform)) skipped.push(check.id);
    }
  }
  return skipped;
}

function currentPlatform(): QualityPlatform {
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  throw new Error(`当前系统 ${process.platform} 不支持全量检查证明`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function fullGateInputDigest(input: FullGateInput): string {
  if (!isGitHead(input.headSha) || !isGitHead(input.defaultBranchGitHead)) {
    throw new Error('全量检查输入必须绑定完整 head 与默认分支 commit');
  }
  const aliases = normalizeValidationReferenceAliases(input.referenceAliases);
  const data = canonicalize({
    domain: FULL_GATE_INPUT_DOMAIN,
    cleanCheckoutVersion: CLEAN_VALIDATION_CHECKOUT_VERSION,
    headSha: input.headSha,
    defaultBranchGitHead: input.defaultBranchGitHead,
    qualityContractDigest: digestQualityContract(input.contract),
    platform: input.platform ?? currentPlatform(),
    additionalRefs: normalizeValidationAdditionalRefs(input.headSha, [
      ...(input.additionalRefs ?? []),
      ...aliases.map((alias) => alias.target),
    ]),
    referenceAliases: aliases,
  });
  return `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`;
}

export function createFullGateProof(
  input: FullGateInput,
  result: ContractGateResult,
): FullGateProof {
  if (!result.ok || result.failure !== null || result.ran !== result.total) {
    throw new Error('只有完整通过的全量契约检查才能生成复用证明');
  }
  const platform = input.platform ?? currentPlatform();
  const checks = contractCheckEvidence(input.contract, platform);
  const skipped = skippedContractCheckIds(input.contract, platform);
  if (
    checks.length !== result.total ||
    skipped.length !== result.skipped.length ||
    skipped.some((id, index) => id !== result.skipped[index])
  ) {
    throw new Error('全量检查结果与冻结质量契约的实际检查范围不一致');
  }
  return {
    schemaVersion: FULL_GATE_PROOF_SCHEMA_VERSION,
    status: 'passed',
    inputDigest: fullGateInputDigest(input),
    headSha: input.headSha,
    defaultBranchGitHead: input.defaultBranchGitHead,
    qualityContractDigest: digestQualityContract(input.contract),
    platform,
    checks,
    result: {
      ok: true,
      failure: null,
      total: result.total,
      ran: result.ran,
      ms: result.ms,
      skipped: [...result.skipped],
    },
  };
}

/** 将同进程完整门禁证明收缩为 Validator 可引用、不可扩大的请求证据。 */
export function engineQualityGateEvidence(proof: FullGateProof): EngineQualityGateEvidence {
  return {
    schemaVersion: ENGINE_QUALITY_GATE_EVIDENCE_SCHEMA_VERSION,
    source: 'engine-full-gate',
    status: 'passed',
    inputDigest: proof.inputDigest,
    gitHead: proof.headSha,
    defaultBranchGitHead: proof.defaultBranchGitHead,
    qualityContractDigest: proof.qualityContractDigest,
    platform: proof.platform,
    total: proof.result.total,
    ran: proof.result.ran,
    checks: proof.checks.map((check) => ({ ...check })),
    skippedCheckIds: [...proof.result.skipped],
  };
}

export function reusableFullGateResult(
  proof: FullGateProof | undefined,
  expected: FullGateInput,
): FullGateProof['result'] | null {
  const expectedPlatform = expected.platform ?? currentPlatform();
  const expectedChecks = contractCheckEvidence(expected.contract, expectedPlatform);
  const expectedSkipped = skippedContractCheckIds(expected.contract, expectedPlatform);
  if (
    proof === undefined ||
    proof.schemaVersion !== FULL_GATE_PROOF_SCHEMA_VERSION ||
    proof.status !== 'passed' ||
    !isSha256Digest(proof.inputDigest) ||
    !isSha256Digest(proof.qualityContractDigest) ||
    proof.headSha !== expected.headSha ||
    proof.defaultBranchGitHead !== expected.defaultBranchGitHead ||
    proof.qualityContractDigest !== digestQualityContract(expected.contract) ||
    proof.platform !== expectedPlatform ||
    proof.inputDigest !== fullGateInputDigest(expected) ||
    proof.checks.length !== expectedChecks.length ||
    proof.checks.some(
      (check, index) =>
        check.category !== expectedChecks[index]?.category ||
        check.id !== expectedChecks[index]?.id ||
        check.module !== expectedChecks[index]?.module,
    ) ||
    proof.result.skipped.length !== expectedSkipped.length ||
    proof.result.skipped.some((id, index) => id !== expectedSkipped[index]) ||
    !proof.result.ok ||
    proof.result.failure !== null ||
    proof.result.ran !== proof.result.total
  ) {
    return null;
  }
  return {
    ...proof.result,
    skipped: [...proof.result.skipped],
  };
}

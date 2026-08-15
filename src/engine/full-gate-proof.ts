import { createHash } from 'node:crypto';
import { isGitHead, isSha256Digest } from '../contracts/validation-contract.js';
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
  readonly result: ContractGateResult & { readonly ok: true; readonly failure: null };
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
  return {
    schemaVersion: FULL_GATE_PROOF_SCHEMA_VERSION,
    status: 'passed',
    inputDigest: fullGateInputDigest(input),
    headSha: input.headSha,
    defaultBranchGitHead: input.defaultBranchGitHead,
    qualityContractDigest: digestQualityContract(input.contract),
    platform: input.platform ?? currentPlatform(),
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

export function reusableFullGateResult(
  proof: FullGateProof | undefined,
  expected: FullGateInput,
): FullGateProof['result'] | null {
  if (
    proof === undefined ||
    proof.schemaVersion !== FULL_GATE_PROOF_SCHEMA_VERSION ||
    proof.status !== 'passed' ||
    !isSha256Digest(proof.inputDigest) ||
    !isSha256Digest(proof.qualityContractDigest) ||
    proof.headSha !== expected.headSha ||
    proof.defaultBranchGitHead !== expected.defaultBranchGitHead ||
    proof.qualityContractDigest !== digestQualityContract(expected.contract) ||
    proof.platform !== (expected.platform ?? currentPlatform()) ||
    proof.inputDigest !== fullGateInputDigest(expected) ||
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

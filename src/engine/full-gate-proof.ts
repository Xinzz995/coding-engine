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

export const FULL_GATE_PROOF_SCHEMA_VERSION = 2 as const;
export const FULL_GATE_INPUT_DOMAIN = 'coding-x-full-gate-input-v2' as const;

export interface FullGateChangeScope {
  readonly baseGitHead: string;
  readonly manifestDigest: string;
  readonly selectedCheckIds: readonly string[];
}

export interface FullGateInput {
  readonly contract: QualityContract;
  readonly headSha: string;
  readonly defaultBranchGitHead: string;
  readonly additionalRefs?: readonly string[];
  readonly referenceAliases?: readonly ValidationGitReferenceAlias[];
  readonly platform?: QualityPlatform;
  /** 只有按变化范围缩小检查集合时存在；完整/保守全量结果不依赖变化范围。 */
  readonly changeScope?: FullGateChangeScope;
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
  readonly changeScope: FullGateChangeScope | null;
  readonly selectionMode: 'full' | 'scoped' | 'fallback-full';
  readonly result: ContractGateResult & { readonly ok: true; readonly failure: null };
}

const QUALITY_CATEGORIES = ['test', 'build', 'static', 'security'] as const;

function contractCheckEvidence(
  contract: QualityContract,
  platform: QualityPlatform,
  selectedCheckIds?: readonly string[],
): EngineQualityGateCheckEvidence[] {
  const selected = selectedCheckIds === undefined ? null : new Set(selectedCheckIds);
  const checks: EngineQualityGateCheckEvidence[] = [];
  for (const category of QUALITY_CATEGORIES) {
    const policy = contract.checks[category];
    if (!('checks' in policy)) continue;
    for (const check of policy.checks) {
      if (!check.command.platforms.includes(platform)) continue;
      if (selected !== null && !selected.has(check.id)) continue;
      checks.push({ category, id: check.id, module: check.module });
    }
  }
  return checks;
}

function skippedContractCheckIds(
  contract: QualityContract,
  platform: QualityPlatform,
  selectedCheckIds?: readonly string[],
): string[] {
  const selected = selectedCheckIds === undefined ? null : new Set(selectedCheckIds);
  const skippedByPlatform: string[] = [];
  const skippedBySelection: string[] = [];
  for (const category of QUALITY_CATEGORIES) {
    const policy = contract.checks[category];
    if (!('checks' in policy)) continue;
    for (const check of policy.checks) {
      if (!check.command.platforms.includes(platform)) skippedByPlatform.push(check.id);
      else if (selected !== null && !selected.has(check.id)) skippedBySelection.push(check.id);
    }
  }
  return [...skippedByPlatform, ...skippedBySelection];
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
  if (
    input.changeScope !== undefined &&
    (!isGitHead(input.changeScope.baseGitHead) ||
      !isSha256Digest(input.changeScope.manifestDigest) ||
      input.changeScope.selectedCheckIds.length === 0 ||
      new Set(input.changeScope.selectedCheckIds).size !== input.changeScope.selectedCheckIds.length)
  ) {
    throw new Error('按范围检查输入必须绑定 Story 起点、变化摘要和非空唯一检查集合');
  }
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
    changeScope:
      input.changeScope === undefined
        ? null
        : {
            baseGitHead: input.changeScope.baseGitHead,
            manifestDigest: input.changeScope.manifestDigest,
            selectedCheckIds: [...input.changeScope.selectedCheckIds],
          },
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
  const selectionMode = result.selectionMode ?? 'full';
  const selectedCheckIds =
    result.selectedCheckIds ?? contractCheckEvidence(input.contract, platform).map((check) => check.id);
  const changeScope = selectionMode === 'scoped' ? input.changeScope : undefined;
  if (
    (selectionMode !== 'scoped' && input.changeScope !== undefined) ||
    (selectionMode === 'scoped' &&
      (changeScope === undefined ||
        selectedCheckIds.length !== changeScope.selectedCheckIds.length ||
        selectedCheckIds.some((id, index) => id !== changeScope.selectedCheckIds[index])))
  ) {
    throw new Error('按范围检查结果必须绑定同一变化摘要与实际检查集合');
  }
  const checks = contractCheckEvidence(input.contract, platform, selectedCheckIds);
  const skipped = skippedContractCheckIds(input.contract, platform, selectedCheckIds);
  if (
    selectedCheckIds.length !== checks.length ||
    selectedCheckIds.some((id, index) => id !== checks[index]?.id) ||
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
    changeScope:
      changeScope === undefined
        ? null
        : {
            baseGitHead: changeScope.baseGitHead,
            manifestDigest: changeScope.manifestDigest,
            selectedCheckIds: [...changeScope.selectedCheckIds],
          },
    selectionMode,
    result: {
      ok: true,
      failure: null,
      total: result.total,
      ran: result.ran,
      ms: result.ms,
      skipped: [...result.skipped],
      ...(result.skippedByPath === undefined
        ? {}
        : { skippedByPath: [...result.skippedByPath] }),
      ...(result.selectionMode === undefined ? {} : { selectionMode: result.selectionMode }),
      ...(result.selectedCheckIds === undefined
        ? {}
        : { selectedCheckIds: [...result.selectedCheckIds] }),
    },
  };
}

/** 将同进程完整门禁证明收缩为 Validator 可引用、不可扩大的请求证据。 */
export function engineQualityGateEvidence(proof: FullGateProof): EngineQualityGateEvidence {
  return {
    schemaVersion: ENGINE_QUALITY_GATE_EVIDENCE_SCHEMA_VERSION,
    source: 'engine-effective-gate',
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
    changeBaseGitHead: proof.changeScope?.baseGitHead ?? null,
    changeManifestDigest: proof.changeScope?.manifestDigest ?? null,
    selectionMode: proof.selectionMode,
  };
}

export function reusableFullGateResult(
  proof: FullGateProof | undefined,
  expected: FullGateInput,
  expectedChangeBaseGitHead?: string,
): FullGateProof['result'] | null {
  const expectedPlatform = expected.platform ?? currentPlatform();
  const selectedCheckIds = proof?.changeScope?.selectedCheckIds;
  const expectedChecks = contractCheckEvidence(
    expected.contract,
    expectedPlatform,
    selectedCheckIds,
  );
  const expectedSkipped = skippedContractCheckIds(
    expected.contract,
    expectedPlatform,
    selectedCheckIds,
  );
  const expectedWithScope: FullGateInput = {
    ...expected,
    ...(proof?.changeScope ? { changeScope: proof.changeScope } : {}),
  };
  let expectedInputDigest: string;
  try {
    expectedInputDigest = fullGateInputDigest(expectedWithScope);
  } catch {
    return null;
  }
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
    (proof.selectionMode === 'scoped') !== (proof.changeScope !== null) ||
    (proof.changeScope !== null && proof.changeScope.baseGitHead !== expectedChangeBaseGitHead) ||
    proof.inputDigest !== expectedInputDigest ||
    (proof.changeScope !== null &&
      (proof.changeScope.selectedCheckIds.length !== expectedChecks.length ||
        proof.changeScope.selectedCheckIds.some(
          (id, index) => id !== expectedChecks[index]?.id,
        ))) ||
    proof.checks.length !== expectedChecks.length ||
    proof.checks.some(
      (check, index) =>
        check.category !== expectedChecks[index]?.category ||
        check.id !== expectedChecks[index]?.id ||
        check.module !== expectedChecks[index]?.module,
    ) ||
    proof.result.skipped.length !== expectedSkipped.length ||
    proof.result.skipped.some((id, index) => id !== expectedSkipped[index]) ||
    (proof.result.selectionMode ?? 'full') !== proof.selectionMode ||
    proof.result.total !== expectedChecks.length ||
    (proof.changeScope !== null &&
      (proof.result.selectedCheckIds?.length !== expectedChecks.length ||
        proof.result.selectedCheckIds.some((id, index) => id !== expectedChecks[index]?.id))) ||
    !proof.result.ok ||
    proof.result.failure !== null ||
    proof.result.ran !== proof.result.total
  ) {
    return null;
  }
  return {
    ...proof.result,
    skipped: [...proof.result.skipped],
    ...(proof.result.skippedByPath === undefined
      ? {}
      : { skippedByPath: [...proof.result.skippedByPath] }),
    ...(proof.result.selectedCheckIds === undefined
      ? {}
      : { selectedCheckIds: [...proof.result.selectedCheckIds] }),
  };
}

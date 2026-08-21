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
import type {
  ContractGateResult,
  QualityCheckSelectionReason,
  QualityCheckSelectionRequirement,
} from './gate.js';

export const FULL_GATE_PROOF_SCHEMA_VERSION = 3 as const;
export const FULL_GATE_INPUT_DOMAIN = 'coding-x-full-gate-input-v3' as const;

export interface FullGateChangeScope {
  readonly baseGitHead: string;
  readonly manifestDigest: string;
  readonly selectedCheckIds: readonly string[];
  readonly selectionReasons?: readonly QualityCheckSelectionReason[];
}

export interface FullGateInput {
  readonly contract: QualityContract;
  readonly headSha: string;
  readonly defaultBranchGitHead: string;
  readonly additionalRefs?: readonly string[];
  readonly referenceAliases?: readonly ValidationGitReferenceAlias[];
  readonly platform?: QualityPlatform;
  /** ready Issue 的显式本地责任；纳入输入摘要以防同一 id 集合按不同原因复用。 */
  readonly selectionRequirement?: QualityCheckSelectionRequirement;
  /** 普通 scoped 或 ready Issue 显式责任存在时绑定完整 Story 变化范围。 */
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
  readonly selectionRequirement: QualityCheckSelectionRequirement | null;
  readonly selectionReasons: readonly QualityCheckSelectionReason[];
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

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedRequirement(
  requirement: QualityCheckSelectionRequirement | undefined,
): QualityCheckSelectionRequirement | null {
  if (!requirement) return null;
  if (
    (requirement.mode !== 'scoped' && requirement.mode !== 'full') ||
    new Set(requirement.checkIds).size !== requirement.checkIds.length ||
    requirement.checkIds.some((id) => typeof id !== 'string' || id.length === 0) ||
    (requirement.mode === 'full' && requirement.checkIds.length > 0)
  ) {
    throw new Error('检查选择要求必须使用 scoped/full 与唯一稳定 id');
  }
  return { mode: requirement.mode, checkIds: [...requirement.checkIds] };
}

const SELECTION_SOURCES = new Set([
  'always',
  'path',
  'explicit',
  'full',
  'fallback-full',
] as const);

function normalizedReasons(
  reasons: readonly QualityCheckSelectionReason[] | undefined,
  selectedCheckIds: readonly string[],
): QualityCheckSelectionReason[] {
  if (reasons === undefined) return [];
  if (
    reasons.length !== selectedCheckIds.length ||
    reasons.some(
      (reason, index) =>
        reason.checkId !== selectedCheckIds[index] ||
        reason.sources.length === 0 ||
        new Set(reason.sources).size !== reason.sources.length ||
        reason.sources.some((source) => !SELECTION_SOURCES.has(source)),
    )
  ) {
    throw new Error('检查选择原因必须按实际检查顺序逐项绑定唯一非空来源');
  }
  return reasons.map((reason) => ({ checkId: reason.checkId, sources: [...reason.sources] }));
}

function sameReasons(
  left: readonly QualityCheckSelectionReason[],
  right: readonly QualityCheckSelectionReason[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (reason, index) =>
        reason.checkId === right[index]?.checkId &&
        sameStringArray(reason.sources, right[index]?.sources ?? []),
    )
  );
}

function requirementMatchesSelection(
  requirement: QualityCheckSelectionRequirement | null,
  selectedCheckIds: readonly string[],
  reasons: readonly QualityCheckSelectionReason[],
  allApplicableCheckIds: readonly string[],
): boolean {
  const selected = new Set(selectedCheckIds);
  const required = new Set(requirement?.checkIds ?? []);
  const explicit = new Set(
    reasons.filter((reason) => reason.sources.includes('explicit')).map((reason) => reason.checkId),
  );
  if (requirement === null) return explicit.size === 0;
  if (requirement.mode === 'full') {
    return (
      requirement.checkIds.length === 0 &&
      sameStringArray(selectedCheckIds, allApplicableCheckIds) &&
      reasons.every(
        (reason) => reason.sources.includes('full') && !reason.sources.includes('explicit'),
      )
    );
  }
  return (
    [...required].every((id) => selected.has(id)) &&
    reasons.every((reason) => explicit.has(reason.checkId) === required.has(reason.checkId)) &&
    explicit.size === required.size
  );
}

export function fullGateInputDigest(input: FullGateInput): string {
  if (!isGitHead(input.headSha) || !isGitHead(input.defaultBranchGitHead)) {
    throw new Error('全量检查输入必须绑定完整 head 与默认分支 commit');
  }
  const aliases = normalizeValidationReferenceAliases(input.referenceAliases);
  const requirement = normalizedRequirement(input.selectionRequirement);
  if (
    input.changeScope !== undefined &&
    (!isGitHead(input.changeScope.baseGitHead) ||
      !isSha256Digest(input.changeScope.manifestDigest) ||
      input.changeScope.selectedCheckIds.length === 0 ||
      new Set(input.changeScope.selectedCheckIds).size !== input.changeScope.selectedCheckIds.length)
  ) {
    throw new Error('按范围检查输入必须绑定 Story 起点、变化摘要和非空唯一检查集合');
  }
  const scopeReasons =
    input.changeScope === undefined
      ? []
      : normalizedReasons(input.changeScope.selectionReasons, input.changeScope.selectedCheckIds);
  if (requirement !== null && input.changeScope !== undefined && scopeReasons.length === 0) {
    throw new Error('ready Issue 检查证明必须绑定逐项选择原因');
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
    selectionRequirement: requirement,
    changeScope:
      input.changeScope === undefined
        ? null
        : {
            baseGitHead: input.changeScope.baseGitHead,
            manifestDigest: input.changeScope.manifestDigest,
            selectedCheckIds: [...input.changeScope.selectedCheckIds],
            selectionReasons: scopeReasons,
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
  const requirement = normalizedRequirement(input.selectionRequirement);
  const resultRequirement = normalizedRequirement(result.selectionRequirement);
  if (
    (requirement === null) !== (resultRequirement === null) ||
    (requirement !== null &&
      resultRequirement !== null &&
      (requirement.mode !== resultRequirement.mode ||
        !sameStringArray(requirement.checkIds, resultRequirement.checkIds)))
  ) {
    throw new Error('检查结果与 ready Issue 的显式选择要求不一致');
  }
  const changeScope = input.changeScope;
  if (
    (selectionMode !== 'scoped' && input.changeScope !== undefined && requirement === null) ||
    (selectionMode === 'scoped' &&
      (changeScope === undefined ||
        selectedCheckIds.length !== changeScope.selectedCheckIds.length ||
        selectedCheckIds.some((id, index) => id !== changeScope.selectedCheckIds[index])))
  ) {
    throw new Error('按范围检查结果必须绑定同一变化摘要与实际检查集合');
  }
  const suppliedReasons = normalizedReasons(result.selectionReasons, selectedCheckIds);
  const selectionReasons =
    suppliedReasons.length > 0
      ? suppliedReasons
      : selectedCheckIds.map((checkId) => ({
          checkId,
          sources: [
            selectionMode === 'scoped'
              ? ('path' as const)
              : selectionMode === 'fallback-full'
                ? ('fallback-full' as const)
                : ('full' as const),
          ],
        }));
  if (requirement !== null && suppliedReasons.length === 0) {
    throw new Error('ready Issue 检查结果缺少逐项选择原因');
  }
  const allApplicableCheckIds = contractCheckEvidence(input.contract, platform).map(
    (check) => check.id,
  );
  if (
    !requirementMatchesSelection(
      requirement,
      selectedCheckIds,
      selectionReasons,
      allApplicableCheckIds,
    )
  ) {
    throw new Error('ready Issue 显式检查要求未被实际选择原因完整覆盖');
  }
  const inputReasons = normalizedReasons(changeScope?.selectionReasons, selectedCheckIds);
  if (inputReasons.length > 0 && !sameReasons(inputReasons, selectionReasons)) {
    throw new Error('检查结果的选择原因与绑定输入不一致');
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
            ...(inputReasons.length === 0 ? {} : { selectionReasons: inputReasons }),
          },
    selectionMode,
    selectionRequirement: requirement,
    selectionReasons,
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
      ...(result.selectionRequirement === undefined
        ? {}
        : {
            selectionRequirement: {
              mode: result.selectionRequirement.mode,
              checkIds: [...result.selectionRequirement.checkIds],
            },
          }),
      ...(result.selectionReasons === undefined
        ? {}
        : {
            selectionReasons: selectionReasons.map((reason) => ({
              checkId: reason.checkId,
              sources: [...reason.sources],
            })),
          }),
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
    selectionRequirement:
      proof.selectionRequirement === null
        ? null
        : {
            mode: proof.selectionRequirement.mode,
            checkIds: [...proof.selectionRequirement.checkIds],
          },
    selectionReasons: proof.selectionReasons.map((reason) => ({
      checkId: reason.checkId,
      sources: [...reason.sources],
    })),
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
  const allApplicableCheckIds = contractCheckEvidence(expected.contract, expectedPlatform).map(
    (check) => check.id,
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
    (proof.selectionMode === 'scoped' && proof.changeScope === null) ||
    (proof.selectionMode !== 'scoped' &&
      proof.changeScope !== null &&
      proof.selectionRequirement === null) ||
    (proof.selectionRequirement === null) !== (expected.selectionRequirement === undefined) ||
    (proof.selectionRequirement !== null &&
      (proof.selectionRequirement.mode !== expected.selectionRequirement?.mode ||
        !sameStringArray(
          proof.selectionRequirement.checkIds,
          expected.selectionRequirement?.checkIds ?? [],
        ))) ||
    (proof.changeScope !== null && proof.changeScope.baseGitHead !== expectedChangeBaseGitHead) ||
    proof.inputDigest !== expectedInputDigest ||
    (proof.changeScope !== null &&
      (proof.changeScope.selectedCheckIds.length !== expectedChecks.length ||
        proof.changeScope.selectedCheckIds.some(
          (id, index) => id !== expectedChecks[index]?.id,
        ))) ||
    (proof.changeScope !== null &&
      proof.selectionRequirement !== null &&
      !sameReasons(
        proof.changeScope.selectionReasons ?? [],
        proof.selectionReasons,
      )) ||
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
    (proof.selectionRequirement !== null && proof.result.selectionReasons === undefined) ||
    (proof.result.selectionReasons !== undefined &&
      !sameReasons(proof.result.selectionReasons, proof.selectionReasons)) ||
    !requirementMatchesSelection(
      proof.selectionRequirement,
      proof.checks.map((check) => check.id),
      proof.selectionReasons,
      allApplicableCheckIds,
    ) ||
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
    ...(proof.result.selectionRequirement === undefined
      ? {}
      : {
          selectionRequirement: {
            mode: proof.result.selectionRequirement.mode,
            checkIds: [...proof.result.selectionRequirement.checkIds],
          },
        }),
    ...(proof.result.selectionReasons === undefined
      ? {}
      : {
          selectionReasons: proof.result.selectionReasons.map((reason) => ({
            checkId: reason.checkId,
            sources: [...reason.sources],
          })),
        }),
  };
}

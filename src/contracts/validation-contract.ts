import { createHash } from 'node:crypto';

export const VALIDATION_PROTOCOL_VERSION = 2 as const;
export const VALIDATION_RECEIPT_SCHEMA_VERSION = 4 as const;
export const VALIDATION_RESULT_FILE = 'validation-result.json';
export const VALIDATION_RESULT_MAX_BYTES = 64 * 1024;
export const VALIDATION_TEXT_MAX_CHARS = 2000;
export const ENGINE_QUALITY_GATE_EVIDENCE_SCHEMA_VERSION = 3 as const;

export type ContractParseResult<T> =
  { ok: true; value: T } | { ok: false; code: string; diagnostic: string };

export interface ValidationRequest {
  version: typeof VALIDATION_PROTOCOL_VERSION;
  requestId: string;
  storyId: string;
  acceptanceHash: string;
  acceptanceCriteria: string[];
  /** 调用 Validator 前的 Git HEAD；非 Git 历史诊断显式为 null。 */
  gitHead: string | null;
  /** Story 第一次进入实现轮前由引擎冻结的 Git HEAD。 */
  storyBaseGitHead: string | null;
  /** 引擎对 storyBaseGitHead..gitHead 完整 raw diff 计算的摘要。 */
  changeManifestDigest: string;
  /** 同一 raw diff 中的路径记录数量；重命名关闭后每条记录只有一个路径。 */
  changedPathCount: number;
  /**
   * 同一次 run 中刚完成的引擎适用检查。它只替代完全相同的机械命令重跑，
   * 不替 Validator 判断代码语义；旧请求可省略。
   */
  engineQualityGate?: EngineQualityGateEvidence;
  resultPath: string;
}

export interface EngineQualityGateCheckEvidence {
  category: 'test' | 'build' | 'static' | 'security';
  id: string;
  module: string;
}

export interface EngineQualityGateEvidence {
  schemaVersion: typeof ENGINE_QUALITY_GATE_EVIDENCE_SCHEMA_VERSION;
  source: 'engine-effective-gate';
  status: 'passed';
  inputDigest: string;
  gitHead: string;
  defaultBranchGitHead: string;
  qualityContractDigest: string;
  platform: 'linux' | 'macos' | 'windows';
  total: number;
  ran: number;
  checks: EngineQualityGateCheckEvidence[];
  skippedCheckIds: string[];
  /** scoped 或 ready Issue 显式责任存在时绑定 Story 起点，否则为 null。 */
  changeBaseGitHead: string | null;
  /** scoped 或 ready Issue 显式责任存在时绑定完整变化摘要，否则为 null。 */
  changeManifestDigest: string | null;
  selectionMode: 'full' | 'scoped' | 'fallback-full';
  selectionRequirement: {
    mode: 'scoped' | 'full';
    checkIds: string[];
  } | null;
  selectionReasons: Array<{
    checkId: string;
    sources: Array<'always' | 'path' | 'explicit' | 'full' | 'fallback-full'>;
  }>;
}

export interface ValidationCheck {
  /** 一基序号，必须按 1..N 精确覆盖 request.acceptanceCriteria。 */
  acIndex: number;
  passed: boolean;
  /** Validator 声明的有界证据；是 claim，不是引擎证明。 */
  evidence: string;
}

export interface ValidationResult {
  version: typeof VALIDATION_PROTOCOL_VERSION;
  requestId: string;
  storyId: string;
  acceptanceHash: string;
  gitHead: string | null;
  storyBaseGitHead: string | null;
  changeManifestDigest: string;
  changedPathCount: number;
  verdict: 'passed' | 'failed';
  checks: ValidationCheck[];
  summary: string;
}

interface ValidationReceiptBase {
  requestId: string;
  gitHead: string;
  acceptanceHash: string;
}

interface HostBoundValidationReceipt extends ValidationReceiptBase {
  /** Engine-owned digest of the clean-checkout execution contract. */
  validationEnvironmentDigest: string;
  /** Digest of the resolved Validator runner host-isolation profile (ADR-025). */
  runnerProfileDigest: string;
  /** Digest of the engine-observed canary evidence bound to that profile. */
  canaryEvidenceDigest: string;
}

export type ValidationReceipt =
  | (ValidationReceiptBase & {
      /** v1 remains readable only so the engine can invalidate it safely. */
      schemaVersion: 1;
      validationEnvironmentDigest?: never;
      runnerProfileDigest?: never;
      canaryEvidenceDigest?: never;
    })
  | (ValidationReceiptBase & {
      /** v2 lacks the runner host-isolation binding; readable only for safe invalidation. */
      schemaVersion: 2;
      validationEnvironmentDigest: string;
      runnerProfileDigest?: never;
      canaryEvidenceDigest?: never;
    })
  | (HostBoundValidationReceipt & {
      /** v3 lacks the fixed Story base and change manifest; readable only for safe invalidation. */
      schemaVersion: 3;
      storyBaseGitHead?: never;
      changeManifestDigest?: never;
      changedPathCount?: never;
    })
  | (HostBoundValidationReceipt & {
      schemaVersion: typeof VALIDATION_RECEIPT_SCHEMA_VERSION;
      storyBaseGitHead: string;
      changeManifestDigest: string;
      changedPathCount: number;
    });

export interface ValidationResultBinding {
  readonly requestId: string;
  readonly storyId: string;
  readonly acceptanceHash: string;
  readonly checkCount: number;
  readonly gitHead: string | null;
  readonly storyBaseGitHead: string | null;
  readonly changeManifestDigest: string;
  readonly changedPathCount: number;
}

export type ValidationProtocolErrorCode =
  | 'missing-result'
  | 'unreadable-result'
  | 'result-too-large'
  | 'invalid-json'
  | 'invalid-schema'
  | 'binding-mismatch'
  | 'artifact-changed';

export type ValidationProtocolOutcome =
  | { ok: true; result: ValidationResult }
  | { ok: false; code: ValidationProtocolErrorCode; diagnostic: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function isGitHead(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

export function isAcceptanceHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isNullableGitHead(value: unknown): value is string | null {
  return value === null || isGitHead(value);
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= VALIDATION_TEXT_MAX_CHARS
  );
}

export function isChangedPathCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** AC 快照身份：只编码 story ID 与有序 AC 数组。 */
export function acceptanceHash(storyId: string, acceptanceCriteria: readonly string[]): string {
  const canonical = JSON.stringify({ storyId, acceptanceCriteria });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** 严格读取 v1-v4 凭证；v1-v3 只为安全失效迁移，不再是当前通过。 */
export function parseValidationReceipt(value: unknown): ValidationReceipt | null {
  if (!isRecord(value)) return null;
  const expectedKeys =
    value.schemaVersion === 1
      ? ['schemaVersion', 'requestId', 'gitHead', 'acceptanceHash']
      : value.schemaVersion === 2
        ? ['schemaVersion', 'requestId', 'gitHead', 'acceptanceHash', 'validationEnvironmentDigest']
        : value.schemaVersion === 3
          ? [
              'schemaVersion',
              'requestId',
              'gitHead',
              'acceptanceHash',
              'validationEnvironmentDigest',
              'runnerProfileDigest',
              'canaryEvidenceDigest',
            ]
          : [
              'schemaVersion',
              'requestId',
              'gitHead',
              'acceptanceHash',
              'validationEnvironmentDigest',
              'runnerProfileDigest',
              'canaryEvidenceDigest',
              'storyBaseGitHead',
              'changeManifestDigest',
              'changedPathCount',
            ];
  if (!hasExactKeys(value, expectedKeys)) return null;
  if (
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== VALIDATION_RECEIPT_SCHEMA_VERSION) ||
    typeof value.requestId !== 'string' ||
    value.requestId.trim().length === 0 ||
    !isGitHead(value.gitHead) ||
    !isAcceptanceHash(value.acceptanceHash) ||
    (value.schemaVersion !== 1 && !isSha256Digest(value.validationEnvironmentDigest)) ||
    ((value.schemaVersion === 3 || value.schemaVersion === VALIDATION_RECEIPT_SCHEMA_VERSION) &&
      (!isSha256Digest(value.runnerProfileDigest) ||
        !isSha256Digest(value.canaryEvidenceDigest))) ||
    (value.schemaVersion === VALIDATION_RECEIPT_SCHEMA_VERSION &&
      (!isGitHead(value.storyBaseGitHead) ||
        !isSha256Digest(value.changeManifestDigest) ||
        !isChangedPathCount(value.changedPathCount)))
  ) {
    return null;
  }
  const base = {
    requestId: value.requestId,
    gitHead: value.gitHead,
    acceptanceHash: value.acceptanceHash,
  };
  if (value.schemaVersion === 1) return { schemaVersion: 1, ...base };
  if (value.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      ...base,
      validationEnvironmentDigest: value.validationEnvironmentDigest as string,
    };
  }
  if (value.schemaVersion === 3) {
    return {
      schemaVersion: 3,
      ...base,
      validationEnvironmentDigest: value.validationEnvironmentDigest as string,
      runnerProfileDigest: value.runnerProfileDigest as string,
      canaryEvidenceDigest: value.canaryEvidenceDigest as string,
    };
  }
  return {
    schemaVersion: VALIDATION_RECEIPT_SCHEMA_VERSION,
    ...base,
    validationEnvironmentDigest: value.validationEnvironmentDigest as string,
    runnerProfileDigest: value.runnerProfileDigest as string,
    canaryEvidenceDigest: value.canaryEvidenceDigest as string,
    storyBaseGitHead: value.storyBaseGitHead as string,
    changeManifestDigest: value.changeManifestDigest as string,
    changedPathCount: value.changedPathCount as number,
  };
}

function invalidSchema(diagnostic: string): ValidationProtocolOutcome {
  return { ok: false, code: 'invalid-schema', diagnostic };
}

/** Validator result 的唯一纯 value schema。 */
export function parseValidationResultValue(
  value: unknown,
  checkCount: number,
): ValidationProtocolOutcome {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'requestId',
      'storyId',
      'acceptanceHash',
      'gitHead',
      'storyBaseGitHead',
      'changeManifestDigest',
      'changedPathCount',
      'verdict',
      'checks',
      'summary',
    ])
  ) {
    return invalidSchema('result 必须是且只能包含 v2 schema 字段的对象');
  }

  if (value.version !== VALIDATION_PROTOCOL_VERSION) {
    return invalidSchema(`不支持的 validation result version: ${String(value.version)}`);
  }
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    typeof value.storyId !== 'string' ||
    value.storyId.length === 0 ||
    !isAcceptanceHash(value.acceptanceHash) ||
    !isNullableGitHead(value.gitHead) ||
    !isNullableGitHead(value.storyBaseGitHead) ||
    !isSha256Digest(value.changeManifestDigest) ||
    !isChangedPathCount(value.changedPathCount) ||
    (value.verdict !== 'passed' && value.verdict !== 'failed') ||
    !Array.isArray(value.checks) ||
    !isBoundedText(value.summary)
  ) {
    return invalidSchema('result 顶层字段类型、格式或长度非法');
  }
  if (value.checks.length !== checkCount) {
    return invalidSchema(`checks 数量 ${value.checks.length} 与 AC 数量 ${checkCount} 不一致`);
  }

  const checks: ValidationCheck[] = [];
  for (let index = 0; index < value.checks.length; index += 1) {
    const check: unknown = value.checks[index];
    if (
      !isRecord(check) ||
      !hasExactKeys(check, ['acIndex', 'passed', 'evidence']) ||
      check.acIndex !== index + 1 ||
      typeof check.passed !== 'boolean' ||
      !isBoundedText(check.evidence)
    ) {
      return invalidSchema(`checks[${index}] 未按 AC ${index + 1} 的 schema 提交`);
    }
    checks.push({ acIndex: check.acIndex, passed: check.passed, evidence: check.evidence });
  }

  const allPassed = checks.every((check) => check.passed);
  if ((value.verdict === 'passed') !== allPassed) {
    return invalidSchema('verdict 与逐 AC checks 结论矛盾');
  }

  return {
    ok: true,
    result: {
      version: VALIDATION_PROTOCOL_VERSION,
      requestId: value.requestId,
      storyId: value.storyId,
      acceptanceHash: value.acceptanceHash,
      gitHead: value.gitHead,
      storyBaseGitHead: value.storyBaseGitHead,
      changeManifestDigest: value.changeManifestDigest,
      changedPathCount: value.changedPathCount,
      verdict: value.verdict,
      checks,
      summary: value.summary,
    },
  };
}

/**
 * 对精确 bytes 执行现有 Validator result schema 与冻结目标绑定；不读取文件或 Git。
 */
export function parseValidationResultBytes(
  input: Uint8Array,
  binding: ValidationResultBinding,
): ValidationProtocolOutcome {
  const bytes = Buffer.from(input);
  if (bytes.byteLength > VALIDATION_RESULT_MAX_BYTES) {
    return {
      ok: false,
      code: 'result-too-large',
      diagnostic: `validation result 超过 ${VALIDATION_RESULT_MAX_BYTES} bytes`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return { ok: false, code: 'invalid-json', diagnostic: 'validation result 不是合法 JSON' };
  }
  const shaped = parseValidationResultValue(parsed, binding.checkCount);
  if (!shaped.ok) return shaped;
  const result = shaped.result;
  if (
    result.requestId !== binding.requestId ||
    result.storyId !== binding.storyId ||
    result.acceptanceHash !== binding.acceptanceHash ||
    result.gitHead !== binding.gitHead ||
    result.storyBaseGitHead !== binding.storyBaseGitHead ||
    result.changeManifestDigest !== binding.changeManifestDigest ||
    result.changedPathCount !== binding.changedPathCount
  ) {
    return {
      ok: false,
      code: 'binding-mismatch',
      diagnostic:
        'validation result 与本轮 request ID、story、AC、Story 起点、Git HEAD 或变化摘要不匹配',
    };
  }
  return shaped;
}

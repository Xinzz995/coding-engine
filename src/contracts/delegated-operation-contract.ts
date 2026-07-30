import { parseRunStateBytes, type RunState } from './run-state-contract.js';
import {
  isAcceptanceHash,
  isGitHead,
  parseValidationResultBytes,
  type ContractParseResult,
  type ValidationResult,
} from './validation-contract.js';

export const DELEGATED_STORY_ID_MAX_CHARS = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface BuilderStateSemanticContract {
  readonly version: 'builder-state-v1';
  readonly storyId: string;
  readonly acceptanceHash: string;
  readonly checkCount: number;
}

export interface ValidatorResultSemanticContract {
  readonly version: 'validator-result-v1';
  readonly requestId: string;
  readonly storyId: string;
  readonly acceptanceHash: string;
  readonly checkCount: number;
  readonly gitHead: string;
}

export interface ReadOnlySemanticContract {
  readonly version: 'read-only-v1';
}

export type DelegatedSemanticContract =
  BuilderStateSemanticContract | ValidatorResultSemanticContract | ReadOnlySemanticContract;

export type DelegatedSemanticCandidate =
  | {
      readonly version: 'builder-state-v1';
      readonly state: RunState;
    }
  | {
      readonly version: 'validator-result-v1';
      readonly result: ValidationResult;
    };

export type DelegatedSemanticEvaluation =
  | { readonly accepted: true; readonly candidate?: DelegatedSemanticCandidate }
  | { readonly accepted: false; readonly violation: string };

type StrictRecord = Record<string, unknown>;

function record(value: unknown): StrictRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as StrictRecord) : null;
}

function exactKeys(value: StrictRecord, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => typeof key === 'string' && expected.includes(key)) &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function storyId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DELEGATED_STORY_ID_MAX_CHARS &&
    !value.includes('\0')
  );
}

function checkCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function failure<T>(diagnostic: string): ContractParseResult<T> {
  return { ok: false, code: 'invalid-delegated-semantic-contract', diagnostic };
}

/** 持久 semantic identity 的唯一严格 parser。 */
export function parseDelegatedSemanticContract(
  value: unknown,
): ContractParseResult<DelegatedSemanticContract> {
  const semantic = record(value);
  if (!semantic || typeof semantic.version !== 'string') {
    return failure('delegated semantic contract 必须是带 version 的 object');
  }
  if (semantic.version === 'read-only-v1') {
    return exactKeys(semantic, ['version'])
      ? { ok: true, value: { version: 'read-only-v1' } }
      : failure('read-only semantic contract 含 unknown 或缺失字段');
  }
  if (semantic.version === 'builder-state-v1') {
    if (!exactKeys(semantic, ['version', 'storyId', 'acceptanceHash', 'checkCount'])) {
      return failure('builder semantic contract 含 unknown 或缺失字段');
    }
    if (
      !storyId(semantic.storyId) ||
      !isAcceptanceHash(semantic.acceptanceHash) ||
      !checkCount(semantic.checkCount)
    ) {
      return failure('builder semantic contract identity 非法');
    }
    return {
      ok: true,
      value: {
        version: 'builder-state-v1',
        storyId: semantic.storyId,
        acceptanceHash: semantic.acceptanceHash,
        checkCount: semantic.checkCount,
      },
    };
  }
  if (semantic.version === 'validator-result-v1') {
    if (
      !exactKeys(semantic, [
        'version',
        'requestId',
        'storyId',
        'acceptanceHash',
        'checkCount',
        'gitHead',
      ])
    ) {
      return failure('validator semantic contract 含 unknown 或缺失字段');
    }
    if (
      typeof semantic.requestId !== 'string' ||
      !UUID_PATTERN.test(semantic.requestId) ||
      !storyId(semantic.storyId) ||
      !isAcceptanceHash(semantic.acceptanceHash) ||
      !checkCount(semantic.checkCount) ||
      !isGitHead(semantic.gitHead)
    ) {
      return failure('validator semantic contract identity 非法');
    }
    return {
      ok: true,
      value: {
        version: 'validator-result-v1',
        requestId: semantic.requestId,
        storyId: semantic.storyId,
        acceptanceHash: semantic.acceptanceHash,
        checkCount: semantic.checkCount,
        gitHead: semantic.gitHead,
      },
    };
  }
  return failure(`不支持的 delegated semantic version: ${semantic.version}`);
}

export const RUN_STATE_PATH = 'state.json';
export const VALIDATION_RESULT_PATH = 'validation-result.json';

export function delegatedSemanticFilePaths(semantic: DelegatedSemanticContract): readonly string[] {
  if (semantic.version === 'builder-state-v1') return [RUN_STATE_PATH];
  if (semantic.version === 'validator-result-v1') return [VALIDATION_RESULT_PATH];
  return [];
}

/**
 * 只消费稳定扫描已经读取的精确 bytes；evidence/screenshots 不属于完成语义。
 */
export function evaluateDelegatedSemantic(input: {
  readonly semantic: DelegatedSemanticContract;
  readonly phase: 'baseline' | 'settlement';
  readonly files: ReadonlyMap<string, Uint8Array>;
}): DelegatedSemanticEvaluation {
  const { semantic, phase, files } = input;
  if (semantic.version === 'read-only-v1') return { accepted: true };
  if (semantic.version === 'builder-state-v1') {
    const bytes = files.get(RUN_STATE_PATH);
    if (!bytes) return { accepted: false, violation: `${RUN_STATE_PATH}:semantic-missing` };
    const parsed = parseRunStateBytes(bytes);
    if (!parsed.ok) {
      return { accepted: false, violation: `${RUN_STATE_PATH}:${parsed.code}` };
    }
    if (!Object.hasOwn(parsed.value, semantic.storyId)) {
      return { accepted: false, violation: `${RUN_STATE_PATH}:semantic-story-missing` };
    }
    return {
      accepted: true,
      candidate: { version: 'builder-state-v1', state: parsed.value },
    };
  }

  const bytes = files.get(VALIDATION_RESULT_PATH);
  if (phase === 'baseline') {
    return bytes
      ? { accepted: false, violation: `${VALIDATION_RESULT_PATH}:preexisting-result` }
      : { accepted: true };
  }
  if (!bytes) return { accepted: true };
  const parsed = parseValidationResultBytes(bytes, semantic);
  if (!parsed.ok) {
    return { accepted: false, violation: `${VALIDATION_RESULT_PATH}:${parsed.code}` };
  }
  return {
    accepted: true,
    candidate: { version: 'validator-result-v1', result: parsed.result },
  };
}

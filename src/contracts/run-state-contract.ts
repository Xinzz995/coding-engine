import {
  isAcceptanceHash,
  isGitHead,
  parseValidationReceipt,
  VALIDATION_RECEIPT_SCHEMA_VERSION,
  type ContractParseResult,
  type ValidationReceipt,
} from './validation-contract.js';

export const VALIDATOR_UNVERIFIABLE_SCHEMA_VERSION = 1 as const;

export interface ValidatorUnverifiableMarker {
  schemaVersion: typeof VALIDATOR_UNVERIFIABLE_SCHEMA_VERSION;
  gitHead: string;
  acceptanceHash: string;
}

export interface StoryState {
  passes: boolean;
  validated: boolean;
  validationReceipt?: ValidationReceipt | null;
  /** 引擎持有、绑定当前候选的最近一次 Validator 不可验证状态。 */
  validatorUnverifiable?: ValidatorUnverifiableMarker | null;
  notes: string;
  retryCount: number;
  blocked: boolean;
  escalated: boolean;
}

/** key = story id */
export type RunState = Record<string, StoryState>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseValidatorUnverifiableMarker(
  value: unknown,
): ValidatorUnverifiableMarker | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'acceptanceHash' ||
    keys[1] !== 'gitHead' ||
    keys[2] !== 'schemaVersion' ||
    value.schemaVersion !== VALIDATOR_UNVERIFIABLE_SCHEMA_VERSION ||
    !isGitHead(value.gitHead) ||
    !isAcceptanceHash(value.acceptanceHash)
  ) {
    return null;
  }
  return {
    schemaVersion: VALIDATOR_UNVERIFIABLE_SCHEMA_VERSION,
    gitHead: value.gitHead,
    acceptanceHash: value.acceptanceHash,
  };
}

/** 保持既有宽严：未知 story 字段、负数/小数 retryCount 仍沿用历史接受规则。 */
function normalizeStoryState(value: unknown): StoryState | null {
  if (!isRecord(value)) return null;
  const story = value;
  if (
    typeof story.passes !== 'boolean' ||
    typeof story.notes !== 'string' ||
    typeof story.retryCount !== 'number' ||
    typeof story.blocked !== 'boolean' ||
    (story.validated !== undefined && typeof story.validated !== 'boolean') ||
    (story.escalated !== undefined && typeof story.escalated !== 'boolean')
  ) {
    return null;
  }
  let validationReceipt: ValidationReceipt | null = null;
  if (story.validationReceipt !== undefined && story.validationReceipt !== null) {
    validationReceipt = parseValidationReceipt(story.validationReceipt);
    if (!validationReceipt) return null;
  }
  let validatorUnverifiable: ValidatorUnverifiableMarker | null = null;
  if (story.validatorUnverifiable !== undefined && story.validatorUnverifiable !== null) {
    validatorUnverifiable = parseValidatorUnverifiableMarker(story.validatorUnverifiable);
    if (!validatorUnverifiable) return null;
  }
  const hasCurrentReceipt =
    !story.blocked &&
    story.passes &&
    story.validated === true &&
    validationReceipt?.schemaVersion === VALIDATION_RECEIPT_SCHEMA_VERSION;
  return {
    passes: story.passes,
    validated: hasCurrentReceipt,
    validationReceipt: hasCurrentReceipt ? validationReceipt : null,
    validatorUnverifiable:
      story.passes && !story.blocked && !hasCurrentReceipt ? validatorUnverifiable : null,
    notes: story.notes,
    retryCount: story.retryCount,
    blocked: story.blocked,
    escalated: story.escalated ?? false,
  };
}

/** RunState 的唯一纯 value schema。 */
export function parseRunStateValue(value: unknown): ContractParseResult<RunState> {
  if (!isRecord(value)) {
    return { ok: false, code: 'invalid-state-schema', diagnostic: 'state 必须是 JSON object' };
  }
  const state: RunState = {};
  for (const [storyId, raw] of Object.entries(value)) {
    const normalized = normalizeStoryState(raw);
    if (!normalized) {
      return {
        ok: false,
        code: 'invalid-state-schema',
        diagnostic: `state story ${storyId} 不符合现有 schema`,
      };
    }
    state[storyId] = normalized;
  }
  return { ok: true, value: state };
}

/** RunState 的唯一纯 bytes schema；保持既有 JSON.parse 行为。 */
export function parseRunStateBytes(input: Uint8Array): ContractParseResult<RunState> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(input).toString('utf8')) as unknown;
  } catch {
    return { ok: false, code: 'invalid-state-json', diagnostic: 'state 不是合法 JSON' };
  }
  return parseRunStateValue(value);
}

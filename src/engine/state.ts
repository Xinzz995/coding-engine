import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
import { join } from 'node:path';
import type { Prd, Story } from './prd.js';
import { readSafeControlFileUtf8Sync } from './safe-control-file.js';
import { acceptanceHash } from './validation-protocol.js';

export const VALIDATION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const STATE_CONTROL_FILE_MAX_BYTES = 16 * 1024 * 1024;

export interface ValidationReceipt {
  schemaVersion: typeof VALIDATION_RECEIPT_SCHEMA_VERSION;
  requestId: string;
  gitHead: string;
  acceptanceHash: string;
}

export interface StoryState {
  passes: boolean;
  /** validator 已被引擎机械观察为正常完成；仅引擎可修改，不能脱离结构化凭证独立证明通过。 */
  validated: boolean;
  /** Validator 目标绑定；仅引擎可签发、撤销和修改。 */
  validationReceipt: ValidationReceipt | null;
  notes: string;
  retryCount: number;
  blocked: boolean;
  /** 首次有效失败已触发专用升级路由；仅引擎可修改。 */
  escalated: boolean;
}

/** key = story id */
export type RunState = Record<string, StoryState>;

/** 仪表盘/展示用合并视图 */
export type StoryView = Story & StoryState;

export const INITIAL_STORY_STATE: Readonly<StoryState> = Object.freeze({
  passes: false,
  validated: false,
  validationReceipt: null,
  notes: '',
  retryCount: 0,
  blocked: false,
  escalated: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isGitHead(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

/** 严格校验持久凭证；未知字段、空 request 或非完整提交身份一律拒绝。 */
export function isValidationReceipt(value: unknown): value is ValidationReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'requestId', 'gitHead', 'acceptanceHash'])
  )
    return false;
  return (
    value.schemaVersion === VALIDATION_RECEIPT_SCHEMA_VERSION &&
    typeof value.requestId === 'string' &&
    value.requestId.trim().length > 0 &&
    isGitHead(value.gitHead) &&
    typeof value.acceptanceHash === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(value.acceptanceHash)
  );
}

function normalizeStoryState(v: unknown): StoryState | null {
  if (!isRecord(v)) return null;
  const s = v;
  if (
    typeof s.passes !== 'boolean' ||
    typeof s.notes !== 'string' ||
    typeof s.retryCount !== 'number' ||
    typeof s.blocked !== 'boolean' ||
    (s.validated !== undefined && typeof s.validated !== 'boolean') ||
    (s.escalated !== undefined && typeof s.escalated !== 'boolean') ||
    (s.validationReceipt !== undefined &&
      s.validationReceipt !== null &&
      !isValidationReceipt(s.validationReceipt))
  )
    return null;
  const receipt = s.validationReceipt === undefined ? null : s.validationReceipt;
  return {
    passes: s.passes,
    // 旧 state 仍可读，但缺少结构化目标绑定时只能表示历史结论，不能自动恢复绿灯。
    // 这里只做严格白名单解析；候选、blocked、HEAD 与 AC 的一致性统一交给 reconcile，
    // 这样失配会被明确记录并持久撤销，而不是在读取时静默吞掉。
    validated: s.validated === true,
    validationReceipt: isValidationReceipt(receipt) ? receipt : null,
    notes: s.notes,
    retryCount: s.retryCount,
    blocked: s.blocked,
    // v0.22.0 及更早 state 没有该字段：内存归一但不因读取立刻重写文件。
    escalated: s.escalated ?? false,
  };
}

export function tryReadState(path: string): RunState | null {
  try {
    const content = readSafeControlFileUtf8Sync(path, {
      maxBytes: STATE_CONTROL_FILE_MAX_BYTES,
      allowMissing: true,
    });
    if (content === null) return null;
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const state: RunState = {};
    for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeStoryState(raw);
      if (!normalized) return null;
      state[id] = normalized;
    }
    return state;
  } catch {
    return null;
  }
}

export interface EngineOwnedFields {
  validated: boolean | 'missing';
  validationReceipt: ValidationReceipt | null | 'missing';
  escalated: boolean | 'missing';
}

/**
 * 读取磁盘原始所有权字段，不做 legacy 缺省归一。
 * loop 用它区分“字段缺失”和“字段值恰好等于兼容缺省”，确保删除也能留痕。
 */
export function tryReadEngineOwnedFields(path: string, storyId: string): EngineOwnedFields | null {
  try {
    const content = readSafeControlFileUtf8Sync(path, {
      maxBytes: STATE_CONTROL_FILE_MAX_BYTES,
      allowMissing: true,
    });
    if (content === null) return null;
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const raw = (parsed as Record<string, unknown>)[storyId];
    if (raw === undefined) {
      return { validated: 'missing', validationReceipt: 'missing', escalated: 'missing' };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const story = raw as Record<string, unknown>;
    const validated = story.validated === undefined ? 'missing' : story.validated;
    const validationReceipt =
      story.validationReceipt === undefined ? 'missing' : story.validationReceipt;
    const escalated = story.escalated === undefined ? 'missing' : story.escalated;
    if (
      (validated !== 'missing' && typeof validated !== 'boolean') ||
      (validationReceipt !== 'missing' &&
        validationReceipt !== null &&
        !isValidationReceipt(validationReceipt)) ||
      (escalated !== 'missing' && typeof escalated !== 'boolean')
    )
      return null;
    return {
      validated,
      validationReceipt:
        validationReceipt === 'missing' || validationReceipt === null
          ? validationReceipt
          : validationReceipt,
      escalated,
    };
  } catch {
    return null;
  }
}

// v0.4 及更早的 prd.json 把状态字段写在 story 上；这里读取它们用于迁移与离线回看，缺省按初始值。
function legacyStateOf(story: Story): StoryState {
  const s = story as Story & Partial<StoryState>;
  const passes = s.passes ?? false;
  const blocked = s.blocked ?? false;
  return {
    passes,
    // 旧 story 内嵌字段没有可核对的提交/AC 身份，只迁移为待重新验收的实现候选。
    validated: false,
    validationReceipt: null,
    notes: s.notes ?? '',
    retryCount: s.retryCount ?? 0,
    blocked,
    escalated: false,
  };
}

export function initialStateFor(prd: Prd): RunState {
  const state: RunState = {};
  for (const s of prd.userStories) state[s.id] = legacyStateOf(s);
  return state;
}

// 运行期回退用：不读 story 上的 legacy 字段（防止已迁移的旧状态“复活”），全部按初始值。
export function blankStateFor(prd: Prd): RunState {
  const state: RunState = {};
  for (const s of prd.userStories) state[s.id] = INITIAL_STORY_STATE;
  return state;
}

export interface DisplayStateRead {
  state: RunState;
  /** state.json 存在但解析失败/形状非法；文件缺失是合法的 legacy 回退。 */
  stateCorrupted: boolean;
  /** 当前提交/验收标准下不能继续作为通过凭证的 Story。 */
  validationInvalidations: ValidationReceiptInvalidation[];
}

/**
 * status/dashboard/report 的展示状态单源：文件缺失才迁移旧版内嵌字段；
 * 文件存在但损坏时全部按未验证显示，绝不复活 legacy 通过态。
 */
export function readDisplayState(
  path: string,
  prd: Prd,
  currentGitHead: string | null,
): DisplayStateRead {
  const stateExists = existsSync(path);
  const rawState = stateExists ? tryReadState(path) : null;
  const stateCorrupted = stateExists && rawState === null;
  const baseState = stateCorrupted ? blankStateFor(prd) : (rawState ?? initialStateFor(prd));
  const reconciled = reconcileValidationReceipts(prd, baseState, currentGitHead);
  return {
    state: reconciled.state,
    stateCorrupted,
    validationInvalidations: reconciled.invalidated,
  };
}

// 启动时保证 state.json 存在：缺失则从 prd 初始化（含旧格式抽取迁移）并落盘。
// 文件存在但解析失败时不覆盖（留给 npx coding-x repair），内存中按初始值继续。
export function ensureStateFile(workspace: string, prd: Prd): RunState {
  const path = join(workspace, 'state.json');
  if (existsSync(path)) {
    return tryReadState(path) ?? initialStateFor(prd);
  }
  const state = initialStateFor(prd);
  writeFileAtomicSync(path, JSON.stringify(state, null, 2));
  return state;
}

function storyStateOf(state: RunState, id: string): StoryState {
  return state[id] ?? INITIAL_STORY_STATE;
}

/**
 * 无 PRD/HEAD 上下文时的最低通过判定：只接受结构合法的凭证。
 * 正式完成出口仍必须先走 evaluate/reconcile 或 digest 核对当前性。
 */
export function isStoryPassed(
  state: Pick<StoryState, 'passes' | 'validated' | 'validationReceipt' | 'blocked'>,
): boolean {
  return (
    !state.blocked &&
    state.passes &&
    state.validated &&
    isValidationReceipt(state.validationReceipt)
  );
}

export interface EscalatedTamper {
  expected: boolean;
  received: boolean | 'missing';
}

export interface ValidationOwnedFields {
  validated: boolean;
  validationReceipt: ValidationReceipt | null;
}

export interface ValidationOwnedFieldsObservation {
  validated: boolean | 'missing';
  validationReceipt: ValidationReceipt | null | 'missing';
}

export interface ValidationTamper {
  expected: ValidationOwnedFields;
  received: ValidationOwnedFieldsObservation;
}

/** 恢复 agent 写回前的引擎独占值；无篡改时保持同一 state 引用。 */
export function restoreEscalated(
  state: RunState,
  storyId: string,
  expected: boolean,
  fallback?: StoryState,
  observed?: boolean | 'missing',
): { state: RunState; tamper: EscalatedTamper | null } {
  const current = state[storyId];
  if (!current) {
    if (!fallback) return { state, tamper: null };
    return {
      state: { ...state, [storyId]: { ...fallback, escalated: expected } },
      tamper: { expected, received: 'missing' },
    };
  }
  const received = observed ?? current.escalated;
  if (received === expected) return { state, tamper: null };
  return {
    state: { ...state, [storyId]: { ...current, escalated: expected } },
    tamper: { expected, received },
  };
}

function sameValidationReceipt(
  left: ValidationReceipt | null | 'missing',
  right: ValidationReceipt | null | 'missing',
): boolean {
  if (left === right) return true;
  if (!isValidationReceipt(left) || !isValidationReceipt(right)) return false;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.requestId === right.requestId &&
    left.gitHead === right.gitHead &&
    left.acceptanceHash === right.acceptanceHash
  );
}

export function validationOwnedFieldsOf(
  state: Pick<StoryState, 'validated' | 'validationReceipt'>,
): ValidationOwnedFields {
  return { validated: state.validated, validationReceipt: state.validationReceipt };
}

/** 恢复 agent 写回前的完整验收所有权；布尔值与结构化凭证作为一个原子状态处理。 */
export function restoreValidationOwnership(
  state: RunState,
  storyId: string,
  expected: ValidationOwnedFields,
  fallback?: StoryState,
  observed?: ValidationOwnedFieldsObservation,
): { state: RunState; tamper: ValidationTamper | null } {
  const current = state[storyId];
  if (!current) {
    if (!fallback) return { state, tamper: null };
    return {
      state: {
        ...state,
        [storyId]: {
          ...fallback,
          validated: expected.validated,
          validationReceipt: expected.validationReceipt,
        },
      },
      tamper: {
        expected,
        received: { validated: 'missing', validationReceipt: 'missing' },
      },
    };
  }
  const received: ValidationOwnedFieldsObservation = observed ?? {
    validated: current.validated,
    validationReceipt: current.validationReceipt,
  };
  if (
    received.validated === expected.validated &&
    sameValidationReceipt(received.validationReceipt, expected.validationReceipt)
  ) {
    return { state, tamper: null };
  }
  return {
    state: {
      ...state,
      [storyId]: {
        ...current,
        validated: expected.validated,
        validationReceipt: expected.validationReceipt,
      },
    },
    tamper: { expected, received },
  };
}

/** 结构化 Validator passed claim 通过目标/协议/state 检查且候选仍通过时，由引擎签发。 */
export function issueValidationReceipt(
  state: RunState,
  storyId: string,
  receipt: ValidationReceipt,
): { state: RunState; changed: boolean } {
  const current = state[storyId];
  if (!current || !current.passes || current.blocked || !isValidationReceipt(receipt)) {
    return { state, changed: false };
  }
  if (current.validated && sameValidationReceipt(current.validationReceipt, receipt)) {
    return { state, changed: false };
  }
  return {
    state: {
      ...state,
      [storyId]: { ...current, validated: true, validationReceipt: { ...receipt } },
    },
    changed: true,
  };
}

/** 统一撤销 Validator 结论；保留 Builder 候选，让循环可以只重跑检查与验收。 */
export function revokeValidationReceipt(
  state: RunState,
  storyId: string,
): { state: RunState; changed: boolean } {
  const current = state[storyId];
  if (!current || (!current.validated && current.validationReceipt === null)) {
    return { state, changed: false };
  }
  return {
    state: {
      ...state,
      [storyId]: { ...current, validated: false, validationReceipt: null },
    },
    changed: true,
  };
}

export type ValidationReceiptInvalidReason =
  | 'candidate-not-passing'
  | 'story-blocked'
  | 'validated-false'
  | 'missing-receipt'
  | 'invalid-receipt'
  | 'git-head-unavailable'
  | 'git-head-mismatch'
  | 'acceptance-hash-mismatch';

export type ValidationReceiptEvaluation =
  | { valid: true; reason: null; expectedAcceptanceHash: string; receipt: ValidationReceipt }
  | {
      valid: false;
      reason: ValidationReceiptInvalidReason;
      expectedAcceptanceHash: string;
      receipt: ValidationReceipt | null;
    };

/** 以当前 PRD 与提交核对单个 Story；不读取或写入文件。 */
export function evaluateValidationReceipt(
  story: Pick<Story, 'id' | 'acceptanceCriteria'>,
  state: StoryState,
  currentGitHead: string | null,
): ValidationReceiptEvaluation {
  const expectedAcceptanceHash = acceptanceHash(story.id, story.acceptanceCriteria);
  const rawReceipt: unknown = state.validationReceipt;
  const receipt = isValidationReceipt(rawReceipt) ? rawReceipt : null;
  if (state.blocked) {
    return { valid: false, reason: 'story-blocked', expectedAcceptanceHash, receipt };
  }
  if (!state.passes) {
    return { valid: false, reason: 'candidate-not-passing', expectedAcceptanceHash, receipt };
  }
  if (rawReceipt === null || rawReceipt === undefined) {
    return { valid: false, reason: 'missing-receipt', expectedAcceptanceHash, receipt: null };
  }
  if (!receipt) {
    return { valid: false, reason: 'invalid-receipt', expectedAcceptanceHash, receipt: null };
  }
  if (!state.validated) {
    return { valid: false, reason: 'validated-false', expectedAcceptanceHash, receipt };
  }
  if (!isGitHead(currentGitHead)) {
    return { valid: false, reason: 'git-head-unavailable', expectedAcceptanceHash, receipt };
  }
  if (receipt.gitHead !== currentGitHead) {
    return { valid: false, reason: 'git-head-mismatch', expectedAcceptanceHash, receipt };
  }
  if (receipt.acceptanceHash !== expectedAcceptanceHash) {
    return { valid: false, reason: 'acceptance-hash-mismatch', expectedAcceptanceHash, receipt };
  }
  return { valid: true, reason: null, expectedAcceptanceHash, receipt };
}

export interface ValidationReceiptInvalidation {
  storyId: string;
  reason: ValidationReceiptInvalidReason;
}

export interface ValidationReceiptReconciliation {
  state: RunState;
  changed: boolean;
  invalidated: ValidationReceiptInvalidation[];
}

/**
 * 让全部 Story 的持久状态与当前提交/AC 收敛。失效只撤销 Validator 结论，绝不
 * 删除 Builder 的 passes 候选，也不会从旧 evidence 或 Final Review 补造新凭证。
 */
export function reconcileValidationReceipts(
  prd: Prd,
  state: RunState,
  currentGitHead: string | null,
): ValidationReceiptReconciliation {
  let next = state;
  const invalidated: ValidationReceiptInvalidation[] = [];
  for (const story of prd.userStories) {
    const current = storyStateOf(next, story.id);
    const evaluation = evaluateValidationReceipt(story, current, currentGitHead);
    if (evaluation.valid) continue;

    const hasValidationState = current.validated || current.validationReceipt !== null;
    const isPendingCandidate = current.passes && !current.blocked;
    if (hasValidationState || isPendingCandidate) {
      invalidated.push({ storyId: story.id, reason: evaluation.reason });
    }
    if (!hasValidationState) continue;
    const revoked = revokeValidationReceipt(next, story.id);
    if (revoked.changed) next = revoked.state;
  }
  return { state: next, changed: next !== state, invalidated };
}

/**
 * Final Review 的稳定输入绑定：按 PRD 顺序覆盖每个 Story；只有所有非 blocked Story
 * 都绑定当前 HEAD/AC 时才返回摘要。blocked 项也进入摘要，避免状态变化后复用旧 Review。
 */
export function validationReceiptsDigest(
  prd: Prd,
  state: RunState,
  currentGitHead: string | null,
): string | null {
  // 空集合不能证明任何 Story 已被验收；否则空数组会产生一个看似有效的摘要，
  // 让正式运行把退化 PRD 误判为可以进入 Final Review。
  if (prd.userStories.length === 0) return null;
  const entries: Array<{
    storyId: string;
    blocked: boolean;
    receipt: ValidationReceipt | null;
  }> = [];
  for (const story of prd.userStories) {
    const current = storyStateOf(state, story.id);
    if (current.blocked) {
      entries.push({ storyId: story.id, blocked: true, receipt: null });
      continue;
    }
    const evaluation = evaluateValidationReceipt(story, current, currentGitHead);
    if (!evaluation.valid) return null;
    entries.push({ storyId: story.id, blocked: false, receipt: evaluation.receipt });
  }
  const canonical = JSON.stringify(entries);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** 首次有效失败后置位；没有专用升级目标时保持不变，且从不修改 retryCount。 */
export function enableEscalation(
  state: RunState,
  storyId: string,
  hasDedicatedTarget: boolean,
): { state: RunState; changed: boolean } {
  const current = state[storyId];
  if (!hasDedicatedTarget || !current || current.escalated) return { state, changed: false };
  return {
    state: { ...state, [storyId]: { ...current, escalated: true } },
    changed: true,
  };
}

export function getCurrentStoryId(prd: Prd, state: RunState): string | null {
  // 先完成所有尚无实现候选的 Story；只有这一批清空后才做最终提交上的逐 Story 重验，
  // 避免每个后续实现提交都立即重验先前 Story 导致 N²。
  for (const s of prd.userStories) {
    const st = storyStateOf(state, s.id);
    if (!st.blocked && !st.passes) return s.id;
  }
  for (const s of prd.userStories) {
    const st = storyStateOf(state, s.id);
    if (!isStoryPassed(st) && !st.blocked) return s.id;
  }
  return null;
}

export function allStoriesResolved(prd: Prd, state: RunState): boolean {
  return prd.userStories.every((s) => {
    const st = storyStateOf(state, s.id);
    return isStoryPassed(st) || st.blocked;
  });
}

// 只读合并（不落盘）：state 为 null 时回退读 story 上的旧格式字段。
// 消费方区分缺失/损坏时应先走 readDisplayState，避免损坏态复活 legacy 字段。
export function mergedStories(prd: Prd, state: RunState | null): StoryView[] {
  return prd.userStories.map((s) => ({
    ...s,
    ...(state ? storyStateOf(state, s.id) : legacyStateOf(s)),
  }));
}

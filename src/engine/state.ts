import { readFileSync, existsSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
import { join } from 'node:path';
import type { Prd, Story } from './prd.js';
import {
  parseRunStateBytes,
  type RunState,
  type StoryState,
} from '../contracts/run-state-contract.js';
import {
  acceptanceHash,
  isGitHead,
  parseValidationReceipt,
  VALIDATION_RECEIPT_SCHEMA_VERSION,
  VALIDATION_PROTOCOL_VERSION,
  type ValidationRequest,
  type ValidationReceipt,
} from '../contracts/validation-contract.js';

export {
  parseValidationReceipt,
  VALIDATION_RECEIPT_SCHEMA_VERSION,
} from '../contracts/validation-contract.js';
export type { RunState, StoryState } from '../contracts/run-state-contract.js';
export type { ValidationReceipt } from '../contracts/validation-contract.js';

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

export function tryReadState(path: string): RunState | null {
  try {
    const parsed = parseRunStateBytes(readFileSync(path));
    return parsed.ok ? parsed.value : null;
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
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const raw = (parsed as Record<string, unknown>)[storyId];
    if (raw === undefined) {
      return { validated: 'missing', validationReceipt: 'missing', escalated: 'missing' };
    }
    if (!isRecord(raw)) return null;
    const story = raw;
    const validated = story.validated === undefined ? 'missing' : story.validated;
    const rawReceipt = story.validationReceipt === undefined ? 'missing' : story.validationReceipt;
    const escalated = story.escalated === undefined ? 'missing' : story.escalated;
    if (
      (validated !== 'missing' && typeof validated !== 'boolean') ||
      (escalated !== 'missing' && typeof escalated !== 'boolean')
    )
      return null;
    let validationReceipt: ValidationReceipt | null | 'missing';
    if (rawReceipt === 'missing' || rawReceipt === null) {
      validationReceipt = rawReceipt;
    } else {
      validationReceipt = parseValidationReceipt(rawReceipt);
      if (!validationReceipt) return null;
    }
    return { validated, validationReceipt, escalated };
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
    // legacy 内嵌 passes 只能迁移为实现候选，不能补造结构化 Validator 凭证。
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
}

/**
 * status/dashboard/report 的展示状态单源：文件缺失才迁移旧版内嵌字段；
 * 文件存在但损坏时全部按未验证显示，绝不复活 legacy 通过态。
 */
export function readDisplayState(path: string, prd: Prd): DisplayStateRead {
  const stateExists = existsSync(path);
  const rawState = stateExists ? tryReadState(path) : null;
  const stateCorrupted = stateExists && rawState === null;
  return {
    state: stateCorrupted ? blankStateFor(prd) : (rawState ?? initialStateFor(prd)),
    stateCorrupted,
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

/** @deprecated 仅供旧展示兼容；正式控制流必须用 isStoryPassedAt 核对结构化凭证。 */
export function isStoryPassed(
  state: Pick<StoryState, 'passes' | 'validated' | 'blocked'>,
): boolean {
  return !state.blocked && state.passes && state.validated;
}

export type StoryValidationInvalidReason =
  | 'blocked'
  | 'missing-candidate'
  | 'not-validated'
  | 'missing-receipt'
  | 'invalid-receipt'
  | 'invalid-current-head'
  | 'head-mismatch'
  | 'acceptance-mismatch';

export type StoryValidationEvaluation =
  | { valid: true; receipt: ValidationReceipt; acceptanceHash: string }
  | {
      valid: false;
      reason: StoryValidationInvalidReason;
      receipt: ValidationReceipt | null;
      acceptanceHash: string;
    };

/** 唯一的 Story 完成当前性判断：同时绑定候选、提交、Story ID 与有序 AC。 */
export function evaluateStoryValidation(
  story: Pick<Story, 'id' | 'acceptanceCriteria'>,
  state: StoryState,
  currentGitHead: string,
): StoryValidationEvaluation {
  const expectedHash = acceptanceHash(story.id, story.acceptanceCriteria);
  const rawReceipt = state.validationReceipt ?? null;
  const receipt = rawReceipt === null ? null : parseValidationReceipt(rawReceipt);
  if (state.blocked) {
    return { valid: false, reason: 'blocked', receipt, acceptanceHash: expectedHash };
  }
  if (!state.passes) {
    return { valid: false, reason: 'missing-candidate', receipt, acceptanceHash: expectedHash };
  }
  if (!state.validated) {
    return { valid: false, reason: 'not-validated', receipt, acceptanceHash: expectedHash };
  }
  if (rawReceipt === null) {
    return { valid: false, reason: 'missing-receipt', receipt: null, acceptanceHash: expectedHash };
  }
  if (!receipt) {
    return { valid: false, reason: 'invalid-receipt', receipt: null, acceptanceHash: expectedHash };
  }
  if (!isGitHead(currentGitHead)) {
    return { valid: false, reason: 'invalid-current-head', receipt, acceptanceHash: expectedHash };
  }
  if (receipt.gitHead !== currentGitHead) {
    return { valid: false, reason: 'head-mismatch', receipt, acceptanceHash: expectedHash };
  }
  if (receipt.acceptanceHash !== expectedHash) {
    return { valid: false, reason: 'acceptance-mismatch', receipt, acceptanceHash: expectedHash };
  }
  return { valid: true, receipt, acceptanceHash: expectedHash };
}

export function isStoryPassedAt(
  story: Pick<Story, 'id' | 'acceptanceCriteria'>,
  state: StoryState,
  currentGitHead: string,
): boolean {
  return evaluateStoryValidation(story, state, currentGitHead).valid;
}

/**
 * 以当前 PRD 与 HEAD 对账全部 Story。失效只撤销引擎验收整体，保留实现候选及其他状态。
 */
export function reconcileValidationReceipts(
  prd: Prd,
  state: RunState,
  currentGitHead: string,
): { state: RunState; invalidatedStoryIds: string[] } {
  let next = state;
  const invalidatedStoryIds: string[] = [];
  for (const story of prd.userStories) {
    const current = state[story.id];
    if (!current || evaluateStoryValidation(story, current, currentGitHead).valid) continue;
    if (!current.validated && (current.validationReceipt ?? null) === null) continue;
    next = {
      ...next,
      [story.id]: { ...current, validated: false, validationReceipt: null },
    };
    invalidatedStoryIds.push(story.id);
  }
  return { state: next, invalidatedStoryIds };
}

export interface EscalatedTamper {
  expected: boolean;
  received: boolean | 'missing';
}

export interface ValidatedTamper {
  expected: boolean;
  received: boolean | 'missing';
}

export interface ValidationOwnership {
  validated: boolean;
  validationReceipt: ValidationReceipt | null;
}

export interface ObservedValidationOwnership {
  validated: boolean | 'missing';
  validationReceipt: ValidationReceipt | null | 'missing';
}

export interface ValidationOwnershipTamper {
  expected: ValidationOwnership;
  received: ObservedValidationOwnership;
}

function sameValidationReceipt(
  left: ValidationReceipt | null | 'missing',
  right: ValidationReceipt | null | 'missing',
): boolean {
  if (left === null || left === 'missing' || right === null || right === 'missing') {
    return left === right;
  }
  return (
    left.schemaVersion === right.schemaVersion &&
    left.requestId === right.requestId &&
    left.gitHead === right.gitHead &&
    left.acceptanceHash === right.acceptanceHash
  );
}

export function validationOwnershipOf(state: StoryState): ValidationOwnership {
  return {
    validated: state.validated,
    validationReceipt: state.validationReceipt ?? null,
  };
}

/** 恢复 agent 写回前的 validated + receipt 整体；任一字段变化都会整体回滚。 */
export function restoreValidationOwnership(
  state: RunState,
  storyId: string,
  expected: ValidationOwnership,
  fallback?: StoryState,
  observed?: ObservedValidationOwnership,
): { state: RunState; tamper: ValidationOwnershipTamper | null } {
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
        received: observed ?? { validated: 'missing', validationReceipt: 'missing' },
      },
    };
  }
  const received: ObservedValidationOwnership = observed ?? {
    validated: current.validated,
    validationReceipt:
      current.validationReceipt === undefined ? 'missing' : current.validationReceipt,
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

/** @deprecated 仅供旧调用兼容；新控制流必须用 restoreValidationOwnership 整体恢复。 */
export function restoreValidated(
  state: RunState,
  storyId: string,
  expected: boolean,
  fallback?: StoryState,
  observed?: boolean | 'missing',
): { state: RunState; tamper: ValidatedTamper | null } {
  const current = state[storyId];
  if (!current) {
    if (!fallback) return { state, tamper: null };
    return {
      state: { ...state, [storyId]: { ...fallback, validated: expected } },
      tamper: { expected, received: 'missing' },
    };
  }
  const received = observed ?? current.validated;
  if (received === expected) return { state, tamper: null };
  return {
    state: { ...state, [storyId]: { ...current, validated: expected } },
    tamper: { expected, received },
  };
}

/** @deprecated 旧两参数调用保留类型兼容，但不会签发无目标身份的裸布尔凭证。 */
export function issueValidationReceipt(
  state: RunState,
  storyId: string,
): { state: RunState; changed: boolean };
/** 结构化 Validator passed claim 已核对后，以本轮 request 签发持久凭证。 */
export function issueValidationReceipt(
  state: RunState,
  story: Pick<Story, 'id' | 'acceptanceCriteria'>,
  request: ValidationRequest,
): { state: RunState; changed: boolean };
export function issueValidationReceipt(
  state: RunState,
  storyOrId: string | Pick<Story, 'id' | 'acceptanceCriteria'>,
  request?: ValidationRequest,
): { state: RunState; changed: boolean } {
  // 没有 Story/AC/request 绑定就无法安全签发；兼容入口必须失败关闭。
  if (typeof storyOrId === 'string' || !request) return { state, changed: false };
  const story = storyOrId;
  const expectedHash = acceptanceHash(story.id, story.acceptanceCriteria);
  if (
    request.version !== VALIDATION_PROTOCOL_VERSION ||
    typeof request.requestId !== 'string' ||
    request.requestId.trim().length === 0 ||
    typeof request.storyId !== 'string' ||
    !Array.isArray(request.acceptanceCriteria) ||
    !request.acceptanceCriteria.every((criterion) => typeof criterion === 'string') ||
    typeof request.acceptanceHash !== 'string' ||
    !isGitHead(request.gitHead)
  ) {
    return { state, changed: false };
  }
  const requestCriteriaMatch =
    request.acceptanceCriteria.length === story.acceptanceCriteria.length &&
    request.acceptanceCriteria.every(
      (criterion, index) => criterion === story.acceptanceCriteria[index],
    );
  if (
    request.storyId !== story.id ||
    !requestCriteriaMatch ||
    request.acceptanceHash !== expectedHash ||
    acceptanceHash(request.storyId, request.acceptanceCriteria) !== request.acceptanceHash
  ) {
    return { state, changed: false };
  }
  const current = state[story.id];
  if (!current || !current.passes || current.blocked) {
    return { state, changed: false };
  }
  const receipt: ValidationReceipt = {
    schemaVersion: VALIDATION_RECEIPT_SCHEMA_VERSION,
    requestId: request.requestId,
    gitHead: request.gitHead,
    acceptanceHash: request.acceptanceHash,
  };
  if (current.validated && sameValidationReceipt(current.validationReceipt ?? null, receipt)) {
    return { state, changed: false };
  }
  return {
    state: {
      ...state,
      [story.id]: { ...current, validated: true, validationReceipt: receipt },
    },
    changed: true,
  };
}

/** 未签发凭证的 passes 不能跨轮；保留 notes/retry/blocked/escalated。 */
export function rollbackUnvalidatedPass(
  state: RunState,
  storyId: string,
): { state: RunState; changed: boolean } {
  const current = state[storyId];
  if (!current || !current.passes || current.validated || current.blocked) {
    return { state, changed: false };
  }
  return {
    state: {
      ...state,
      [storyId]: {
        ...current,
        passes: false,
        validated: false,
        validationReceipt: null,
      },
    },
    changed: true,
  };
}

/** 启动恢复：进程若在 builder 与 validator 之间中断，显式待验收 true 回写为可重试态。 */
export function rollbackUnvalidatedPasses(state: RunState): {
  state: RunState;
  storyIds: string[];
} {
  let next = state;
  const storyIds: string[] = [];
  for (const id of Object.keys(state)) {
    const rolled = rollbackUnvalidatedPass(next, id);
    if (!rolled.changed) continue;
    next = rolled.state;
    storyIds.push(id);
  }
  return { state: next, storyIds };
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

export type StorySelectionMode = 'implementation' | 'validation-only';

export interface NextStorySelection {
  storyId: string;
  mode: StorySelectionMode;
}

/**
 * 两遍选择：先完成所有缺候选项，再按 PRD 顺序重验已有候选但凭证不再当前的 Story。
 */
export function selectNextStory(
  prd: Prd,
  state: RunState,
  currentGitHead: string,
): NextStorySelection | null {
  for (const story of prd.userStories) {
    const current = storyStateOf(state, story.id);
    if (!current.blocked && !current.passes) {
      return { storyId: story.id, mode: 'implementation' };
    }
  }
  for (const story of prd.userStories) {
    const current = storyStateOf(state, story.id);
    if (!current.blocked && current.passes && !isStoryPassedAt(story, current, currentGitHead)) {
      return { storyId: story.id, mode: 'validation-only' };
    }
  }
  return null;
}

export function allStoriesResolvedAt(prd: Prd, state: RunState, currentGitHead: string): boolean {
  return prd.userStories.every((story) => {
    const current = storyStateOf(state, story.id);
    return current.blocked || isStoryPassedAt(story, current, currentGitHead);
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

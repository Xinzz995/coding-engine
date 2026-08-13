import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRouteSource } from './models.js';
import type { StoryDifficulty } from './prd.js';
import type { ValidationCheck, ValidationProtocolErrorCode } from './validation-protocol.js';
import type { WorkspaceWriter } from '../workspace-safety/session.js';
import { readStableFile } from '../workspace-safety/stable-file.js';
import type { SupervisorTerminationReason } from '../workspace-safety/supervisor-protocol.js';

export interface ValidationTargetEvidence {
  requestId: string;
  storyId: string;
  acceptanceHash: string;
  gitHead: string | null;
}

/** 引擎对一次真实 runner 子进程调用的观察；diagnosticTail 只在异常结局持久化。 */
export interface AgentInvocationEvidence {
  durationMs: number;
  exitCode: number | null;
  terminationReason?: SupervisorTerminationReason;
  diagnosticTail?: string;
}

export type LoopValidationProtocolErrorCode =
  | ValidationProtocolErrorCode
  | 'state-mutated'
  | 'candidate-not-passing'
  | 'result-cleanup-failed'
  | 'agent-aborted'
  | 'environment-unverifiable'
  | 'validator-unavailable';

export type TddEvidenceFailureCode =
  | 'invalid-config'
  | 'project-root-unreadable'
  | 'git-unavailable'
  | 'git-root-mismatch'
  | 'baseline-unreachable'
  | 'policy-file-missing'
  | 'policy-file-outside-root'
  | 'policy-file-duplicate-target'
  | 'policy-file-unreadable'
  | 'policy-hash-mismatch'
  | 'source-scan-failed'
  | 'forbidden-pattern-added'
  | 'coverage-check-failed';

export type ValidationHeadAbortPhase =
  | 'quality-check-start'
  | 'quality-check-finish'
  | 'tdd-check-start'
  | 'tdd-check-finish'
  | 'validator-start'
  | 'validator-finish';

/** 同一提交检查链因 HEAD 变化或不可读而中止的引擎观察。 */
export interface ValidationHeadAbortEvidence {
  phase: ValidationHeadAbortPhase;
  reason: 'head-changed' | 'head-unreadable';
  expectedGitHead: string | null;
  actualGitHead: string | null;
  diagnostic: string;
}

/** 单次 coding-x run 的稳定身份；用于把同轮命令事实与最终 iteration 精确关联。 */
export type EvidenceRunId = string;

const VALIDATOR_PROFILE_RESOLUTIONS = [
  'ready',
  'invalid-profile',
  'unsupported-platform',
  'unsupported-version',
  'native-boundary-incomplete',
  'canary-missing',
  'canary-binding-mismatch',
  'canary-failed',
  'runner-unobservable',
  'host-context-unverifiable',
] as const;

/** Validator 宿主隔离链的引擎机械观察（ADR-025）；bypass 测试模式与旧记录缺省。 */
export interface ValidatorProfileEvidence {
  policyVersion: string;
  resolution: (typeof VALIDATOR_PROFILE_RESOLUTIONS)[number];
  /** 受监督 `--version` 观察值；观察失败时缺省。 */
  runnerVersion?: string;
  /** raw hex profile 摘要；profile 未构建成功时缺省。 */
  profileDigest?: string;
  /** raw hex canary 证据摘要；仅 ready 时存在。 */
  canaryEvidenceDigest?: string;
  /** 引擎 canary 执行器的实际墙钟耗时；测试注入或旧记录缺省。 */
  canaryDurationMs?: number;
}

/**
 * evidence.jsonl 的记录 schema 单源（判别联合）。append-only、每行一条独立 JSON：
 * 坏行只损失自己（agent 写坏一行不毁全文件），行序即事件序。
 * source 是信任级别标记：engine=引擎机械事实；builder/validator=agent 声明
 * （.workspace/ 属 agent 可写区，engine 记录亦可被伪造——消费端呈现层负责诚实标注，
 * 防伪加固属后续评估，见 spec 信任边界）。
 */
export type EvidenceRecord =
  | {
      type: 'iteration';
      source: 'engine';
      at: string;
      iteration: number;
      storyId: string | null;
      /** v0.34 起由引擎生成；旧记录缺省时不参与跨记录归因。 */
      runId?: EvidenceRunId;
      builderRan: boolean;
      builderModel: string | null;
      validatorRan: boolean;
      validatorModel: string | null;
      skippedValidator: boolean;
      agentBlocked: boolean;
      /** agent 进程结局（异常轮语义，v0.22.0 起）；缺省=该侧未拉起或旧版本记录 */
      builderOutcome?: 'completed' | 'timeout' | 'error';
      validatorOutcome?: 'completed' | 'timeout' | 'error' | 'skipped';
      /** 实际启动的子进程调用凭证；旧记录/未启动该侧时缺省。 */
      builderInvocation?: AgentInvocationEvidence;
      validatorInvocation?: AgentInvocationEvidence;
      /** builder completed 但 state.json 与 progress.md 双无变化（空转轮） */
      noop?: true;
      /** 本轮门禁打回（细节在同轮 gate-run 记录；此处保「每轮一条 iteration」的轮语义） */
      gateRejected?: true;
      /** 本轮发生异常回写（applyAbortRollback） */
      abortRollback?: { storyId: string };
      /** 本轮未获得验收凭证，候选 passes 已回写。 */
      validationRollback?: true;
      /** 项目检查、TDD 或 Validator 边界的同一提交检查链中止原因。 */
      validationHeadAbort?: ValidationHeadAbortEvidence;
      /** validator completed 且候选结果保持通过，引擎已签发验收凭证。 */
      validationReceipt?: true;
      /** 引擎对本轮结构化协议的机械判定；旧记录/未启动 Validator 时缺省。 */
      validationProtocol?: 'passed' | 'failed' | 'invalid';
      /** 本轮引擎生成的精确目标；gitHead=null 表示产物身份不可用而非已验证。 */
      validationTarget?: ValidationTargetEvidence;
      /** invalid 的有界原因；不能与 passed/failed 同时出现。 */
      validationProtocolError?: { code: LoopValidationProtocolErrorCode; diagnostic: string };
      /** Validator 改写了 state.json；引擎已恢复调用前快照并拒绝该轮 claim。 */
      validatorStateMutation?: true;
      /** 本轮实际路由来源；旧记录缺失时消费端显示“来源未知”。 */
      builderRouteSource?: ModelRouteSource;
      validatorRouteSource?: ModelRouteSource;
      storyDifficulty?: StoryDifficulty;
      /** 本轮首次把 state.escalated 从 false 置 true 的机械原因。 */
      escalationTriggeredBy?: 'gate' | 'validator' | 'noop';
      /** validator 机械打回时的 notes 快照；有界保存，避免后续成功轮覆盖失败上下文。 */
      validatorDiagnostic?: string;
      /** Validator Runner 宿主隔离解析结果；旧记录与 bypass 测试模式缺省。 */
      validatorProfile?: ValidatorProfileEvidence;
      /** agent 对引擎独占字段的改动；引擎已恢复。 */
      stateRouteTamper?: Array<{
        /** 实际被改写的 story；旧 evidence 缺省时消费端回退 iteration.storyId。 */
        storyId?: string;
        expected: boolean;
        received: boolean | 'missing';
        side: 'builder' | 'validator';
      }>;
      /** agent 对引擎独占 validated 的改动；引擎已恢复。 */
      stateValidationTamper?: Array<{
        /** 实际被改写的 story；旧 evidence 缺省时消费端回退 iteration.storyId。 */
        storyId?: string;
        expected: boolean;
        received: boolean | 'missing';
        side: 'builder' | 'validator';
      }>;
    }
  | {
      type: 'gate-run';
      source: 'engine';
      at: string;
      iteration: number;
      storyId: string | null;
      runId?: EvidenceRunId;
      ok: boolean;
      total: number;
      ran: number;
      ms: number;
      /** 检查流程已结束，但 HEAD 复核失败，结果未进入裁决；旧记录缺省表示已采用。 */
      accepted?: false;
      failedCommand?: string;
      exitCode?: number | null;
      timedOut?: boolean;
      /** 失败命令 stdout/stderr 合并输出的尾部；有界保存。 */
      diagnosticTail?: string;
    }
  | {
      type: 'tdd-gate';
      source: 'engine';
      at: string;
      phase: 'preflight' | 'post-builder';
      iteration: number;
      storyId: string | null;
      runId?: EvidenceRunId;
      ok: boolean;
      policyOk: boolean;
      commandRan: boolean;
      ms: number;
      /** coverageCheck 的独立命令结局；旧记录缺省时从旧 failureCode 尽力还原。 */
      commandOk?: boolean;
      /** 检查流程已结束，但 HEAD 复核失败，结果未进入裁决；旧记录缺省表示已采用。 */
      accepted?: false;
      failureCode?: TddEvidenceFailureCode;
      failedCommand?: string;
      exitCode?: number | null;
      timedOut?: boolean;
      diagnosticTail?: string;
    }
  | { type: 'tamper'; source: 'engine'; at: string; iteration: number; archive: string | null }
  | {
      type: 'validation-claim';
      source: 'validator';
      at: string;
      iteration: number;
      requestId: string;
      storyId: string;
      acceptanceHash: string;
      gitHead: string | null;
      verdict: 'passed' | 'failed';
      checks: ValidationCheck[];
      summary: string;
    }
  | {
      type: 'screenshot-claim';
      source: 'builder' | 'validator';
      at: string;
      storyId: string;
      file: string;
      acIndex?: number;
      note?: string;
    };

export type ScreenshotClaim = Extract<EvidenceRecord, { type: 'screenshot-claim' }>;

export const EVIDENCE_FILE = 'evidence.jsonl';
export const EVIDENCE_READ_MAX_BYTES = 64 * 1024 * 1024;
/** 失败诊断的统一上限：生产端截尾、读取端拒绝超限，防止 agent 写入撑爆报告。 */
export const EVIDENCE_DIAGNOSTIC_CHARS = 2000;

/** 保留最接近失败点的尾部；门禁输出与 validator notes 共用同一边界。 */
export function clipEvidenceDiagnostic(value: string): string {
  let start = value.length;
  let remaining = EVIDENCE_DIAGNOSTIC_CHARS;
  while (start > 0 && remaining > 0) {
    start -= 1;
    const codeUnit = value.charCodeAt(start);
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 0) {
      const preceding = value.charCodeAt(start - 1);
      if (preceding >= 0xd800 && preceding <= 0xdbff) start -= 1;
    }
    remaining -= 1;
  }
  return value.slice(start);
}

/**
 * @deprecated 仅供激活前旧控制流与同步单元测试使用。正式控制流必须使用
 * appendEvidenceWithWriter，不得拿裸 workspace 追加业务文件。
 */
export function appendEvidence(workspace: string, record: EvidenceRecord): void {
  appendFileSync(join(workspace, EVIDENCE_FILE), JSON.stringify(record) + '\n', 'utf-8');
}

/** 由当前 owner 追加一条记录；写入失败完整向上抛。 */
export function appendEvidenceWithWriter(
  writer: WorkspaceWriter,
  record: EvidenceRecord,
): Promise<void> {
  return writer.appendFile(EVIDENCE_FILE, `${JSON.stringify(record)}\n`);
}

export interface EvidenceReadResult {
  records: EvidenceRecord[];
  /** JSON 解析失败、形状非法、未知 type 三类行的合计（消费端警示用） */
  skippedLines: number;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEvidenceRunId(value: unknown): value is EvidenceRunId {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function hasValidOptionalRunId(value: Record<string, unknown>): boolean {
  return value.runId === undefined || isEvidenceRunId(value.runId);
}

function isRouteSource(v: unknown): v is ModelRouteSource {
  return (
    v === 'cli-builder' ||
    v === 'cli-escalation' ||
    v === 'cli-validator' ||
    v === 'difficulty' ||
    v === 'escalation' ||
    v === 'validator' ||
    v === 'runner-default'
  );
}

function isBoundedDiagnostic(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  let count = 0;
  for (const _character of v) {
    count += 1;
    if (count > EVIDENCE_DIAGNOSTIC_CHARS) return false;
  }
  return true;
}

function isSupervisorTerminationReason(value: unknown): value is SupervisorTerminationReason {
  return (
    value === 'timeout' ||
    value === 'user-interrupt' ||
    value === 'parent-shutdown' ||
    value === 'output-failure'
  );
}

function isInvocationEvidence(v: unknown): v is AgentInvocationEvidence {
  return (
    isRec(v) &&
    Number.isSafeInteger(v.durationMs) &&
    (v.durationMs as number) >= 0 &&
    (v.exitCode === null || Number.isInteger(v.exitCode)) &&
    (v.terminationReason === undefined || isSupervisorTerminationReason(v.terminationReason)) &&
    (v.diagnosticTail === undefined ||
      (isBoundedDiagnostic(v.diagnosticTail) && v.diagnosticTail.length > 0))
  );
}

function isInvocationForOutcome(
  value: unknown,
  outcome: unknown,
): value is AgentInvocationEvidence {
  if (!isInvocationEvidence(value)) return false;
  if (outcome === 'completed')
    return (
      value.exitCode === 0 &&
      value.terminationReason === undefined &&
      value.diagnosticTail === undefined
    );
  if (outcome === 'timeout')
    return (
      value.exitCode === null &&
      (value.terminationReason === undefined || value.terminationReason === 'timeout')
    );
  if (outcome === 'error') {
    if (value.terminationReason === undefined) return value.exitCode !== 0;
    return value.exitCode === null && value.terminationReason !== 'timeout';
  }
  return false;
}

function isBoundedClaimText(v: unknown): v is string {
  return isBoundedDiagnostic(v) && v.trim().length > 0;
}

function isStateRouteTamper(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (item) =>
        isRec(item) &&
        (item.storyId === undefined || typeof item.storyId === 'string') &&
        typeof item.expected === 'boolean' &&
        (typeof item.received === 'boolean' || item.received === 'missing') &&
        (item.side === 'builder' || item.side === 'validator'),
    )
  );
}

function isGitHead(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v));
}

function isAcceptanceHash(v: unknown): v is string {
  return typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
}

function isValidationTarget(v: unknown): v is ValidationTargetEvidence {
  return (
    isRec(v) &&
    typeof v.requestId === 'string' &&
    v.requestId.length > 0 &&
    typeof v.storyId === 'string' &&
    v.storyId.length > 0 &&
    isAcceptanceHash(v.acceptanceHash) &&
    isGitHead(v.gitHead)
  );
}

function isValidationProtocolErrorCode(v: unknown): v is LoopValidationProtocolErrorCode {
  return (
    v === 'missing-result' ||
    v === 'unreadable-result' ||
    v === 'result-too-large' ||
    v === 'invalid-json' ||
    v === 'invalid-schema' ||
    v === 'binding-mismatch' ||
    v === 'artifact-changed' ||
    v === 'state-mutated' ||
    v === 'candidate-not-passing' ||
    v === 'result-cleanup-failed' ||
    v === 'agent-aborted' ||
    v === 'environment-unverifiable' ||
    v === 'validator-unavailable'
  );
}

function isValidationProtocolError(v: unknown): boolean {
  return isRec(v) && isValidationProtocolErrorCode(v.code) && isBoundedDiagnostic(v.diagnostic);
}

function isValidationHeadAbort(v: unknown): v is ValidationHeadAbortEvidence {
  if (
    !isRec(v) ||
    (v.phase !== 'quality-check-start' &&
      v.phase !== 'quality-check-finish' &&
      v.phase !== 'tdd-check-start' &&
      v.phase !== 'tdd-check-finish' &&
      v.phase !== 'validator-start' &&
      v.phase !== 'validator-finish') ||
    (v.reason !== 'head-changed' && v.reason !== 'head-unreadable') ||
    !isGitHead(v.expectedGitHead) ||
    !isGitHead(v.actualGitHead) ||
    !isBoundedDiagnostic(v.diagnostic) ||
    v.diagnostic.trim().length === 0
  ) {
    return false;
  }
  if (v.reason === 'head-unreadable') {
    return v.expectedGitHead === null || v.actualGitHead === null;
  }
  return (
    v.expectedGitHead !== null && v.actualGitHead !== null && v.expectedGitHead !== v.actualGitHead
  );
}

function isTddFailureCode(v: unknown): v is TddEvidenceFailureCode {
  return (
    v === 'invalid-config' ||
    v === 'project-root-unreadable' ||
    v === 'git-unavailable' ||
    v === 'git-root-mismatch' ||
    v === 'baseline-unreachable' ||
    v === 'policy-file-missing' ||
    v === 'policy-file-outside-root' ||
    v === 'policy-file-duplicate-target' ||
    v === 'policy-file-unreadable' ||
    v === 'policy-hash-mismatch' ||
    v === 'source-scan-failed' ||
    v === 'forbidden-pattern-added' ||
    v === 'coverage-check-failed'
  );
}

function isValidationChecks(v: unknown): v is ValidationCheck[] {
  return (
    Array.isArray(v) &&
    v.every(
      (check, index) =>
        isRec(check) &&
        check.acIndex === index + 1 &&
        typeof check.passed === 'boolean' &&
        isBoundedClaimText(check.evidence),
    )
  );
}

function isValidatorProfileEvidence(v: unknown): v is ValidatorProfileEvidence {
  return (
    isRec(v) &&
    typeof v.policyVersion === 'string' &&
    v.policyVersion.length > 0 &&
    v.policyVersion.length <= 200 &&
    VALIDATOR_PROFILE_RESOLUTIONS.includes(
      v.resolution as (typeof VALIDATOR_PROFILE_RESOLUTIONS)[number],
    ) &&
    (v.runnerVersion === undefined ||
      (typeof v.runnerVersion === 'string' && v.runnerVersion.length <= 200)) &&
    (v.profileDigest === undefined ||
      (typeof v.profileDigest === 'string' && /^[a-f0-9]{64}$/u.test(v.profileDigest))) &&
    (v.canaryEvidenceDigest === undefined ||
      (typeof v.canaryEvidenceDigest === 'string' &&
        /^[a-f0-9]{64}$/u.test(v.canaryEvidenceDigest))) &&
    (v.canaryDurationMs === undefined ||
      (typeof v.canaryDurationMs === 'number' &&
        Number.isFinite(v.canaryDurationMs) &&
        v.canaryDurationMs >= 0))
  );
}

// 落盘数据不直接类型断言（patterns 约定）：按 type 分支逐字段校验，未知 type 一律不认——
// 前向兼容（新版本引擎写的记录类型，旧版本消费方跳过不炸）。
function isEvidenceRecord(v: unknown): v is EvidenceRecord {
  if (!isRec(v) || typeof v.at !== 'string') return false;
  switch (v.type) {
    case 'iteration':
      return (
        v.source === 'engine' &&
        typeof v.iteration === 'number' &&
        hasValidOptionalRunId(v) &&
        (typeof v.storyId === 'string' || v.storyId === null) &&
        typeof v.builderRan === 'boolean' &&
        (typeof v.builderModel === 'string' || v.builderModel === null) &&
        typeof v.validatorRan === 'boolean' &&
        (typeof v.validatorModel === 'string' || v.validatorModel === null) &&
        typeof v.skippedValidator === 'boolean' &&
        typeof v.agentBlocked === 'boolean' &&
        (v.builderOutcome === undefined ||
          v.builderOutcome === 'completed' ||
          v.builderOutcome === 'timeout' ||
          v.builderOutcome === 'error') &&
        (v.validatorOutcome === undefined ||
          v.validatorOutcome === 'completed' ||
          v.validatorOutcome === 'timeout' ||
          v.validatorOutcome === 'error' ||
          v.validatorOutcome === 'skipped') &&
        (v.builderInvocation === undefined ||
          (v.builderRan === true &&
            isInvocationForOutcome(v.builderInvocation, v.builderOutcome))) &&
        (v.validatorInvocation === undefined ||
          (v.validatorRan === true &&
            v.validatorOutcome !== undefined &&
            v.validatorOutcome !== 'skipped' &&
            isInvocationForOutcome(v.validatorInvocation, v.validatorOutcome))) &&
        (v.noop === undefined || v.noop === true) &&
        (v.gateRejected === undefined || v.gateRejected === true) &&
        (v.abortRollback === undefined ||
          (isRec(v.abortRollback) && typeof v.abortRollback.storyId === 'string')) &&
        (v.validationRollback === undefined || v.validationRollback === true) &&
        (v.validationHeadAbort === undefined ||
          (typeof v.storyId === 'string' && isValidationHeadAbort(v.validationHeadAbort))) &&
        (v.validationReceipt === undefined || v.validationReceipt === true) &&
        !(v.validationRollback === true && v.validationReceipt === true) &&
        (v.validationProtocol === undefined ||
          v.validationProtocol === 'passed' ||
          v.validationProtocol === 'failed' ||
          v.validationProtocol === 'invalid') &&
        (v.validationTarget === undefined || isValidationTarget(v.validationTarget)) &&
        (v.validationProtocolError === undefined ||
          isValidationProtocolError(v.validationProtocolError)) &&
        (v.validationProtocolError === undefined || v.validationProtocol === 'invalid') &&
        (v.validatorStateMutation === undefined || v.validatorStateMutation === true) &&
        (v.builderRouteSource === undefined || isRouteSource(v.builderRouteSource)) &&
        (v.validatorRouteSource === undefined || isRouteSource(v.validatorRouteSource)) &&
        (v.storyDifficulty === undefined ||
          v.storyDifficulty === 'low' ||
          v.storyDifficulty === 'medium' ||
          v.storyDifficulty === 'high') &&
        (v.escalationTriggeredBy === undefined ||
          v.escalationTriggeredBy === 'gate' ||
          v.escalationTriggeredBy === 'validator' ||
          v.escalationTriggeredBy === 'noop') &&
        (v.validatorDiagnostic === undefined || isBoundedDiagnostic(v.validatorDiagnostic)) &&
        (v.validatorProfile === undefined || isValidatorProfileEvidence(v.validatorProfile)) &&
        (v.stateRouteTamper === undefined || isStateRouteTamper(v.stateRouteTamper)) &&
        (v.stateValidationTamper === undefined || isStateRouteTamper(v.stateValidationTamper))
      );
    case 'gate-run':
      return (
        v.source === 'engine' &&
        typeof v.iteration === 'number' &&
        hasValidOptionalRunId(v) &&
        (typeof v.storyId === 'string' || v.storyId === null) &&
        typeof v.ok === 'boolean' &&
        typeof v.total === 'number' &&
        typeof v.ran === 'number' &&
        typeof v.ms === 'number' &&
        (v.accepted === undefined || v.accepted === false) &&
        (v.failedCommand === undefined || typeof v.failedCommand === 'string') &&
        (v.exitCode === undefined || v.exitCode === null || typeof v.exitCode === 'number') &&
        (v.timedOut === undefined || typeof v.timedOut === 'boolean') &&
        (v.diagnosticTail === undefined || isBoundedDiagnostic(v.diagnosticTail))
      );
    case 'tdd-gate': {
      const base =
        v.source === 'engine' &&
        hasValidOptionalRunId(v) &&
        (v.phase === 'preflight' || v.phase === 'post-builder') &&
        Number.isSafeInteger(v.iteration) &&
        (v.iteration as number) >= 0 &&
        (typeof v.storyId === 'string' || v.storyId === null) &&
        typeof v.ok === 'boolean' &&
        typeof v.policyOk === 'boolean' &&
        typeof v.commandRan === 'boolean' &&
        (v.commandOk === undefined || typeof v.commandOk === 'boolean') &&
        (v.commandRan === true || v.commandOk === undefined) &&
        Number.isSafeInteger(v.ms) &&
        (v.ms as number) >= 0 &&
        (v.accepted === undefined || v.accepted === false) &&
        (v.diagnosticTail === undefined || isBoundedDiagnostic(v.diagnosticTail));
      if (!base) return false;
      if (
        v.phase === 'preflight' &&
        (v.iteration !== 0 || v.storyId !== null || v.commandRan !== false)
      ) {
        return false;
      }
      if (v.phase === 'post-builder' && (v.iteration === 0 || typeof v.storyId !== 'string')) {
        return false;
      }
      if (v.accepted === false && v.phase !== 'post-builder') {
        return false;
      }
      if (v.ok) {
        return (
          v.policyOk === true &&
          (v.phase === 'preflight' ? v.commandRan === false : v.commandRan === true) &&
          (v.commandOk === undefined || v.commandOk === true) &&
          v.failureCode === undefined &&
          v.failedCommand === undefined &&
          v.exitCode === undefined &&
          v.timedOut === undefined &&
          v.diagnosticTail === undefined
        );
      }
      const validFailure =
        isTddFailureCode(v.failureCode) &&
        typeof v.failedCommand === 'string' &&
        v.failedCommand.length > 0 &&
        (v.exitCode === null || typeof v.exitCode === 'number') &&
        typeof v.timedOut === 'boolean' &&
        isBoundedDiagnostic(v.diagnosticTail) &&
        v.diagnosticTail.length > 0;
      if (!validFailure) return false;
      if (v.phase === 'preflight') {
        return (
          v.policyOk === false &&
          v.commandRan === false &&
          v.failureCode !== 'coverage-check-failed'
        );
      }
      if (v.commandRan === false) {
        return v.policyOk === false && v.failureCode !== 'coverage-check-failed';
      }
      if (v.commandOk !== undefined) {
        if (v.commandOk === true) {
          return v.policyOk === false && v.failureCode !== 'coverage-check-failed';
        }
        return v.policyOk
          ? v.failureCode === 'coverage-check-failed'
          : v.failureCode !== 'coverage-check-failed';
      }
      return v.policyOk
        ? v.failureCode === 'coverage-check-failed'
        : v.failureCode !== 'coverage-check-failed';
    }
    case 'tamper':
      return (
        v.source === 'engine' &&
        typeof v.iteration === 'number' &&
        (typeof v.archive === 'string' || v.archive === null)
      );
    case 'validation-claim': {
      if (
        v.source !== 'validator' ||
        typeof v.iteration !== 'number' ||
        typeof v.requestId !== 'string' ||
        v.requestId.length === 0 ||
        typeof v.storyId !== 'string' ||
        v.storyId.length === 0 ||
        !isAcceptanceHash(v.acceptanceHash) ||
        !isGitHead(v.gitHead) ||
        (v.verdict !== 'passed' && v.verdict !== 'failed') ||
        !isValidationChecks(v.checks) ||
        !isBoundedClaimText(v.summary)
      )
        return false;
      const allPassed = v.checks.every((check) => check.passed);
      return (v.verdict === 'passed') === allPassed;
    }
    case 'screenshot-claim':
      return (
        (v.source === 'builder' || v.source === 'validator') &&
        typeof v.storyId === 'string' &&
        typeof v.file === 'string' &&
        (v.acIndex === undefined || typeof v.acIndex === 'number') &&
        (v.note === undefined || typeof v.note === 'string')
      );
    default:
      return false;
  }
}

/** 读全部记录；文件缺失按空处理（容错：有什么记什么）；其余 IO 故障向上抛。 */
export function readEvidence(workspace: string): EvidenceReadResult {
  const file = readStableFile(join(workspace, EVIDENCE_FILE), {
    label: EVIDENCE_FILE,
    maxBytes: EVIDENCE_READ_MAX_BYTES,
  });
  if (file.status === 'missing') return { records: [], skippedLines: 0 };
  if (file.status === 'invalid') throw new Error(file.diagnostic);
  const raw = file.bytes.toString('utf8');
  const records: EvidenceRecord[] = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isEvidenceRecord(parsed)) records.push(parsed);
      else skippedLines++;
    } catch {
      skippedLines++;
    }
  }
  return { records, skippedLines };
}

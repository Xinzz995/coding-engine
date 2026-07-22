import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRouteSource } from './models.js';
import type { StoryDifficulty } from './prd.js';

/**
 * evidence.jsonl 的记录 schema 单源（判别联合）。append-only、每行一条独立 JSON：
 * 坏行只损失自己（agent 写坏一行不毁全文件），行序即事件序。
 * source 是信任级别标记：engine=引擎机械事实；builder/validator=agent 声明
 * （.workspace/ 属 agent 可写区，engine 记录亦可被伪造——消费端呈现层负责诚实标注，
 * 防伪加固属后续评估，见 spec 信任边界）。
 */
export type EvidenceRecord =
  | { type: 'iteration'; source: 'engine'; at: string; iteration: number; storyId: string | null;
      builderRan: boolean; builderModel: string | null; validatorRan: boolean;
      validatorModel: string | null; skippedValidator: boolean; agentBlocked: boolean;
      /** agent 进程结局（异常轮语义，v0.22.0 起）；缺省=该侧未拉起或旧版本记录 */
      builderOutcome?: 'completed' | 'timeout' | 'error';
      validatorOutcome?: 'completed' | 'timeout' | 'error' | 'skipped';
      /** builder completed 但 state.json 与 progress.md 双无变化（空转轮） */
      noop?: true;
      /** 本轮门禁打回（细节在同轮 gate-run 记录；此处保「每轮一条 iteration」的轮语义） */
      gateRejected?: true;
      /** 本轮发生异常回写（applyAbortRollback） */
      abortRollback?: { storyId: string };
      /** 本轮未获得验收凭证，候选 passes 已回写。 */
      validationRollback?: true;
      /** validator completed 且候选结果保持通过，引擎已签发验收凭证。 */
      validationReceipt?: true;
      /** 本轮实际路由来源；旧记录缺失时消费端显示“来源未知”。 */
      builderRouteSource?: ModelRouteSource;
      validatorRouteSource?: ModelRouteSource;
      storyDifficulty?: StoryDifficulty;
      /** 本轮首次把 state.escalated 从 false 置 true 的机械原因。 */
      escalationTriggeredBy?: 'gate' | 'validator' | 'noop';
      /** validator 机械打回时的 notes 快照；有界保存，避免后续成功轮覆盖失败上下文。 */
      validatorDiagnostic?: string;
      /** agent 对引擎独占字段的改动；引擎已恢复。 */
      stateRouteTamper?: Array<{
        /** 实际被改写的 story；旧 evidence 缺省时消费端回退 iteration.storyId。 */
        storyId?: string;
        expected: boolean; received: boolean | 'missing'; side: 'builder' | 'validator';
      }>;
      /** agent 对引擎独占 validated 的改动；引擎已恢复。 */
      stateValidationTamper?: Array<{
        /** 实际被改写的 story；旧 evidence 缺省时消费端回退 iteration.storyId。 */
        storyId?: string;
        expected: boolean; received: boolean | 'missing'; side: 'builder' | 'validator';
      }> }
  | { type: 'gate-run'; source: 'engine'; at: string; iteration: number; storyId: string | null;
      ok: boolean; total: number; ran: number; ms: number;
      failedCommand?: string; exitCode?: number | null; timedOut?: boolean;
      /** 失败命令 stdout/stderr 合并输出的尾部；有界保存。 */
      diagnosticTail?: string }
  | { type: 'tamper'; source: 'engine'; at: string; iteration: number; archive: string | null }
  | { type: 'screenshot-claim'; source: 'builder' | 'validator'; at: string; storyId: string;
      file: string; acIndex?: number; note?: string };

export type ScreenshotClaim = Extract<EvidenceRecord, { type: 'screenshot-claim' }>;

export const EVIDENCE_FILE = 'evidence.jsonl';
/** 失败诊断的统一上限：生产端截尾、读取端拒绝超限，防止 agent 写入撑爆报告。 */
export const EVIDENCE_DIAGNOSTIC_CHARS = 2000;

/** 保留最接近失败点的尾部；门禁输出与 validator notes 共用同一边界。 */
export function clipEvidenceDiagnostic(value: string): string {
  return value.slice(-EVIDENCE_DIAGNOSTIC_CHARS);
}

/** 追加一条记录（一行 JSON）；IO 失败向上抛——调用方定语义（loop 吞错仅 warn）。 */
export function appendEvidence(workspace: string, record: EvidenceRecord): void {
  appendFileSync(join(workspace, EVIDENCE_FILE), JSON.stringify(record) + '\n', 'utf-8');
}

export interface EvidenceReadResult {
  records: EvidenceRecord[];
  /** JSON 解析失败、形状非法、未知 type 三类行的合计（消费端警示用） */
  skippedLines: number;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRouteSource(v: unknown): v is ModelRouteSource {
  return v === 'cli-builder' || v === 'cli-escalation' || v === 'cli-validator'
    || v === 'difficulty' || v === 'escalation' || v === 'validator' || v === 'runner-default';
}

function isBoundedDiagnostic(v: unknown): v is string {
  return typeof v === 'string' && v.length <= EVIDENCE_DIAGNOSTIC_CHARS;
}

function isStateRouteTamper(v: unknown): boolean {
  return Array.isArray(v) && v.every((item) => isRec(item)
    && (item.storyId === undefined || typeof item.storyId === 'string')
    && typeof item.expected === 'boolean'
    && (typeof item.received === 'boolean' || item.received === 'missing')
    && (item.side === 'builder' || item.side === 'validator'));
}

// 落盘数据不直接类型断言（patterns 约定）：按 type 分支逐字段校验，未知 type 一律不认——
// 前向兼容（新版本引擎写的记录类型，旧版本消费方跳过不炸）。
function isEvidenceRecord(v: unknown): v is EvidenceRecord {
  if (!isRec(v) || typeof v.at !== 'string') return false;
  switch (v.type) {
    case 'iteration':
      return v.source === 'engine' && typeof v.iteration === 'number'
        && (typeof v.storyId === 'string' || v.storyId === null)
        && typeof v.builderRan === 'boolean'
        && (typeof v.builderModel === 'string' || v.builderModel === null)
        && typeof v.validatorRan === 'boolean'
        && (typeof v.validatorModel === 'string' || v.validatorModel === null)
        && typeof v.skippedValidator === 'boolean'
        && typeof v.agentBlocked === 'boolean'
        && (v.builderOutcome === undefined || v.builderOutcome === 'completed' || v.builderOutcome === 'timeout' || v.builderOutcome === 'error')
        && (v.validatorOutcome === undefined || v.validatorOutcome === 'completed' || v.validatorOutcome === 'timeout' || v.validatorOutcome === 'error' || v.validatorOutcome === 'skipped')
        && (v.noop === undefined || v.noop === true)
        && (v.gateRejected === undefined || v.gateRejected === true)
        && (v.abortRollback === undefined || (isRec(v.abortRollback) && typeof v.abortRollback.storyId === 'string'))
        && (v.validationRollback === undefined || v.validationRollback === true)
        && (v.validationReceipt === undefined || v.validationReceipt === true)
        && !(v.validationRollback === true && v.validationReceipt === true)
        && (v.builderRouteSource === undefined || isRouteSource(v.builderRouteSource))
        && (v.validatorRouteSource === undefined || isRouteSource(v.validatorRouteSource))
        && (v.storyDifficulty === undefined || v.storyDifficulty === 'low' || v.storyDifficulty === 'medium' || v.storyDifficulty === 'high')
        && (v.escalationTriggeredBy === undefined || v.escalationTriggeredBy === 'gate'
          || v.escalationTriggeredBy === 'validator' || v.escalationTriggeredBy === 'noop')
        && (v.validatorDiagnostic === undefined || isBoundedDiagnostic(v.validatorDiagnostic))
        && (v.stateRouteTamper === undefined || isStateRouteTamper(v.stateRouteTamper))
        && (v.stateValidationTamper === undefined || isStateRouteTamper(v.stateValidationTamper));
    case 'gate-run':
      return v.source === 'engine' && typeof v.iteration === 'number'
        && (typeof v.storyId === 'string' || v.storyId === null)
        && typeof v.ok === 'boolean' && typeof v.total === 'number'
        && typeof v.ran === 'number' && typeof v.ms === 'number'
        && (v.failedCommand === undefined || typeof v.failedCommand === 'string')
        && (v.exitCode === undefined || v.exitCode === null || typeof v.exitCode === 'number')
        && (v.timedOut === undefined || typeof v.timedOut === 'boolean')
        && (v.diagnosticTail === undefined || isBoundedDiagnostic(v.diagnosticTail));
    case 'tamper':
      return v.source === 'engine' && typeof v.iteration === 'number'
        && (typeof v.archive === 'string' || v.archive === null);
    case 'screenshot-claim':
      return (v.source === 'builder' || v.source === 'validator')
        && typeof v.storyId === 'string' && typeof v.file === 'string'
        && (v.acIndex === undefined || typeof v.acIndex === 'number')
        && (v.note === undefined || typeof v.note === 'string');
    default:
      return false;
  }
}

/** 读全部记录；文件缺失按空处理（容错：有什么记什么）；其余 IO 故障向上抛。 */
export function readEvidence(workspace: string): EvidenceReadResult {
  let raw: string;
  try {
    raw = readFileSync(join(workspace, EVIDENCE_FILE), 'utf-8');
  } catch (err) {
    // 仅「文件不存在」是合法的空态；其余 IO 故障（EACCES/EISDIR/磁盘错误）不得
    // 伪装成「零记录」——审计信道的假阴性比报错更糟，向上抛由消费方定语义
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], skippedLines: 0 };
    throw err;
  }
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

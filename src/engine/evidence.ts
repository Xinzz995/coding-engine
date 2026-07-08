import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
      validatorModel: string | null; skippedValidator: boolean; agentBlocked: boolean }
  | { type: 'gate-run'; source: 'engine'; at: string; iteration: number; storyId: string | null;
      ok: boolean; total: number; ran: number; ms: number;
      failedCommand?: string; exitCode?: number | null; timedOut?: boolean }
  | { type: 'tamper'; source: 'engine'; at: string; iteration: number; archive: string | null }
  | { type: 'screenshot-claim'; source: 'builder' | 'validator'; at: string; storyId: string;
      file: string; acIndex?: number; note?: string };

export type ScreenshotClaim = Extract<EvidenceRecord, { type: 'screenshot-claim' }>;

export const EVIDENCE_FILE = 'evidence.jsonl';

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
        && typeof v.agentBlocked === 'boolean';
    case 'gate-run':
      return v.source === 'engine' && typeof v.iteration === 'number'
        && (typeof v.storyId === 'string' || v.storyId === null)
        && typeof v.ok === 'boolean' && typeof v.total === 'number'
        && typeof v.ran === 'number' && typeof v.ms === 'number'
        && (v.failedCommand === undefined || typeof v.failedCommand === 'string')
        && (v.exitCode === undefined || v.exitCode === null || typeof v.exitCode === 'number')
        && (v.timedOut === undefined || typeof v.timedOut === 'boolean');
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

/** 读全部记录；文件缺失按空处理（容错：有什么记什么）。 */
export function readEvidence(workspace: string): EvidenceReadResult {
  let raw: string;
  try {
    raw = readFileSync(join(workspace, EVIDENCE_FILE), 'utf-8');
  } catch {
    return { records: [], skippedLines: 0 };
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

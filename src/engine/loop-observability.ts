import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { RunResult } from './agent.js';
import {
  appendEvidence,
  clipEvidenceDiagnostic,
  type AgentInvocationEvidence,
  type EvidenceRecord,
} from './evidence.js';
import type { PrdReadResult } from './prd-guard.js';

export type AgentOutcome = 'completed' | 'timeout' | 'error';

export function readRawFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function agentOutcome(result: {
  timedOut: boolean;
  exitCode: number | null;
}): AgentOutcome {
  return result.timedOut ? 'timeout' : result.exitCode === 0 ? 'completed' : 'error';
}

export function agentInvocation(
  result: RunResult,
  outcome: AgentOutcome,
): AgentInvocationEvidence {
  const diagnostic = outcome === 'completed'
    ? ''
    : clipEvidenceDiagnostic(result.outputTail).trim();
  return {
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    ...(diagnostic ? { diagnosticTail: diagnostic } : {}),
  };
}

export function createLoopEvidenceRecorder(workspace: string): {
  record: (evidence: EvidenceRecord) => void;
  recordTamper: (read: PrdReadResult, iteration: number) => void;
} {
  let warned = false;
  const record = (evidence: EvidenceRecord) => {
    try {
      appendEvidence(workspace, evidence);
    } catch (error) {
      if (warned) return;
      warned = true;
      console.warn(
        `⚠️  evidence 记录写入失败（不影响循环）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  const recordTamper = (read: PrdReadResult, iteration: number) => {
    if (read.tamperedArchive === undefined) return;
    record({
      type: 'tamper',
      source: 'engine',
      at: new Date().toISOString(),
      iteration,
      archive: read.tamperedArchive === null ? null : basename(read.tamperedArchive),
    });
  };
  return { record, recordTamper };
}

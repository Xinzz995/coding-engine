import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  FindingSeverity,
  QualityException,
  QualityFindingDraft,
  QualityReceipt,
  QualityStatus,
  ReviewAxis,
} from './types.js';

export const QUALITY_RECEIPTS_PATH = join('quality', 'receipts.jsonl');

export function resolveFindings(
  findings: QualityFindingDraft[],
  exceptions: QualityException[],
  headSha: string,
  now: Date,
  deferrableSeverities: FindingSeverity[] = ['medium'],
): { status: QualityStatus; exceptionIds: string[] } {
  const exceptionIds: string[] = [];
  let failed = false;
  for (const finding of findings) {
    if (finding.severity === 'low') continue;
    if (finding.severity === 'critical' || finding.severity === 'high') {
      failed = true;
      continue;
    }
    if (!deferrableSeverities.includes(finding.severity)) {
      failed = true;
      continue;
    }
    const match = exceptions.find((exception) =>
      exception.findingId === finding.id
      && Date.parse(exception.expiresAt) > now.getTime()
      && (exception.headSha === undefined || exception.headSha === headSha));
    if (match) exceptionIds.push(match.id);
    else failed = true;
  }
  return {
    status: failed ? 'failed' : 'passed',
    exceptionIds: [...new Set(exceptionIds)].sort(),
  };
}

function isFinding(value: unknown): value is QualityReceipt['findings'][number] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Partial<QualityReceipt['findings'][number]>;
  return typeof item.id === 'string'
    && (item.axis === 'spec' || item.axis === 'standards' || item.axis === 'deep')
    && typeof item.headSha === 'string' && /^[0-9a-f]{40}$/i.test(item.headSha)
    && Number.isInteger(item.round) && (item.round ?? 0) > 0
    && (item.severity === 'critical' || item.severity === 'high'
      || item.severity === 'medium' || item.severity === 'low')
    && typeof item.file === 'string'
    && (item.line === null || (Number.isInteger(item.line) && (item.line ?? 0) > 0))
    && typeof item.title === 'string'
    && typeof item.evidence === 'string'
    && typeof item.source === 'string'
    && typeof item.impact === 'string'
    && typeof item.recommendation === 'string';
}

function isReceipt(value: unknown): value is QualityReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Partial<QualityReceipt>;
  return item.version === 1
    && (item.kind === 'checks' || item.kind === 'review' || item.kind === 'doctor')
    && Number.isInteger(item.round) && (item.round ?? 0) > 0
    && (item.status === 'passed' || item.status === 'failed' || item.status === 'unverifiable')
    && typeof item.at === 'string'
    && (item.reviewSummary === undefined || typeof item.reviewSummary === 'string')
    && Array.isArray(item.findings) && item.findings.every(isFinding)
    && Array.isArray(item.exceptions)
    && Array.isArray(item.errors)
    && typeof item.durationMs === 'number';
}

export function appendQualityReceipt(workspace: string, receipt: QualityReceipt): string {
  const dir = join(workspace, 'quality');
  mkdirSync(dir, { recursive: true });
  const path = join(workspace, QUALITY_RECEIPTS_PATH);
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

export function readQualityReceipts(workspace: string): {
  receipts: QualityReceipt[];
  skippedLines: number;
} {
  const path = join(workspace, QUALITY_RECEIPTS_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { receipts: [], skippedLines: 0 };
    throw error;
  }
  const receipts: QualityReceipt[] = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isReceipt(value)) receipts.push(value);
      else skippedLines++;
    } catch {
      skippedLines++;
    }
  }
  return { receipts, skippedLines };
}

export function nextReceiptRound(
  workspace: string,
  kind: QualityReceipt['kind'],
  axis?: ReviewAxis,
): number {
  const matching = readQualityReceipts(workspace).receipts.filter((receipt) =>
    receipt.kind === kind && receipt.axis === axis);
  return matching.reduce((max, receipt) => Math.max(max, receipt.round), 0) + 1;
}

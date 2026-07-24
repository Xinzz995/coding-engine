import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendQualityReceipt,
  nextReceiptRound,
  resolveFindings,
  readQualityReceipts,
} from './receipt.js';
import type { QualityException, QualityFinding, QualityReceipt } from './types.js';

function finding(severity: QualityFinding['severity'], id = `spec:${severity}`): QualityFinding {
  return {
    id,
    axis: 'spec',
    headSha: 'a'.repeat(40),
    round: 1,
    severity,
    file: 'src/app.ts',
    line: 10,
    title: 'finding',
    evidence: 'evidence',
    source: 'AC-1',
    impact: 'impact',
    recommendation: 'fix',
  };
}

function exception(overrides: Partial<QualityException> = {}): QualityException {
  return {
    id: 'EX-1',
    findingId: 'spec:medium',
    reason: 'approved delay',
    owner: 'xinzz',
    expiresAt: '2026-08-01T00:00:00.000Z',
    followUpUrl: 'https://github.com/owner/repo/issues/1',
    ...overrides,
  };
}

describe('finding resolution', () => {
  it('blocks critical/high and unexcepted medium, but not low', () => {
    expect(resolveFindings(
      [finding('critical'), finding('high'), finding('medium'), finding('low')],
      [],
      'a'.repeat(40),
      new Date('2026-07-24T00:00:00Z'),
    )).toMatchObject({ status: 'failed', exceptionIds: [] });
  });

  it('allows a medium finding only with a complete, unexpired matching exception', () => {
    expect(resolveFindings(
      [finding('medium')],
      [exception()],
      'a'.repeat(40),
      new Date('2026-07-24T00:00:00Z'),
    )).toEqual({ status: 'passed', exceptionIds: ['EX-1'] });
  });

  it.each([
    ['expired', exception({ expiresAt: '2026-07-01T00:00:00Z' })],
    ['wrong head', exception({ headSha: 'b'.repeat(40) })],
    ['wrong finding', exception({ findingId: 'other' })],
  ])('does not accept %s exceptions', (_name, value) => {
    expect(resolveFindings(
      [finding('medium')],
      [value],
      'a'.repeat(40),
      new Date('2026-07-24T00:00:00Z'),
    ).status).toBe('failed');
  });

  it('never lets a normal exception waive high severity', () => {
    expect(resolveFindings(
      [finding('high', 'spec:high')],
      [exception({ findingId: 'spec:high' })],
      'a'.repeat(40),
      new Date('2026-07-24T00:00:00Z'),
    ).status).toBe('failed');
  });
});

describe('quality receipt ledger', () => {
  it('appends rounds without overwriting history and skips malformed lines on read', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'quality-receipt-'));
    const receipt: QualityReceipt = {
      version: 1,
      kind: 'review',
      round: 1,
      status: 'passed',
      at: '2026-07-24T00:00:00.000Z',
      repository: 'owner/repo',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      contractSha256: 'c'.repeat(64),
      axis: 'spec',
      model: 'github-copilot:claude-haiku-4.5',
      modelCalls: 1,
      premiumRequests: 0.33,
      findings: [],
      exceptions: [],
      errors: [],
      durationMs: 123,
    };
    appendQualityReceipt(workspace, receipt);
    appendQualityReceipt(workspace, { ...receipt, round: 2, status: 'failed' });
    const path = join(workspace, 'quality', 'receipts.jsonl');
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(nextReceiptRound(workspace, 'review', 'spec')).toBe(3);
    const result = readQualityReceipts(workspace);
    expect(result.receipts.map((item) => item.round)).toEqual([1, 2]);
    expect(result.skippedLines).toBe(0);
  });
});

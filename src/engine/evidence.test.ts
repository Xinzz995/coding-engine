import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvidence, readEvidence, EVIDENCE_FILE, type EvidenceRecord } from './evidence.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gateRun: EvidenceRecord = {
  type: 'gate-run', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 1,
  storyId: 'US-001', ok: true, total: 2, ran: 2, ms: 1234,
};
const claim: EvidenceRecord = {
  type: 'screenshot-claim', source: 'validator', at: '2026-07-08T06:01:00.000Z',
  storyId: 'US-001', file: 'validator-us-001-pass-1.png', acIndex: 1, note: '发布后状态翻转',
};

describe('appendEvidence / readEvidence 往返', () => {
  it('追加多条后按行序读回', () => {
    const dir = ws();
    appendEvidence(dir, gateRun);
    appendEvidence(dir, claim);
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun, claim]);
    expect(r.skippedLines).toBe(0);
  });

  it('文件不存在返回空且零跳过', () => {
    expect(readEvidence(ws())).toEqual({ records: [], skippedLines: 0 });
  });

  it('非 ENOENT 的读取故障向上抛，不伪装成零记录（EISDIR）', () => {
    const dir = ws();
    mkdirSync(join(dir, EVIDENCE_FILE)); // 同名目录占位 → readFileSync 抛 EISDIR
    expect(() => readEvidence(dir)).toThrow(/EISDIR/);
  });
});

describe('readEvidence 容错', () => {
  it('坏 JSON 行跳过计数，好行照收', () => {
    const dir = ws();
    writeFileSync(join(dir, EVIDENCE_FILE), `${JSON.stringify(gateRun)}\n{ broken\n${JSON.stringify(claim)}\n`);
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun, claim]);
    expect(r.skippedLines).toBe(1);
  });

  it('未知 type 跳过（前向兼容：新版本写的类型旧消费方不炸）', () => {
    const dir = ws();
    writeFileSync(join(dir, EVIDENCE_FILE),
      `${JSON.stringify({ type: 'future-thing', source: 'engine', at: 'x' })}\n${JSON.stringify(claim)}\n`);
    const r = readEvidence(dir);
    expect(r.records).toEqual([claim]);
    expect(r.skippedLines).toBe(1);
  });

  it('已知 type 但字段形状非法跳过（逐字段守卫）', () => {
    const dir = ws();
    const bad1 = { type: 'gate-run', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 'one', storyId: null, ok: true, total: 1, ran: 1, ms: 0 };
    const bad2 = { type: 'screenshot-claim', source: 'someone-else', at: 'x', storyId: 'US-001', file: 'a.png' };
    const bad3 = { type: 'screenshot-claim', source: 'builder', at: 'x', storyId: 'US-001', file: 'a.png', acIndex: '1' };
    writeFileSync(join(dir, EVIDENCE_FILE),
      [bad1, bad2, bad3].map((b) => JSON.stringify(b)).join('\n') + '\n' + JSON.stringify(gateRun) + '\n');
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun]);
    expect(r.skippedLines).toBe(3);
  });

  it('入口守卫负例：JSON 合法但非对象（字符串/数组/null）与缺 at/at 非 string 的对象行全部计入 skippedLines', () => {
    const dir = ws();
    const badLines = [
      JSON.stringify('just a string'),
      JSON.stringify([1, 2]),
      JSON.stringify(null),
      JSON.stringify({ type: 'gate-run', source: 'engine', iteration: 1, storyId: null, ok: true, total: 1, ran: 1, ms: 0 }), // 缺 at
      JSON.stringify({ type: 'gate-run', source: 'engine', at: 12345, iteration: 1, storyId: null, ok: true, total: 1, ran: 1, ms: 0 }), // at 非 string
    ];
    writeFileSync(join(dir, EVIDENCE_FILE), badLines.join('\n') + '\n' + JSON.stringify(gateRun) + '\n');
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun]);
    expect(r.skippedLines).toBe(5);
  });

  it('空行与末尾换行不计跳过', () => {
    const dir = ws();
    writeFileSync(join(dir, EVIDENCE_FILE), `\n${JSON.stringify(gateRun)}\n\n`);
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun]);
    expect(r.skippedLines).toBe(0);
  });

  it('可选字段缺省的记录合法（claim 无 acIndex/note、gate-run 无 failed*）', () => {
    const dir = ws();
    const minimal: EvidenceRecord = {
      type: 'screenshot-claim', source: 'builder', at: '2026-07-08T06:00:00.000Z',
      storyId: 'US-002', file: 'builder-US-002-1.png',
    };
    appendEvidence(dir, minimal);
    expect(readEvidence(dir).records).toEqual([minimal]);
  });

  it('tamper 与 iteration 记录往返', () => {
    const dir = ws();
    const tamper: EvidenceRecord = { type: 'tamper', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 2, archive: 'prd.tampered-20260708-060000.json' };
    const tamperDeleted: EvidenceRecord = { type: 'tamper', source: 'engine', at: '2026-07-08T06:00:01.000Z', iteration: 2, archive: null };
    const iter: EvidenceRecord = {
      type: 'iteration', source: 'engine', at: '2026-07-08T06:02:00.000Z', iteration: 1, storyId: 'US-001',
      builderRan: true, builderModel: 'fast-m', validatorRan: true, validatorModel: null,
      skippedValidator: false, agentBlocked: false,
    };
    appendEvidence(dir, tamper);
    appendEvidence(dir, tamperDeleted);
    appendEvidence(dir, iter);
    expect(readEvidence(dir).records).toEqual([tamper, tamperDeleted, iter]);
  });

  it('exitCode:null（超时形态）的 gate-run 往返', () => {
    const dir = ws();
    const timedOutRun: EvidenceRecord = {
      type: 'gate-run', source: 'engine', at: '2026-07-08T06:05:00.000Z', iteration: 3,
      storyId: 'US-001', ok: false, total: 2, ran: 1, ms: 30000,
      failedCommand: 'npm test', exitCode: null, timedOut: true,
    };
    appendEvidence(dir, timedOutRun);
    expect(readEvidence(dir).records).toEqual([timedOutRun]);
  });
});

describe('iteration 新可选字段（异常轮语义）', () => {
  it('带 outcome/noop/gateRejected/abortRollback 的记录往返保真', () => {
    const dir = ws();
    appendEvidence(dir, {
      type: 'iteration', source: 'engine', at: '2026-07-17T10:00:00.000Z', iteration: 5,
      storyId: 'US-004', builderRan: true, builderModel: 'sonnet',
      validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
      builderOutcome: 'timeout', abortRollback: { storyId: 'US-004' },
    });
    appendEvidence(dir, {
      type: 'iteration', source: 'engine', at: '2026-07-17T10:01:00.000Z', iteration: 6,
      storyId: 'US-005', builderRan: true, builderModel: null,
      validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
      builderOutcome: 'completed', noop: true,
    });
    const recs = readEvidence(dir).records.filter((r) => r.type === 'iteration');
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ builderOutcome: 'timeout', abortRollback: { storyId: 'US-004' } });
    expect(recs[1]).toMatchObject({ noop: true, builderOutcome: 'completed' });
  });

  it('旧格式 iteration 行（无新字段）读取不受影响', () => {
    const dir = ws();
    appendEvidence(dir, {
      type: 'iteration', source: 'engine', at: '2026-07-17T10:00:00.000Z', iteration: 1,
      storyId: 'US-001', builderRan: true, builderModel: null,
      validatorRan: true, validatorModel: null, skippedValidator: false, agentBlocked: false,
    });
    const recs = readEvidence(dir).records;
    expect(recs).toHaveLength(1);
    expect((recs[0] as { noop?: true }).noop).toBeUndefined();
  });
});

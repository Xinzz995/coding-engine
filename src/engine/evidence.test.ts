import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendEvidence,
  clipEvidenceDiagnostic,
  readEvidence,
  EVIDENCE_FILE,
  type EvidenceRecord,
} from './evidence.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
});

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gateRun: EvidenceRecord = {
  type: 'gate-run',
  source: 'engine',
  at: '2026-07-08T06:00:00.000Z',
  iteration: 1,
  storyId: 'US-001',
  ok: true,
  total: 2,
  ran: 2,
  ms: 1234,
};
const claim: EvidenceRecord = {
  type: 'screenshot-claim',
  source: 'validator',
  at: '2026-07-08T06:01:00.000Z',
  storyId: 'US-001',
  file: 'validator-us-001-pass-1.png',
  acIndex: 1,
  note: '发布后状态翻转',
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

  it('范围选择记录必须同时保存模式、执行与跳过清单且数量自洽', () => {
    const dir = ws();
    const scoped: EvidenceRecord = {
      ...gateRun,
      selectionMode: 'scoped',
      selectedCheckIds: ['docs-health', 'format'],
      skippedCheckIds: ['tests'],
      selectionRequirement: { mode: 'scoped', checkIds: ['format'] },
      selectionReasons: [
        { checkId: 'docs-health', sources: ['path'] },
        { checkId: 'format', sources: ['always', 'explicit'] },
      ],
    };
    appendEvidence(dir, scoped);
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      `${JSON.stringify(scoped)}\n` +
        `${JSON.stringify({ ...scoped, selectedCheckIds: ['docs-health'] })}\n` +
        `${JSON.stringify({ ...scoped, skippedCheckIds: ['tests', 'docs-health'] })}\n` +
        `${JSON.stringify({
          ...scoped,
          selectionReasons: [
            { checkId: 'docs-health', sources: ['path'] },
            { checkId: 'format', sources: ['always'] },
          ],
        })}\n`,
    );
    expect(readEvidence(dir)).toEqual({ records: [scoped], skippedLines: 3 });
  });

  it('文件不存在返回空且零跳过', () => {
    expect(readEvidence(ws())).toEqual({ records: [], skippedLines: 0 });
  });

  it('非 ENOENT 的读取故障向上抛，不伪装成零记录（EISDIR）', () => {
    const dir = ws();
    mkdirSync(join(dir, EVIDENCE_FILE)); // 同名目录占位 → readFileSync 抛 EISDIR
    expect(() => readEvidence(dir)).toThrow(/不是独立普通文件/);
  });
});

describe('readEvidence 容错', () => {
  it('坏 JSON 行跳过计数，好行照收', () => {
    const dir = ws();
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      `${JSON.stringify(gateRun)}\n{ broken\n${JSON.stringify(claim)}\n`,
    );
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun, claim]);
    expect(r.skippedLines).toBe(1);
  });

  it('未知 type 跳过（前向兼容：新版本写的类型旧消费方不炸）', () => {
    const dir = ws();
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      `${JSON.stringify({ type: 'future-thing', source: 'engine', at: 'x' })}\n${JSON.stringify(claim)}\n`,
    );
    const r = readEvidence(dir);
    expect(r.records).toEqual([claim]);
    expect(r.skippedLines).toBe(1);
  });

  it('已知 type 但字段形状非法跳过（逐字段守卫）', () => {
    const dir = ws();
    const bad1 = {
      type: 'gate-run',
      source: 'engine',
      at: '2026-07-08T06:00:00.000Z',
      iteration: 'one',
      storyId: null,
      ok: true,
      total: 1,
      ran: 1,
      ms: 0,
    };
    const bad2 = {
      type: 'screenshot-claim',
      source: 'someone-else',
      at: 'x',
      storyId: 'US-001',
      file: 'a.png',
    };
    const bad3 = {
      type: 'screenshot-claim',
      source: 'builder',
      at: 'x',
      storyId: 'US-001',
      file: 'a.png',
      acIndex: '1',
    };
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      [bad1, bad2, bad3].map((b) => JSON.stringify(b)).join('\n') +
        '\n' +
        JSON.stringify(gateRun) +
        '\n',
    );
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
      JSON.stringify({
        type: 'gate-run',
        source: 'engine',
        iteration: 1,
        storyId: null,
        ok: true,
        total: 1,
        ran: 1,
        ms: 0,
      }), // 缺 at
      JSON.stringify({
        type: 'gate-run',
        source: 'engine',
        at: 12345,
        iteration: 1,
        storyId: null,
        ok: true,
        total: 1,
        ran: 1,
        ms: 0,
      }), // at 非 string
    ];
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      badLines.join('\n') + '\n' + JSON.stringify(gateRun) + '\n',
    );
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
      type: 'screenshot-claim',
      source: 'builder',
      at: '2026-07-08T06:00:00.000Z',
      storyId: 'US-002',
      file: 'builder-US-002-1.png',
    };
    appendEvidence(dir, minimal);
    expect(readEvidence(dir).records).toEqual([minimal]);
  });

  it('tamper 与 iteration 记录往返', () => {
    const dir = ws();
    const tamper: EvidenceRecord = {
      type: 'tamper',
      source: 'engine',
      at: '2026-07-08T06:00:00.000Z',
      iteration: 2,
      archive: 'prd.tampered-20260708-060000.json',
    };
    const tamperDeleted: EvidenceRecord = {
      type: 'tamper',
      source: 'engine',
      at: '2026-07-08T06:00:01.000Z',
      iteration: 2,
      archive: null,
    };
    const iter: EvidenceRecord = {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-08T06:02:00.000Z',
      iteration: 1,
      storyId: 'US-001',
      builderRan: true,
      builderModel: 'fast-m',
      validatorRan: true,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
    };
    appendEvidence(dir, tamper);
    appendEvidence(dir, tamperDeleted);
    appendEvidence(dir, iter);
    expect(readEvidence(dir).records).toEqual([tamper, tamperDeleted, iter]);
  });

  it('exitCode:null（超时形态）的 gate-run 往返', () => {
    const dir = ws();
    const timedOutRun: EvidenceRecord = {
      type: 'gate-run',
      source: 'engine',
      at: '2026-07-08T06:05:00.000Z',
      iteration: 3,
      storyId: 'US-001',
      ok: false,
      total: 2,
      ran: 1,
      ms: 30000,
      failedCommand: 'npm test',
      exitCode: null,
      timedOut: true,
    };
    appendEvidence(dir, timedOutRun);
    expect(readEvidence(dir).records).toEqual([timedOutRun]);
  });

  it('门禁与 validator 的有界失败诊断往返保真', () => {
    const dir = ws();
    const gateDiagnostic: EvidenceRecord = {
      type: 'gate-run',
      source: 'engine',
      at: '2026-07-22T10:00:00.000Z',
      iteration: 4,
      storyId: 'US-001',
      ok: false,
      total: 1,
      ran: 1,
      ms: 50,
      failedCommand: 'npm test',
      exitCode: 1,
      timedOut: false,
      diagnosticTail: 'FAIL test_x\nExpected 1, received 2',
    };
    const validatorDiagnostic: EvidenceRecord = {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-22T10:01:00.000Z',
      iteration: 5,
      storyId: 'US-001',
      builderRan: true,
      builderModel: null,
      validatorRan: true,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
      builderOutcome: 'completed',
      validatorOutcome: 'completed',
      validatorDiagnostic: 'AC 2 未通过：响应码应为 401',
    };
    appendEvidence(dir, gateDiagnostic);
    appendEvidence(dir, validatorDiagnostic);
    expect(readEvidence(dir)).toEqual({
      records: [gateDiagnostic, validatorDiagnostic],
      skippedLines: 0,
    });
  });

  it('拒绝非字符串或超过 2000 字符的失败诊断，避免 agent 写入撑爆报告', () => {
    const dir = ws();
    const iteration = {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-22T10:01:00.000Z',
      iteration: 5,
      storyId: 'US-001',
      builderRan: true,
      builderModel: null,
      validatorRan: true,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
    };
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      [
        { ...gateRun, diagnosticTail: 42 },
        { ...gateRun, diagnosticTail: 'x'.repeat(2001) },
        { ...iteration, validatorDiagnostic: { message: 'bad' } },
        { ...iteration, validatorDiagnostic: 'x'.repeat(2001) },
        { ...gateRun, diagnosticTail: 'x'.repeat(2000) },
        { ...iteration, validatorDiagnostic: 'x'.repeat(2000) },
      ]
        .map((v) => JSON.stringify(v))
        .join('\n') + '\n',
    );
    const result = readEvidence(dir);
    expect(result.skippedLines).toBe(4);
    expect(result.records).toHaveLength(2);
  });

  it('按 Unicode 字符而不是 UTF-16 单元截取诊断，不切断代理对', () => {
    const clipped = clipEvidenceDiagnostic(`prefix-${'🙂'.repeat(2000)}终`);
    expect(Array.from(clipped)).toHaveLength(2000);
    expect(clipped).toBe(`${'🙂'.repeat(1999)}终`);
    expect(clipped).not.toContain('�');

    const dir = ws();
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      `${JSON.stringify({ ...gateRun, diagnosticTail: '🙂'.repeat(2000) })}\n` +
        `${JSON.stringify({ ...gateRun, diagnosticTail: '🙂'.repeat(2001) })}\n`,
    );
    expect(readEvidence(dir)).toMatchObject({ skippedLines: 1, records: [{ type: 'gate-run' }] });
  });
});

describe('iteration 新可选字段（异常轮语义）', () => {
  it('带 outcome/noop/gateRejected/abortRollback 的记录往返保真', () => {
    const dir = ws();
    appendEvidence(dir, {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-17T10:00:00.000Z',
      iteration: 5,
      storyId: 'US-004',
      builderRan: true,
      builderModel: 'sonnet',
      validatorRan: false,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
      builderOutcome: 'timeout',
      abortRollback: { storyId: 'US-004' },
    });
    appendEvidence(dir, {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-17T10:01:00.000Z',
      iteration: 6,
      storyId: 'US-005',
      builderRan: true,
      builderModel: null,
      validatorRan: false,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
      builderOutcome: 'completed',
      noop: true,
    });
    const recs = readEvidence(dir).records.filter((r) => r.type === 'iteration');
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({
      builderOutcome: 'timeout',
      abortRollback: { storyId: 'US-004' },
    });
    expect(recs[1]).toMatchObject({ noop: true, builderOutcome: 'completed' });
  });

  it('旧格式 iteration 行（无新字段）读取不受影响', () => {
    const dir = ws();
    appendEvidence(dir, {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-17T10:00:00.000Z',
      iteration: 1,
      storyId: 'US-001',
      builderRan: true,
      builderModel: null,
      validatorRan: true,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
    });
    const recs = readEvidence(dir).records;
    expect(recs).toHaveLength(1);
    expect((recs[0] as { noop?: true }).noop).toBeUndefined();
  });

  it('模型路由来源、升级触发与所有权篡改往返保真', () => {
    const dir = ws();
    appendEvidence(dir, {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-21T10:00:00.000Z',
      iteration: 7,
      storyId: 'US-007',
      builderRan: true,
      builderModel: 'esc-m',
      validatorRan: true,
      validatorModel: 'val-m',
      skippedValidator: false,
      agentBlocked: false,
      builderRouteSource: 'escalation',
      validatorRouteSource: 'validator',
      storyDifficulty: 'high',
      escalationTriggeredBy: 'validator',
      stateRouteTamper: [
        { expected: false, received: true, side: 'builder' },
        { expected: true, received: 'missing', side: 'validator' },
      ],
    });
    expect(readEvidence(dir).records[0]).toMatchObject({
      builderRouteSource: 'escalation',
      validatorRouteSource: 'validator',
      storyDifficulty: 'high',
      escalationTriggeredBy: 'validator',
      stateRouteTamper: [
        { expected: false, received: true, side: 'builder' },
        { expected: true, received: 'missing', side: 'validator' },
      ],
    });
  });

  it('验收凭证、未验收回写与 validated 所有权篡改往返保真', () => {
    const dir = ws();
    appendEvidence(dir, {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-22T10:00:00.000Z',
      iteration: 8,
      storyId: 'US-008',
      builderRan: true,
      builderModel: null,
      validatorRan: true,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
      validationReceipt: true,
    });
    appendEvidence(dir, {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-22T10:01:00.000Z',
      iteration: 9,
      storyId: 'US-009',
      builderRan: true,
      builderModel: null,
      validatorRan: false,
      validatorModel: null,
      skippedValidator: true,
      agentBlocked: false,
      validationRollback: true,
      stateValidationTamper: [
        { storyId: 'US-010', expected: false, received: true, side: 'builder' },
        { expected: false, received: 'missing', side: 'validator' },
      ],
    });
    expect(readEvidence(dir).records[0]).toMatchObject({
      validationReceipt: true,
    });
    expect(readEvidence(dir).records[1]).toMatchObject({
      validationRollback: true,
      stateValidationTamper: [
        { storyId: 'US-010', expected: false, received: true, side: 'builder' },
        { expected: false, received: 'missing', side: 'validator' },
      ],
    });
  });

  it('rejects non-true receipt flags and malformed validated tamper entries', () => {
    const dir = ws();
    const base = {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-22T10:00:00.000Z',
      iteration: 1,
      storyId: 'US-001',
      builderRan: true,
      builderModel: null,
      validatorRan: false,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
    };
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      [
        { ...base, validationReceipt: false },
        { ...base, validationRollback: 'yes' },
        { ...base, validationReceipt: true, validationRollback: true },
        { ...base, stateValidationTamper: [{ expected: false, received: 1, side: 'builder' }] },
        {
          ...base,
          stateValidationTamper: [{ storyId: 7, expected: false, received: true, side: 'builder' }],
        },
      ]
        .map((v) => JSON.stringify(v))
        .join('\n') + '\n',
    );
    expect(readEvidence(dir)).toEqual({ records: [], skippedLines: 5 });
  });
});

describe('结构化 Validator claim 与协议判定证据', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const head = 'b'.repeat(40);

  it('区分 validator claim 与 engine protocol/receipt 事实', () => {
    const dir = ws();
    const validationClaim: EvidenceRecord = {
      type: 'validation-claim',
      source: 'validator',
      at: '2026-07-22T11:00:00.000Z',
      iteration: 3,
      requestId: 'request-3',
      storyId: 'US-003',
      acceptanceHash: hash,
      gitHead: head,
      verdict: 'passed',
      checks: [{ acIndex: 1, passed: true, evidence: 'npm test exit 0' }],
      summary: 'AC 1 通过',
    };
    const iteration: EvidenceRecord = {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-22T11:00:01.000Z',
      iteration: 3,
      storyId: 'US-003',
      builderRan: true,
      builderModel: null,
      validatorRan: true,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
      validationProtocol: 'passed',
      validationTarget: {
        requestId: 'request-3',
        storyId: 'US-003',
        acceptanceHash: hash,
        gitHead: head,
      },
      validationReceipt: true,
    };
    appendEvidence(dir, validationClaim);
    appendEvidence(dir, iteration);

    expect(readEvidence(dir)).toEqual({ records: [validationClaim, iteration], skippedLines: 0 });
  });

  it('保留 invalid 原因和显式 unavailable Git identity', () => {
    const dir = ws();
    const iteration: EvidenceRecord = {
      type: 'iteration',
      source: 'engine',
      at: '2026-07-22T11:01:00.000Z',
      iteration: 4,
      storyId: 'US-004',
      builderRan: true,
      builderModel: null,
      validatorRan: true,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
      validationProtocol: 'invalid',
      validationTarget: {
        requestId: 'request-4',
        storyId: 'US-004',
        acceptanceHash: hash,
        gitHead: null,
      },
      validationProtocolError: { code: 'state-mutated', diagnostic: 'Validator 修改了 state.json' },
      validatorStateMutation: true,
      validationRollback: true,
    };
    appendEvidence(dir, iteration);
    expect(readEvidence(dir).records).toEqual([iteration]);
  });

  it('拒绝 claim 结论矛盾、空证据及错误的 protocol error 组合', () => {
    const dir = ws();
    const baseClaim = {
      type: 'validation-claim',
      source: 'validator',
      at: 'x',
      iteration: 1,
      requestId: 'r',
      storyId: 'US-001',
      acceptanceHash: hash,
      gitHead: head,
      verdict: 'passed',
      checks: [{ acIndex: 1, passed: true, evidence: 'ok' }],
      summary: 'ok',
    };
    const baseIteration = {
      type: 'iteration',
      source: 'engine',
      at: 'x',
      iteration: 1,
      storyId: 'US-001',
      builderRan: true,
      builderModel: null,
      validatorRan: true,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
    };
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      [
        { ...baseClaim, checks: [{ acIndex: 1, passed: false, evidence: 'failed' }] },
        { ...baseClaim, checks: [{ acIndex: 1, passed: true, evidence: '' }] },
        {
          ...baseIteration,
          validationProtocol: 'passed',
          validationProtocolError: { code: 'invalid-json', diagnostic: 'bad' },
        },
        {
          ...baseIteration,
          validationProtocol: 'invalid',
          validationProtocolError: { code: 'unknown', diagnostic: 'bad' },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    );

    expect(readEvidence(dir)).toEqual({ records: [], skippedLines: 4 });
  });
});

describe('TDD 门禁证据', () => {
  it('保留启动预检与每轮最终门禁的机械结局', () => {
    const dir = ws();
    const preflight: EvidenceRecord = {
      type: 'tdd-gate',
      source: 'engine',
      at: '2026-07-23T01:00:00.000Z',
      phase: 'preflight',
      iteration: 0,
      storyId: null,
      ok: true,
      policyOk: true,
      commandRan: false,
      ms: 12,
    };
    const failed: EvidenceRecord = {
      type: 'tdd-gate',
      source: 'engine',
      at: '2026-07-23T01:01:00.000Z',
      phase: 'post-builder',
      iteration: 1,
      storyId: 'US-001',
      ok: false,
      policyOk: true,
      commandRan: true,
      ms: 420,
      failureCode: 'coverage-check-failed',
      failedCommand: 'npm run coverage',
      exitCode: 7,
      timedOut: false,
      diagnosticTail: 'lines 88% < 90%',
    };
    const policyAfterCommand: EvidenceRecord = {
      type: 'tdd-gate',
      source: 'engine',
      at: '2026-07-23T01:02:00.000Z',
      phase: 'post-builder',
      iteration: 2,
      storyId: 'US-001',
      ok: false,
      policyOk: false,
      commandRan: true,
      ms: 430,
      failureCode: 'policy-hash-mismatch',
      failedCommand: '[tdd-policy]',
      exitCode: null,
      timedOut: false,
      diagnosticTail: '覆盖命令后政策文件发生变化',
    };
    appendEvidence(dir, preflight);
    appendEvidence(dir, failed);
    appendEvidence(dir, policyAfterCommand);
    expect(readEvidence(dir)).toEqual({
      records: [preflight, failed, policyAfterCommand],
      skippedLines: 0,
    });
  });

  it('拒绝自相矛盾或超限的 TDD 门禁记录', () => {
    const dir = ws();
    const base = {
      type: 'tdd-gate',
      source: 'engine',
      at: 'x',
      phase: 'post-builder',
      iteration: 1,
      storyId: 'US-001',
      ok: false,
      policyOk: true,
      commandRan: true,
      ms: 1,
      failureCode: 'coverage-check-failed',
      failedCommand: 'npm test',
      exitCode: 1,
      timedOut: false,
    };
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      [
        { ...base, ok: true },
        { ...base, phase: 'unknown' },
        { ...base, policyOk: true, commandRan: false },
        { ...base, policyOk: false, commandRan: true, failureCode: 'coverage-check-failed' },
        { ...base, commandOk: true, failureCode: 'source-scan-failed' },
        { ...base, commandOk: false, policyOk: false },
        { ...base, diagnosticTail: 'x'.repeat(2001) },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    );
    expect(readEvidence(dir)).toEqual({ records: [], skippedLines: 7 });
  });
});

describe('同一提交检查链中止证据', () => {
  const head1 = 'a'.repeat(40);
  const head2 = 'b'.repeat(40);
  const runId = '11111111-1111-4111-8111-111111111111';
  const iteration = {
    type: 'iteration',
    source: 'engine',
    at: '2026-08-02T01:00:00.000Z',
    iteration: 2,
    runId,
    storyId: 'US-001',
    builderRan: false,
    builderModel: null,
    validatorRan: false,
    validatorModel: null,
    skippedValidator: false,
    agentBlocked: false,
  } as const;

  it('往返保留变化与不可读两类中止，并保留未采用的命令事实', () => {
    const dir = ws();
    const changed: EvidenceRecord = {
      ...iteration,
      validationHeadAbort: {
        phase: 'quality-check-finish',
        reason: 'head-changed',
        expectedGitHead: head1,
        actualGitHead: head2,
        diagnostic: '项目检查后 HEAD 变化',
      },
    };
    const unreadable: EvidenceRecord = {
      ...iteration,
      iteration: 3,
      validationHeadAbort: {
        phase: 'validator-start',
        reason: 'head-unreadable',
        expectedGitHead: head2,
        actualGitHead: null,
        diagnostic: 'Validator 前无法读取 HEAD',
      },
    };
    const unacceptedGate: EvidenceRecord = { ...gateRun, runId, accepted: false };
    const unacceptedTdd: EvidenceRecord = {
      type: 'tdd-gate',
      source: 'engine',
      at: '2026-08-02T01:01:00.000Z',
      phase: 'post-builder',
      iteration: 2,
      storyId: 'US-001',
      ok: true,
      runId,
      policyOk: true,
      commandRan: true,
      commandOk: true,
      ms: 10,
      accepted: false,
    };
    const unacceptedBeforeCommand: EvidenceRecord = {
      type: 'tdd-gate',
      source: 'engine',
      at: '2026-08-02T01:02:00.000Z',
      phase: 'post-builder',
      iteration: 4,
      storyId: 'US-001',
      ok: false,
      runId,
      policyOk: false,
      commandRan: false,
      ms: 10,
      accepted: false,
      failureCode: 'policy-hash-mismatch',
      failedCommand: '[tdd-policy]',
      exitCode: null,
      timedOut: false,
      diagnosticTail: '政策预检失败',
    };
    for (const record of [
      changed,
      unreadable,
      unacceptedGate,
      unacceptedTdd,
      unacceptedBeforeCommand,
    ]) {
      appendEvidence(dir, record);
    }
    expect(readEvidence(dir)).toEqual({
      records: [changed, unreadable, unacceptedGate, unacceptedTdd, unacceptedBeforeCommand],
      skippedLines: 0,
    });
  });

  it('拒绝错误原因、非法身份、无界诊断与 accepted=true', () => {
    const dir = ws();
    const abort = {
      phase: 'quality-check-finish',
      reason: 'head-changed',
      expectedGitHead: head1,
      actualGitHead: head2,
      diagnostic: 'changed',
    };
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      [
        { ...iteration, validationHeadAbort: { ...abort, phase: 'unknown' } },
        { ...iteration, validationHeadAbort: { ...abort, reason: 'head-unreadable' } },
        { ...iteration, validationHeadAbort: { ...abort, actualGitHead: head1 } },
        { ...iteration, validationHeadAbort: { ...abort, diagnostic: '' } },
        { ...iteration, validationHeadAbort: { ...abort, diagnostic: 'x'.repeat(2001) } },
        { ...iteration, storyId: null, validationHeadAbort: abort },
        { ...iteration, runId: 'not-a-uuid', validationHeadAbort: abort },
        { ...gateRun, accepted: true },
        {
          type: 'tdd-gate',
          source: 'engine',
          at: 'x',
          phase: 'post-builder',
          iteration: 1,
          storyId: 'US-001',
          ok: true,
          policyOk: true,
          commandRan: true,
          ms: 1,
          accepted: true,
        },
        {
          type: 'tdd-gate',
          source: 'engine',
          at: 'x',
          phase: 'preflight',
          iteration: 0,
          storyId: null,
          ok: true,
          policyOk: true,
          commandRan: false,
          ms: 1,
          accepted: false,
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    );
    expect(readEvidence(dir)).toEqual({ records: [], skippedLines: 10 });
  });

  it('显式保留 coverage 命令失败，即使外层状态保护覆盖了总失败原因', () => {
    const dir = ws();
    const record: EvidenceRecord = {
      type: 'tdd-gate',
      source: 'engine',
      at: '2026-08-02T02:00:00.000Z',
      runId,
      phase: 'post-builder',
      iteration: 5,
      storyId: 'US-001',
      ok: false,
      policyOk: false,
      commandRan: true,
      commandOk: false,
      ms: 10,
      failureCode: 'source-scan-failed',
      failedCommand: '[state-ownership]',
      exitCode: null,
      timedOut: false,
      diagnosticTail: '状态被恢复',
    };
    appendEvidence(dir, record);
    expect(readEvidence(dir)).toEqual({ records: [record], skippedLines: 0 });
  });
});

describe('Agent 调用凭证', () => {
  const base = {
    type: 'iteration',
    source: 'engine',
    at: '2026-07-22T10:40:23.145Z',
    iteration: 1,
    storyId: 'US-001',
    builderRan: true,
    builderModel: null,
    validatorRan: false,
    validatorModel: null,
    skippedValidator: false,
    agentBlocked: false,
    builderOutcome: 'error',
  } as const;

  it('保留 402 的退出码、耗时和有界诊断', () => {
    const dir = ws();
    const iteration: EvidenceRecord = {
      ...base,
      builderInvocation: {
        durationMs: 4571,
        exitCode: 1,
        diagnosticTail: 'API Error: 402 Account overdue',
      },
    };
    appendEvidence(dir, iteration);
    expect(readEvidence(dir)).toEqual({ records: [iteration], skippedLines: 0 });
  });

  it('保留输出通道失败的机械终止原因', () => {
    const dir = ws();
    const iteration: EvidenceRecord = {
      ...base,
      builderInvocation: {
        durationMs: 812,
        exitCode: null,
        terminationReason: 'output-failure',
        diagnosticTail: 'builder output before transport failure',
      },
    };
    appendEvidence(dir, iteration);
    expect(readEvidence(dir)).toEqual({ records: [iteration], skippedLines: 0 });
  });

  it('拒绝负耗时、超限诊断、错误终止原因、未运行侧凭证和成功结局诊断', () => {
    const dir = ws();
    writeFileSync(
      join(dir, EVIDENCE_FILE),
      [
        { ...base, builderInvocation: { durationMs: -1, exitCode: 1 } },
        {
          ...base,
          builderInvocation: { durationMs: 1, exitCode: 1, diagnosticTail: 'x'.repeat(2001) },
        },
        { ...base, validatorInvocation: { durationMs: 1, exitCode: 1 } },
        {
          ...base,
          builderOutcome: 'completed',
          builderInvocation: { durationMs: 1, exitCode: 0, diagnosticTail: 'success transcript' },
        },
        { ...base, builderOutcome: 'completed', builderInvocation: { durationMs: 1, exitCode: 1 } },
        { ...base, builderOutcome: 'timeout', builderInvocation: { durationMs: 1, exitCode: 1 } },
        {
          ...base,
          builderInvocation: { durationMs: 1, exitCode: null, terminationReason: 'unknown' },
        },
        {
          ...base,
          builderOutcome: 'completed',
          builderInvocation: { durationMs: 1, exitCode: 0, terminationReason: 'output-failure' },
        },
        {
          ...base,
          builderOutcome: 'timeout',
          builderInvocation: { durationMs: 1, exitCode: null, terminationReason: 'output-failure' },
        },
        {
          ...base,
          builderInvocation: { durationMs: 1, exitCode: 137, terminationReason: 'output-failure' },
        },
        {
          ...base,
          builderInvocation: { durationMs: 1, exitCode: 1, terminationReason: 'user-interrupt' },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    );
    expect(readEvidence(dir)).toEqual({ records: [], skippedLines: 11 });
  });
});

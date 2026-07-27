import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './evidence.js';
import { setup, story, runLoop, fakeCounting } from './loop-test-support.js';

describe('runLoop evidence records', () => {
  it('writes gate-run (pass) and iteration records for a completing run', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 5,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
      });
      expect(code).toBe(0);
      const { records, skippedLines } = readEvidence(workspace);
      expect(skippedLines).toBe(0);
      const gateRuns = records.filter((r) => r.type === 'gate-run');
      expect(gateRuns).toHaveLength(1);
      expect(gateRuns[0]).toMatchObject({
        source: 'engine',
        iteration: 1,
        storyId: 'US-001',
        ok: true,
        total: 1,
        ran: 1,
      });
      const iters = records.filter((r) => r.type === 'iteration');
      expect(iters).toHaveLength(1);
      expect(iters[0]).toMatchObject({
        source: 'engine',
        iteration: 1,
        storyId: 'US-001',
        builderRan: true,
        validatorRan: true,
        skippedValidator: false,
        agentBlocked: false,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes a failing gate-run and a gateRejected iteration record for the rolled-back round', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const { fake } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 1,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
      });
      expect(code).toBe(1);
      const { records } = readEvidence(workspace);
      const gateRuns = records.filter((r) => r.type === 'gate-run');
      expect(gateRuns).toHaveLength(1);
      expect(gateRuns[0]).toMatchObject({
        ok: false,
        total: 1,
        ran: 1,
        failedCommand: 'node -e "console.error(\'gate-boom\'); process.exit(7)"',
        exitCode: 7,
        timedOut: false,
        diagnosticTail: 'gate-boom',
      });
      // 每轮一条 iteration 不变式（Task 5）：打回轮 continue 前补记录，不再是空洞
      const iters = records.filter((r) => r.type === 'iteration');
      expect(iters).toHaveLength(1);
      expect(iters[0]).toMatchObject({
        gateRejected: true,
        validatorOutcome: 'skipped',
        validatorRan: false,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('保留 validator 打回 notes，即使成功重试已清空当前 state', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-diagnostic.mjs');
    const calls = join(workspace, 'diagnostic-calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const callsPath = ${JSON.stringify(calls)};
      const count = existsSync(callsPath) ? Number(readFileSync(callsPath, 'utf-8')) + 1 : 1;
      writeFileSync(callsPath, String(count));
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (count === 1 || count === 3) {
        state['US-001'].passes = true;
        state['US-001'].notes = '';
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder progress ' + count + '\\n');
      } else if (count === 2) {
        state['US-001'].passes = false;
        state['US-001'].retryCount += 1;
        state['US-001'].notes = '首轮失败：test_signature\\nexpected 401 <script>alert(1)</script>';
      }
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 2,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(0);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001'].notes).toBe('');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations).toHaveLength(2);
      expect(iterations[0]).toMatchObject({
        validatorOutcome: 'completed',
        validatorDiagnostic: '首轮失败：test_signature\nexpected 401 <script>alert(1)</script>',
      });
      expect(iterations[1]).not.toHaveProperty('validatorDiagnostic');
      const report = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(report).toContain('首轮失败：test_signature');
      expect(report).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(report).not.toContain('<script>alert(1)</script>');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes a tamper record with the archive filename when builder tampers prd.json', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-tamper-ev.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync, readFileSync, existsSync } from 'node:fs';
      // 只在 prd 未被篡改过时篡改一次，然后翻绿收敛
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      if (prd.project !== 'evil') {
        prd.project = 'evil';
        writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      }
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 2,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
      });
      expect(code).toBe(0);
      const { records } = readEvidence(workspace);
      const tampers = records.filter((r) => r.type === 'tamper');
      expect(tampers).toHaveLength(1); // 同内容去重：只记新事件
      expect(tampers[0].archive).toMatch(/^prd\.tampered-.*\.json$/); // 文件名而非路径
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

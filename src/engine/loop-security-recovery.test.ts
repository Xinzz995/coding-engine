import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './evidence.js';
import { setup, story, runLoop } from './loop-test-support.js';

describe('runLoop prd freeze', () => {
  it('builder 删除 qualityChecks 也架空不了门禁：文件被恢复、门禁照跑照打回', async () => {
    // 漏洞路径：builder 改写 prd.json 删掉 qualityChecks → 下轮门禁静默失效。
    // 修复后：builder 之后的检测点恢复文件，门禁按快照命令执行、失败打回并跳过 validator。
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const prdPath = join(workspace, 'prd.json');
    const original = readFileSync(prdPath, 'utf-8');
    const fake = join(workspace, 'fake-tamper.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(
      fake,
      `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      delete prd.qualityChecks;
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      // progress.md 留痕：这轮的 tamper 只碰了 prd.json，state/progress 双静止会被
      // Task 5 的 no-op 检测提前跳过门禁，抹掉本用例要验的“门禁按快照命令执行”。
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'x');
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
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
      // 门禁没有被架空：按快照命令执行并打回
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].notes).toContain('[门禁失败 - 第1次]');
      expect(state['US-001'].notes).toContain('gate-boom');
      // 门禁失败跳过 validator：stub 只被调了一次（builder）
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      // 磁盘被恢复为原版、篡改版被存档
      expect(readFileSync(prdPath, 'utf-8')).toBe(original);
      const archived = readdirSync(workspace).filter((f) => f.startsWith('prd.tampered-'));
      expect(archived).toHaveLength(1);
      expect(warns.some((w) => w.includes('检测到 prd.json 在运行期被修改'))).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('builder 改弱 AC 后 validator 读到的磁盘已是恢复的原版', async () => {
    // validator 是独立进程直读磁盘——第四检测点（builder 后）必须先恢复文件。
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['原始验收标准'] })]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-weaken.mjs');
    const calls = join(workspace, 'calls.txt');
    const seenByValidator = join(workspace, 'validator-saw.json');
    writeFileSync(
      fake,
      `
      import { writeFileSync, readFileSync, appendFileSync, existsSync, copyFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const n = readFileSync(${JSON.stringify(calls)}, 'utf-8').trim().split('\\n').length;
      if (n === 1) {
        // builder：改弱 AC 并翻绿
        const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
        prd.userStories[0].acceptanceCriteria = ['被改弱的标准'];
        writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
        writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        }));
      } else {
        // validator：记录此刻磁盘上的 prd.json（它验收时读到的东西）
        copyFileSync(${JSON.stringify(prdPath)}, ${JSON.stringify(seenByValidator)});
      }
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
      expect(code).toBe(0); // builder 翻绿、validator 跑过、完成判定放行
      const saw = JSON.parse(readFileSync(seenByValidator, 'utf-8'));
      expect(saw.userStories[0].acceptanceCriteria).toEqual(['原始验收标准']); // 不是被改弱的
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('删 story 骗不过完成判定：完成判定用快照，未完成照样跑满返回 1', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-drop.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      prd.userStories = []; // 删光 story：若完成判定读磁盘会误判全绿提前 exit 0
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      // 只碰 prd.json、不碰 state/progress 会被 Task 5 的 no-op 检测提前 continue，
      // 完成判定压根不会跑到——留痕 progress.md 保住本用例要测的完成判定代码路径。
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'x');
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
      expect(code).toBe(1); // story 从未通过，不被空列表骗成 0
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('写回失败的轮次跳过 validator，结束摘要报告篡改', async () => {
    // builder 删 prd.json 并在原路径建同名目录：读抛 EISDIR（按删除篡改）、写回时 tmp 写入成功、rename 到目录路径抛 EISDIR（恢复失败）。
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-break.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(
      fake,
      `
      import { appendFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      if (existsSync(${JSON.stringify(prdPath)})) {
        unlinkSync(${JSON.stringify(prdPath)});
        mkdirSync(${JSON.stringify(prdPath)});
      }
      // state/progress 双静止会被 Task 5 的 no-op 检测提前 continue，跳过本用例要测的
      // 门禁前检测点（正是发现写回失败、跳过 validator 的那一步）——留痕 progress.md 保住它。
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'x');
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
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
      expect(code).toBe(2);
      // 写回失败 → 本轮 validator 被跳过：stub 只跑了一次
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      expect(warns.some((w) => w.includes('快照写回失败'))).toBe(true);
      expect(warns.some((w) => w.includes('跳过本轮 validator'))).toBe(true);
      // 结束摘要报告篡改事件
      expect(warns.some((w) => w.includes('运行期间检测到 prd.json 被修改'))).toBe(true);
      // C3（triage 8）：删除类篡改（读回抛 EISDIR）必须记一条 archive:null 的 tamper evidence
      const { records } = readEvidence(workspace);
      const tampers = records.filter((r) => r.type === 'tamper');
      expect(tampers.some((t) => t.archive === null)).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('快照写回失败跳过 validator 时保留实现候选但绝不签发凭证', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const statePath = join(workspace, 'state.json');
    const fake = join(workspace, 'fake-break-after-pass.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(
      fake,
      `
      import { appendFileSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'));
      state['US-001'].passes = true;
      writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder done\\n');
      unlinkSync(${JSON.stringify(prdPath)});
      mkdirSync(${JSON.stringify(prdPath)});
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(2);
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001']).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderOutcome: 'completed',
        validatorRan: false,
        validatorOutcome: 'skipped',
        skippedValidator: true,
        validationPending: true,
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('终轮 builder 异常且篡改 prd：循环自然耗尽后磁盘已恢复、篡改被存档并计入 evidence', async () => {
    // 回归用例（I-2）：i === maxIterations 且本轮走 builder 异常 continue 路径（未触发 stall
    // 熔断）时，此前循环结束直接 guard.summary()，中间不再有任何 guard.read()——本轮对
    // prd.json 的篡改留在磁盘上，成为下次启动 createPrdGuard 的新基线，跨运行架空 ADR-007。
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const original = readFileSync(prdPath, 'utf-8');
    const fake = join(workspace, 'fake-final-tamper.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync, readFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      prd.project = 'evil-final-round';
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(1); // builder 异常结局：走 continue，不会经过门禁前的 gateRead
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
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
      expect(code).toBe(1); // 唯一一轮异常、未 resolved，跑满 maxIterations
      expect(readFileSync(prdPath, 'utf-8')).toBe(original); // 磁盘已恢复为启动快照
      const archived = readdirSync(workspace).filter((f) => f.startsWith('prd.tampered-'));
      expect(archived).toHaveLength(1); // 篡改版已存档
      expect(warns.some((w) => w.includes('运行期间检测到 prd.json 被修改'))).toBe(true);
      const { records } = readEvidence(workspace);
      const tampers = records.filter((r) => r.type === 'tamper');
      expect(tampers).toHaveLength(1);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('终轮 no-op 且篡改 prd：循环自然耗尽后磁盘已恢复、篡改被存档', async () => {
    // 同一收口点的第二个入口：no-op continue 路径（builder 正常退出但 state/progress
    // 双无变化）同样绕开所有既有 guard.read()——只要本轮 builder 在退出前篡改了 prd.json。
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const original = readFileSync(prdPath, 'utf-8');
    const fake = join(workspace, 'fake-final-tamper-noop.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync, readFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      prd.project = 'evil-final-noop';
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(0); // 干净退出，但 state/progress 双无变化 = no-op
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
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
      expect(code).toBe(1); // 唯一一轮 no-op、未 resolved，跑满 maxIterations
      expect(readFileSync(prdPath, 'utf-8')).toBe(original); // 磁盘已恢复为启动快照
      const archived = readdirSync(workspace).filter((f) => f.startsWith('prd.tampered-'));
      expect(archived).toHaveLength(1);
      expect(warns.some((w) => w.includes('运行期间检测到 prd.json 被修改'))).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

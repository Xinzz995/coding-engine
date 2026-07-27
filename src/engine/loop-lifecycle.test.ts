import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './evidence.js';
import { readLockInfo, LOCK_FILE } from './lock.js';
import { setup, story, runLoop } from './loop-test-support.js';

describe('runLoop', () => {
  it('returns 0 when all stories are already resolved after one pass', async () => {
    // fake agent: developer pass marks the only story passes=true by writing state.json
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, validated: false, notes: '', retryCount: 0, blocked: false, escalated: false },
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
    expect(
      JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'],
    ).toMatchObject({ passes: true, validated: true });
    expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
      validatorOutcome: 'completed',
      validationReceipt: true,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('does not accept a builder-only passes=true when validator.md is missing', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    rmSync(join(instructionsDir, 'validator.md'));
    const fake = join(workspace, 'fake-builder-only.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync, appendFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, validated: false, notes: '', retryCount: 0, blocked: false, escalated: false },
      }));
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## 2026-07-22 10:00 - US-001\\n');
      process.exit(0);
    `,
    );
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
        stallLimit: 3,
      });
      expect(code).toBe(1);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'],
      ).toMatchObject({ passes: false, validated: false });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        validatorRan: false,
        validatorOutcome: 'skipped',
        validationRollback: true,
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('does not issue a receipt from a restored candidate when validator deletes the story', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-delete-story.mjs');
    const calls = join(workspace, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!existsSync(${JSON.stringify(calls)})) {
        state['US-001'].passes = true;
        writeFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## builder done\\n');
      } else {
        delete state['US-001'];
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
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001']).toMatchObject({
        passes: false,
        validated: false,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        validatorOutcome: 'completed',
        validationRollback: true,
        stateValidationTamper: [{ expected: false, received: 'missing', side: 'validator' }],
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('records field-only validated deletion before issuing a legitimate receipt', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-delete-field.mjs');
    const calls = join(workspace, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!existsSync(${JSON.stringify(calls)})) {
        state['US-001'].passes = true;
        writeFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## builder done\\n');
      } else {
        delete state['US-001'].validated;
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
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(0);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001']).toMatchObject({
        passes: true,
        validated: true,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        validationReceipt: true,
        stateValidationTamper: [{ expected: false, received: 'missing', side: 'validator' }],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('restores builder-forged ownership fields on a non-current story instead of exiting false-green', async () => {
    const { workspace, instructionsDir } = setup([story(), story({ id: 'US-002', priority: 2 })]);
    const fake = join(workspace, 'fake-builder-cross-story.mjs');
    const calls = join(workspace, 'calls.txt');
    const observed = join(workspace, 'call3-passes.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const call = readFileSync(${JSON.stringify(calls)}, 'utf-8').length;
      if (call === 1) {
        state['US-001'].passes = true;
        state['US-002'].passes = true;
        state['US-002'].validated = true;
        state['US-002'].escalated = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## US-001 builder done\\n');
      } else if (call === 3) {
        writeFileSync(${JSON.stringify(observed)}, String(state['US-002'].passes));
        if (state['US-002'].passes !== false) process.exit(0);
        state['US-002'].passes = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## US-002 builder done\\n');
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
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(state['US-001']).toMatchObject({ passes: true, validated: true });
      expect(state['US-002']).toMatchObject({ passes: true, validated: true, escalated: false });
      expect(readFileSync(observed, 'utf-8')).toBe('false');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations).toHaveLength(2);
      const iteration = iterations[0];
      expect(iteration).toMatchObject({
        storyId: 'US-001',
        validationReceipt: true,
        stateRouteTamper: [{ storyId: 'US-002', expected: false, received: true, side: 'builder' }],
        stateValidationTamper: [
          { storyId: 'US-002', expected: false, received: true, side: 'builder' },
        ],
      });
      expect(iterations[1]).toMatchObject({ storyId: 'US-002', validationReceipt: true });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('restores validator-forged ownership fields on a non-current story instead of exiting false-green', async () => {
    const { workspace, instructionsDir } = setup([story(), story({ id: 'US-002', priority: 2 })]);
    const fake = join(workspace, 'fake-validator-cross-story.mjs');
    const calls = join(workspace, 'calls.txt');
    const observed = join(workspace, 'call3-passes.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const call = readFileSync(${JSON.stringify(calls)}, 'utf-8').length;
      if (call === 1) {
        state['US-001'].passes = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## US-001 builder done\\n');
      } else if (call === 2) {
        state['US-002'].passes = true;
        state['US-002'].validated = true;
        state['US-002'].escalated = true;
      } else if (call === 3) {
        writeFileSync(${JSON.stringify(observed)}, String(state['US-002'].passes));
        if (state['US-002'].passes !== false) process.exit(0);
        state['US-002'].passes = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## US-002 builder done\\n');
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
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(state['US-001']).toMatchObject({ passes: true, validated: true });
      expect(state['US-002']).toMatchObject({ passes: true, validated: true, escalated: false });
      expect(readFileSync(observed, 'utf-8')).toBe('false');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations).toHaveLength(2);
      const iteration = iterations[0];
      expect(iteration).toMatchObject({
        storyId: 'US-001',
        validationReceipt: true,
        stateRouteTamper: [
          { storyId: 'US-002', expected: false, received: true, side: 'validator' },
        ],
        stateValidationTamper: [
          { storyId: 'US-002', expected: false, received: true, side: 'validator' },
        ],
      });
      expect(iterations[1]).toMatchObject({ storyId: 'US-002', validationReceipt: true });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('restores a non-current story deleted by the builder and records its real storyId', async () => {
    const { workspace, instructionsDir } = setup([story(), story({ id: 'US-002', priority: 2 })]);
    const fake = join(workspace, 'fake-builder-delete-other.mjs');
    const calls = join(workspace, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!existsSync(${JSON.stringify(calls)})) {
        state['US-001'].passes = true;
        delete state['US-002'];
        writeFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## builder done\\n');
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
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-002']).toMatchObject({
        passes: false,
        validated: false,
        escalated: false,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        stateRouteTamper: [
          { storyId: 'US-002', expected: false, received: 'missing', side: 'builder' },
        ],
        stateValidationTamper: [
          { storyId: 'US-002', expected: false, received: 'missing', side: 'builder' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rolls a crash-left passes=true validated=false back before selecting work', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
          notes: 'builder done',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const fake = join(workspace, 'fake-noop.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
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
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'],
      ).toMatchObject({ passes: false, validated: false, notes: 'builder done' });
      expect(warnings.some((line) => line.includes('待验收状态') && line.includes('US-001'))).toBe(
        true,
      );
    } finally {
      console.warn = originalWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('materializes legacy engine-owned fields before the agent without faking progress or tamper', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        'US-001': { passes: false, notes: '', retryCount: 0, blocked: false },
      }),
    );
    const fake = join(workspace, 'fake-legacy-noop.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
      ).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001']).toMatchObject({
        passes: false,
        validated: false,
        escalated: false,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({ builderOutcome: 'completed', noop: true });
      expect(iteration).not.toHaveProperty('stateValidationTamper');
      expect(iteration).not.toHaveProperty('stateRouteTamper');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('enters final review instead of treating story convergence as delivery-ready', async () => {
    const { workspace, instructionsDir } = setup([story()]);
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
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
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
      expect(logs.some((l) => l.includes('开始针对当前 PR 最新提交执行本地最终 Review'))).toBe(
        true,
      );
      expect(logs.some((l) => l.includes('fixture final review passed'))).toBe(true);
    } finally {
      console.log = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('returns 1 when stories never resolve within maxIterations', async () => {
    const { workspace, instructionsDir } = setup([story()]); // never flips to passes
    // 真实 stub 文件而非 `node -e` 一行式（见 :187 注释：`-e` 后的脚本会被引擎追加的
    // --dangerously-skip-permissions 当成 node 自己的 CLI 选项、以退出码 9 假崩溃）。
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
    expect(code).toBe(1);
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('spawns the agent at the project root, not inside the workspace dir', async () => {
    // Regression: runLoop used to pass cwd: cfg.workspace to runAgent, which made
    // the agent resolve `.workspace/prd.json` against `.workspace/` itself
    // (<root>/.workspace/.workspace/prd.json) — engine and agent never shared
    // state, passes:true was never observed, and the loop always hit maxIterations.
    // The engine itself reads prd.json at join(cfg.workspace, 'prd.json') which
    // resolves against the PROCESS cwd (= project root), so the agent must be
    // spawned at process.cwd() too. This fake records its own process.cwd() to a
    // marker file (absolute path) and flips the single story to passes:true so
    // the loop resolves and exits.
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-cwd.mjs');
    const marker = join(workspace, 'agent-cwd.txt');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      const cwd = process.cwd();
      writeFileSync(${JSON.stringify(marker)}, cwd);
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
      const recorded = readFileSync(marker, 'utf8');
      // The agent must run at the engine process's cwd (project root), NOT at the
      // temp workspace dir — otherwise the engine and agent diverge on prd.json.
      expect(recorded).toBe(process.cwd());
      expect(recorded).not.toBe(workspace);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('renders the actual workspace into the agent prompt instead of a hardcoded path', async () => {
    // The instruction files use the {{WORKSPACE}} placeholder so a custom
    // --workspace path reaches the agent. This fake records the prompt it
    // received (its last argv) so we can assert the placeholder was substituted
    // with the real workspace value and no literal {{WORKSPACE}} leaks through.
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(
      join(instructionsDir, 'builder.md'),
      'read {{WORKSPACE}}/prd.json and {{WORKSPACE}}/progress.md',
    );
    const fake = join(workspace, 'fake-prompt.mjs');
    const marker = join(workspace, 'agent-prompt.txt');
    writeFileSync(
      fake,
      `
      import { writeFileSync, existsSync } from 'node:fs';
      // Capture only the first (Developer) invocation's prompt; the Validator
      // runs afterward with the same binary and would otherwise overwrite it.
      if (!existsSync(${JSON.stringify(marker)})) writeFileSync(${JSON.stringify(marker)}, process.argv[process.argv.length - 1]);
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
      const prompt = readFileSync(marker, 'utf8');
      expect(prompt).toContain(`${workspace}/prd.json`);
      expect(prompt).toContain(`${workspace}/progress.md`);
      expect(prompt).not.toContain('{{WORKSPACE}}');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('migrates legacy prd.json state fields into state.json on startup', async () => {
    // v0.4 旧格式：story 自带 passes:true 且无 state.json —— 引擎启动即抽取迁移，
    // 循环第一轮就判定全部完成并以 0 退出。
    const { workspace, instructionsDir } = setup([
      story({ passes: true, notes: '', retryCount: 0, blocked: false }),
    ]);
    // 用真实 stub 文件而非 `node -e` 一行式：后者的脚本字符串后面还跟着
    // buildAgentArgs 拼的 --print --dangerously-skip-permissions 等参数，
    // node 会把它们当成自己的 CLI 选项重新解析（非脚本 argv），导致
    // "bad option" 报错、以非 0 码退出——`-e` 从未真正跑到 process.exit(0)。
    // 旧实现只看 timedOut 不看 exitCode，这个假崩溃被无声吞掉；
    // 本任务后 exitCode!=0 会被判 error 并 continue，必须让 stub 真的干净退出 0。
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
      const migrated = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(migrated['US-001'].passes).toBe(true);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('does not resurrect legacy in-story state when state.json is corrupted mid-run', async () => {
    // 胖 prd.json（story 自带 passes:true）+ 损坏的 state.json：
    // 运行期回退必须按全部未开始处理（而非复活 legacy passes），循环跑满返回 1，且不覆盖损坏文件。
    const { workspace, instructionsDir } = setup([
      story({ passes: true, notes: '', retryCount: 0, blocked: false }),
    ]);
    writeFileSync(join(workspace, 'state.json'), '{ broken');
    // 用真实 stub 文件而非 `node -e` 一行式：见 :187 注释，`-e` 后面的脚本字符串会被
    // buildAgentArgs 拼的 --print --dangerously-skip-permissions 参数干扰，node 把它们
    // 当自己的 CLI 选项重新解析、以退出码 9 崩溃——脚本从未真正跑到 process.exit(0)。
    // 这个假崩溃会让每轮都走 builder-error continue，完成判定永远到不了，
    // 而完成判定（allStoriesResolved）正是本用例要守的位置：legacy passes 若被复活，
    // 只有走到这里才会被判定误判全绿吃掉。stub 必须真的干净退出 0。
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
      expect(code).toBe(1);
      expect(readFileSync(join(workspace, 'state.json'), 'utf-8')).toBe('{ broken');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes report.html when the loop completes', async () => {
    const { workspace, instructionsDir } = setup([story()]);
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
      const html = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('US-001');
      expect(html).toContain('Story 验证完成');
      expect(html).toContain('Story 结果不等于可交付');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes report.html even when the loop hits maxIterations unfinished', async () => {
    const { workspace, instructionsDir } = setup([story()]); // never flips
    // 真实 stub 文件而非 `node -e` 一行式（见 :187 注释：`-e` 后的脚本会被引擎追加的
    // --dangerously-skip-permissions 当成 node 自己的 CLI 选项、以退出码 9 假崩溃）。
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
      expect(code).toBe(1);
      const html = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(html).toContain('进行中'); // 未完成态诚实存档
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('uses the PRD guard snapshot for the final report even when restoring disk fails', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-prd-directory.mjs');
    // 把 prd.json 换成目录：guard 能检出篡改，但原子 rename 无法覆盖目录，稳定制造 restoreFailed。
    writeFileSync(
      fake,
      `
      import { rmSync, mkdirSync } from 'node:fs';
      rmSync(${JSON.stringify(prdPath)});
      mkdirSync(${JSON.stringify(prdPath)});
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
      ).toBe(1);
      const html = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(html).toContain('US-001');
      expect(html).toContain('引擎启动快照');
      expect(html).not.toContain('验证报告未生成');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('runLoop keepOpen', () => {
  it('keeps the dashboard serving after completion until interrupt resolves', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const port = 18100 + (process.pid % 1000);
    let release!: () => void;
    const interrupt = new Promise<void>((r) => {
      release = r;
    });
    const running = runLoop({
      kind: 'claude',
      maxIterations: 5,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port,
      openBrowser: false,
      keepOpen: true,
      interrupt,
    });
    try {
      // 等待真实完成信号，不能假定 Windows 等较慢环境会在固定 300ms 内完成两次 agent 调用。
      let completedPhase: string | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/state`);
          if (response.ok) {
            const state = (await response.json()) as { runtime: { phase: string } };
            completedPhase = state.runtime.phase;
            if (completedPhase === 'done') break;
          }
        } catch {
          // 仪表盘可能还未开始监听；在期限内继续轮询。
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(completedPhase).toBe('done');

      // With keepOpen the loop must NOT resolve on its own after completion.
      const pending = await Promise.race([
        running.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('pending'), 100)),
      ]);
      expect(pending).toBe('pending');
      // The dashboard must still answer while we wait.
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runtime: { phase: string } };
      expect(body.runtime.phase).toBe('done');
      // Releasing the interrupt lets the loop return its real exit code and close.
      release();
      expect(await running).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
    } finally {
      release();
      await running.catch(() => undefined);
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 15_000);

  it('closes immediately after completion when keepOpen is not set', async () => {
    const { workspace, instructionsDir } = setup([story()]);
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
    const port = 19100 + (process.pid % 1000);
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 5,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port,
        openBrowser: false,
      });
      expect(code).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('workspace 并发锁', () => {
  const lockJson = (pid: number) =>
    JSON.stringify({ pid, startedAt: '2026-07-16T00:00:00.000Z', command: 'run' });

  it('returns 2 without touching the workspace when an alive lock exists', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, LOCK_FILE), lockJson(process.pid)); // 本进程必存活
    // stub agent 必须设置：红灯阶段（锁未实现）循环会真的跑，绝不能 spawn 真 claude
    process.env.CODING_X_CLAUDE_BIN = 'node -e process.exit(0)';
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args.join(' '));
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
      expect(errs.some((l) => l.includes('已被另一个 coding-x 进程锁定'))).toBe(true);
    } finally {
      console.error = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
    expect(existsSync(join(workspace, 'state.json'))).toBe(false); // 锁生效=未写任何文件（含 ensureStateFile）
    expect(readLockInfo(join(workspace, LOCK_FILE))!.pid).toBe(process.pid); // 别人的锁原样保留
  });

  it('removes engine.lock after a normal run', async () => {
    const { workspace, instructionsDir } = setup([story()]);
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
      expect(existsSync(join(workspace, LOCK_FILE))).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('takes over a stale lock (dead pid) and completes normally', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, LOCK_FILE), lockJson(999999999)); // 超 pid 上限，必死
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
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
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
      expect(warns.some((w) => w.includes('已接管'))).toBe(true);
    } finally {
      console.warn = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('releases the lock before the keepOpen wait begins', async () => {
    const { workspace, instructionsDir } = setup([story()]);
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
    // interrupt 注入口（LoopConfig.interrupt）：以 keepOpen 分支「运行结束」日志行为事件驱动
    // 同步点采样锁是否已释放——该行在 lock.release() 之后、await interrupt 之前打印（见
    // loop.ts），比固定墙钟 setTimeout 更可靠：后者与真实子进程冷启动赛跑，冷启动超时窗口
    // 就会误采到「循环仍在跑」的假失败。
    let lockDuringWait = true;
    let resolveInterrupt!: () => void;
    const interrupt = new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    });
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.join(' ');
      if (line.includes('运行结束')) {
        lockDuringWait = existsSync(join(workspace, LOCK_FILE));
        resolveInterrupt();
      }
    };
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
        keepOpen: true,
        interrupt,
      });
      expect(code).toBe(0);
      expect(lockDuringWait).toBe(false); // keepOpen 等待期间锁已不在
    } finally {
      console.log = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('异常轮回写（builder 侧）', () => {
  it('builder provider 402：state 保持未通过，iteration 留退出码/耗时/诊断供报告恢复', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-402.mjs');
    writeFileSync(
      fake,
      `
      process.stderr.write('API Error: 402 Account overdue\\n');
      process.exit(1);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
      ).toBe(1);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'],
      ).toMatchObject({ passes: false, validated: false, retryCount: 0 });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderOutcome: 'error',
        validatorRan: false,
        builderInvocation: {
          durationMs: expect.any(Number),
          exitCode: 1,
          diagnosticTail: 'API Error: 402 Account overdue',
        },
      });
      expect(readFileSync(join(workspace, 'report.html'), 'utf-8')).toContain(
        'API Error: 402 Account overdue',
      );
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('builder 写 true 后非零退出：回写 false+待复核标记，evidence 记 error 结局与回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    // fake：置 US-001 通过后以非零码退出（对应「干完活但进程异常收尾」）
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(1);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
    delete process.env.CODING_X_CLAUDE_BIN;
    // 每轮都回写 → 永不 resolved → 跑满 maxIterations，exit 1
    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toContain('[中断轮待复核]');
    expect(state['US-001'].retryCount).toBe(0);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(2);
    expect(iters[0]).toMatchObject({
      iteration: 1,
      storyId: 'US-001',
      builderOutcome: 'error',
      abortRollback: { storyId: 'US-001' },
    });
    expect((iters[0] as { validatorRan: boolean }).validatorRan).toBe(false);
  });

  it('builder 超时且未动 state：不回写、不产生标记，iteration 记 timeout', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    // fake：不写任何文件，睡到被引擎 SIGTERM（devTimeoutMs=400 触发超时）
    writeFileSync(
      fake,
      `
      await new Promise((r) => setTimeout(r, 60_000));
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 1,
      devTimeoutMs: 400,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toBe('');
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({ iteration: 1, builderOutcome: 'timeout' });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
  });

  it('agent 同轮置 blocked 且非零退出：不回写、evidence 如实记 agentBlocked', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '[需要人工核实] 环境异常', retryCount: 0, blocked: true },
      }));
      process.exit(1);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
    delete process.env.CODING_X_CLAUDE_BIN;
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    // blocked 优先：不回写（passes 保持 true）、notes 不被改写
    expect(state['US-001'].blocked).toBe(true);
    expect(state['US-001'].passes).toBe(true);
    expect(state['US-001'].notes).toContain('[需要人工核实]');
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({ builderOutcome: 'error', agentBlocked: true });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
    // 本轮 builder 非零退出触发早退 continue（loop.ts 异常轮熔断分支），整段（门禁/validator/完成判定）本轮跳过；
    // blocked→resolved 的收敛判定只在“到达完成判定”的轮次生效，需等下一轮 builder 干净退出才会跑到
    // （Task 3 报告 self-review 已记录此边界：“识别会推迟到下一轮…而非当轮收敛”）。
    // maxIterations=1 没有下一轮，故跑满收尾，退出码 1 是跑满语义——与 Task 6 的 blocked 收敛 exit 3 无关：
    // exit 3 要求到达完成判定分支，本用例的异常轮 continue 到不了那里。
    expect(code).toBe(1);
  });
});

describe('异常轮回写（validator 侧）', () => {
  it('builder 置 true 后 validator 非零退出：回写 false，iteration 记 validator error 与回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    // 同一 stub 以调用次数区分：第 1 次（builder）置 true 正常退出；第 2 次（validator）非零退出
    writeFileSync(
      fake,
      `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const n = readFileSync(${JSON.stringify(calls)}, 'utf-8').length;
      if (n === 1) {
        writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        }));
        process.exit(0);
      }
      process.exit(1);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1); // 回写后未 resolved，跑满 1 轮
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toContain('[中断轮待复核]');
    expect(state['US-001'].notes).toContain('validator');
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({
      builderOutcome: 'completed',
      validatorOutcome: 'error',
      abortRollback: { storyId: 'US-001' },
    });
  });

  it('builder 置 true 后 validator 超时：回写 false 且不会从完成出口假绿', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-timeout.mjs');
    const calls = join(workspace, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      if (!existsSync(${JSON.stringify(calls)})) {
        const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'));
        state['US-001'].passes = true;
        writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
        writeFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder done\\n');
        process.exit(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 400,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001']).toMatchObject({
        passes: false,
        validated: false,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderOutcome: 'completed',
        validatorOutcome: 'timeout',
        abortRollback: { storyId: 'US-001' },
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('validator 正常完成：iteration 记 validatorOutcome completed，无回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
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
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters[0]).toMatchObject({ validatorOutcome: 'completed' });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
  });
});

describe('no-op 检测与 stall 熔断', () => {
  it('builder 空转（双无变化）：跳过验收只跑 builder，连续 3 轮熔断 exit 1', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    // fake：只计数，什么都不写，正常退出（completed 但零产出 = no-op）
    writeFileSync(
      fake,
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 10,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    // 缺省 stallLimit=3：恰 3 轮、每轮只有 builder 一次调用（validator 从未拉起）
    expect(readFileSync(calls, 'utf-8').length).toBe(3);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(3);
    expect(iters.every((r) => (r as { noop?: true }).noop === true)).toBe(true);
  });

  it('门禁打回轮不计 stall 且清零：打回多于 stallLimit 也不熔断', async () => {
    // qualityChecks 必败（false 命令）+ builder 每轮置 true → 每轮门禁打回（有 state 写入=有活动）
    const { workspace, instructionsDir } = setup([story()], { qualityChecks: ['false'] });
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(
      fake,
      `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 4,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    // 4 轮全是门禁打回（stallLimit=3 未触发熔断）→ 跑满，builder 每轮都拉起
    expect(readFileSync(calls, 'utf-8').length).toBe(4);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(4);
    expect(iters.every((r) => (r as { gateRejected?: true }).gateRejected === true)).toBe(true);
    expect(
      iters.every((r) => (r as { validatorOutcome?: string }).validatorOutcome === 'skipped'),
    ).toBe(true);
    expect(code).toBe(1);
  });

  it('stallLimit 可经配置调整', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(
      fake,
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 10,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
      stallLimit: 1,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    expect(readFileSync(calls, 'utf-8').length).toBe(1);
  });

  it('启动时已全部 resolved：完成判定优先于 stall 计数，直接 exit 0', async () => {
    // 断点续跑接手已完工 workspace 时，bootstrap 直接收敛，不需要制造 no-op 轮。
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }),
    );
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);'); // 干净退出、不碰任何文件 = 真空转
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 3,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
  });

  it('已完工 workspace 启动即收敛：不调 agent，也不伪造 iteration', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    // 预置已完工 state；fake 不写任何文件（空转）
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }),
    );
    const fake = join(workspace, 'fake.mjs');
    const called = join(workspace, 'called.txt');
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(called)}, 'x');`,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
    expect(existsSync(called)).toBe(false);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(0);
  });

  it('已收敛但含 blocked 的工作区重跑：no-op 快路径同样 exit 3 并列出 blocked story', async () => {
    const { workspace, instructionsDir } = setup([story(), story({ id: 'US-002', priority: 2 })]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '[需要人工核实] 待裁决', retryCount: 0, blocked: true },
      }),
    );
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `process.exit(0);`);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(' '));
      origLog(...a);
    };
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
    console.log = origLog;
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(3);
    const banner = logs.find((l) => l.includes('blocked'));
    expect(banner).toContain('US-002');
    expect(logs.some((l) => l.includes('全部 story 已通过'))).toBe(false);
  });
});

describe('blocked 收敛出口', () => {
  it('全部 resolved 但存在 blocked：文案列出 story 号，exit 3', async () => {
    const { workspace, instructionsDir } = setup([story(), story({ id: 'US-002', priority: 2 })]);
    const fake = join(workspace, 'fake.mjs');
    // fake：US-001 通过、US-002 置 blocked（agent 仲裁上报形态）
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '[需要人工核实] 环境缺失', retryCount: 0, blocked: true },
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(' '));
      origLog(...a);
    };
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 3,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    console.log = origLog;
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(3);
    const banner = logs.find((l) => l.includes('blocked'));
    expect(banner).toBeDefined();
    expect(banner).toContain('US-002');
    expect(banner).toContain('1 个 story 通过');
    expect(logs.some((l) => l.includes('全部 story 已通过'))).toBe(false);
  });

  it('全部通过无 blocked：维持 exit 0 与既有文案', async () => {
    const { workspace, instructionsDir } = setup([story()]);
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
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './evidence.js';
import * as dashboard from '../dashboard/server.js';
import {
  setup,
  story,
  routedStory,
  modelConfig,
  catalogWith,
  runLoop,
} from './loop-test-support.js';

describe('runLoop model routing', () => {
  // fake 记录每次调用收到的 argv（一行一次），并把 story 翻绿让循环结束。
  // 行 1 = builder、行 2 = validator（同轮内先后调用）。
  function fakeArgvRecorder(workspace: string): { fake: string; argvLog: string } {
    const fake = join(workspace, 'fake-argv.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(
      fake,
      `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 1, blocked: false },
      }));
      process.exit(0);
    `,
    );
    return { fake, argvLog };
  }

  it('routes stage models and uses sticky escalation state', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], {
      models: modelConfig(),
    });
    // 升级与 retryCount 分离：只有 engine-owned escalated 决定本轮路由。
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': { passes: false, notes: '', retryCount: 1, blocked: false, escalated: true },
      }),
    );
    const { fake, argvLog } = fakeArgvRecorder(workspace);
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
        modelCatalog: catalogWith('esc-m', 'val-m'),
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('--model esc-m'); // builder 升级
      expect(lines[1]).toContain('--model val-m'); // validator 恒定
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated,
      ).toBe(true);
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderRouteSource: 'escalation',
        validatorRouteSource: 'validator',
        stateRouteTamper: [
          { expected: true, received: 'missing', side: 'builder' },
          { expected: true, received: 'missing', side: 'validator' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it.each([
    ['low', 'low-m'],
    ['medium', 'fast-m'],
    ['high', 'high-m'],
  ] as const)(
    'uses the %s story difficulty mapping for the initial builder',
    async (difficulty, expectedModel) => {
      const { workspace, instructionsDir } = setup([routedStory({ difficulty })], {
        models: modelConfig(),
      });
      const { fake, argvLog } = fakeArgvRecorder(workspace);
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
          modelCatalog: catalogWith(expectedModel, 'esc-m', 'val-m'),
        });
        expect(code).toBe(0);
        const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
        expect(lines[0]).toContain(`--model ${expectedModel}`);
        expect(lines[1]).toContain('--model val-m');
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
  );

  it.each([
    ['claude', 'CODING_X_CLAUDE_BIN', '--print --dangerously-skip-permissions'],
    ['codex', 'CODING_X_CODEX_BIN', 'exec --dangerously-bypass-approvals-and-sandbox'],
    ['cursor', 'CODING_X_CURSOR_BIN', '-p --force'],
  ] as const)(
    'models.runner auto-selects %s and reaches the fake agent with its public argv',
    async (runner, envName, argvPrefix) => {
      const { workspace, instructionsDir } = setup([routedStory()], {
        models: { ...modelConfig(), runner },
      });
      const { fake, argvLog } = fakeArgvRecorder(workspace);
      process.env[envName] = `node ${fake}`;
      try {
        const code = await runLoop({
          kind: 'claude',
          kindExplicit: false,
          maxIterations: 2,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
          modelCatalog: async () => ({
            status: 'available',
            runner,
            source: 'global-config',
            configPath: '/fixture/config.json',
            models: ['fast-m', 'esc-m', 'val-m'].map((id) => ({ id })),
          }),
        });
        expect(code).toBe(0);
        const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
        expect(lines[0]).toContain(argvPrefix);
        expect(lines[0]).toContain('--model fast-m');
        expect(lines[1]).toContain('--model val-m');
      } finally {
        delete process.env[envName];
      }
    },
  );

  it('lets CLI overrides beat prd.json models', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], {
      models: modelConfig(),
    });
    const { fake, argvLog } = fakeArgvRecorder(workspace);
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
        builderModel: 'cli-b',
        validatorModel: 'cli-v',
        modelCatalog: catalogWith('cli-b', 'cli-v', 'esc-m'),
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model cli-b');
      expect(lines[1]).toContain('--model cli-v');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('reads a valid CODING_X_CONFIG through the production preflight path', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const configPath = join(workspace, 'global-models.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        models: { claude: ['fast-m', 'esc-m', 'val-m'].map((id) => ({ id })) },
      }),
    );
    process.env.CODING_X_CONFIG = configPath;
    const { fake, argvLog } = fakeArgvRecorder(workspace);
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
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model val-m');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('passes no --model at all when nothing is configured', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    process.env.CODING_X_CONFIG = join(workspace, 'missing-global-config.json');
    const { fake, argvLog } = fakeArgvRecorder(workspace);
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
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).not.toContain('--model');
      expect(lines[1]).not.toContain('--model');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('fails before starting an agent on malformed models', async () => {
    const { workspace, instructionsDir } = setup([story()], { models: 'opus' });
    // 非法配置必须在循环前失败，不能回退到 runner 默认模型。
    const fake = join(workspace, 'fake-argv-only.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(
      fake,
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      // progress.md 每次调用递增写入：让每轮都有非空转产出，本用例只关心 models 警告去重，
      // 不是 Task 5 的 no-op 检测——真空转会跳过 validator，把 builder+validator 各跑一次的假设打破。
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'x');
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '));
    };
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
      expect(code).toBe(2);
      expect(existsSync(argvLog)).toBe(false);
      expect(errors.some((w) => w.includes('models 形状非法'))).toBe(true);
    } finally {
      console.error = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('fails before dashboard/agent when routed models have no global catalog', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    process.env.CODING_X_CONFIG = join(workspace, 'missing-global-config.json');
    const fake = join(workspace, 'must-not-run.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argvLog)}, 'ran');`,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const dashboardStart = vi.spyOn(dashboard, 'start');
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '));
    };
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
      expect(dashboardStart).not.toHaveBeenCalled();
      expect(existsSync(argvLog)).toBe(false);
      expect(errors.join('\n')).toContain('未找到全局模型配置');
    } finally {
      dashboardStart.mockRestore();
      console.error = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('does not let a CLI model override bypass the catalog when prd.json is missing', async () => {
    const { workspace, instructionsDir } = setup([]);
    rmSync(join(workspace, 'prd.json'));
    const configPath = join(workspace, 'global-models.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        models: { claude: [{ id: 'some-other-model' }] },
      }),
    );
    process.env.CODING_X_CONFIG = configPath;
    const fake = join(workspace, 'must-not-run.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argvLog)}, 'ran');`,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '));
    };
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          builderModel: 'cli-b',
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(2);
      expect(existsSync(argvLog)).toBe(false);
      expect(errors.join('\n')).toContain('cli-b');
      expect(errors.join('\n')).toContain('claude 全局模型目录');
    } finally {
      console.error = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rejects a missing final-review model catalog even when stories are already settled', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false, escalated: false },
      }),
    );
    process.env.CODING_X_CONFIG = join(workspace, 'missing-global-models.json');
    const argvLog = join(workspace, 'argv.log');
    const fake = join(workspace, 'must-not-run.mjs');
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argvLog)}, 'ran');`,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          kindExplicit: false,
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(2);
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('模型升级触发与状态所有权', () => {
  it('completed no-op 首次触发，下轮改走 escalation 且不增加 retryCount', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const fake = join(workspace, 'fake-noop-route.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(
      fake,
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
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
          stallLimit: 3,
          modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
        }),
      ).toBe(1);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model esc-m');
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'];
      expect(state).toMatchObject({ escalated: true, retryCount: 0 });
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations[0]).toMatchObject({ noop: true, escalationTriggeredBy: 'noop' });
      expect(iterations[1]).not.toHaveProperty('escalationTriggeredBy');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('机械门禁首次打回后，下轮改走 escalation', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], {
      models: modelConfig(),
      qualityChecks: ['node -e "process.exit(1)"'],
    });
    const fake = join(workspace, 'fake-gate-route.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      const path = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      state['US-001'].passes = true;
      writeFileSync(path, JSON.stringify(state));
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
          modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
        }),
      ).toBe(1);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model esc-m');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations[0]).toMatchObject({ gateRejected: true, escalationTriggeredBy: 'gate' });
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated,
      ).toBe(true);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('引擎接受 Validator failed claim 后，下轮 builder 改走 escalation', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const fake = join(workspace, 'fake-validator-route.mjs');
    const calls = join(workspace, 'calls.txt');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(
      fake,
      `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const callsPath = ${JSON.stringify(calls)};
      const count = existsSync(callsPath) ? Number(readFileSync(callsPath, 'utf-8')) + 1 : 1;
      writeFileSync(callsPath, String(count));
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (count % 2 === 1) {
        state['US-001'].passes = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder progress\\n');
      } else {
        state['US-001'].passes = false;
        state['US-001'].retryCount += 1;
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
          modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
        }),
      ).toBe(1);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model val-m');
      expect(lines[2]).toContain('--model esc-m');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations[0]).toMatchObject({ escalationTriggeredBy: 'validator' });
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated,
      ).toBe(true);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('异常退出不触发升级', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const fake = join(workspace, 'fake-error-route.mjs');
    writeFileSync(fake, 'process.exit(9);');
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
          modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
        }),
      ).toBe(1);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated,
      ).toBe(false);
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).not.toHaveProperty('escalationTriggeredBy');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('agent 擅自置位 escalated 会被恢复并留痕', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const fake = join(workspace, 'fake-tamper-route.mjs');
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const path = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      state['US-001'].passes = true;
      state['US-001'].escalated = true;
      writeFileSync(path, JSON.stringify(state));
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'progress\\n');
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
          modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
        }),
      ).toBe(0);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated,
      ).toBe(false);
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        stateRouteTamper: [
          { expected: false, received: true, side: 'builder' },
          { expected: false, received: true, side: 'validator' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('agent 删除整条 story 状态时恢复路由所有权与其余状态', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        'US-001': { passes: false, notes: 'keep', retryCount: 2, blocked: false, escalated: true },
      }),
    );
    const fake = join(workspace, 'fake-delete-story-route.mjs');
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const path = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      delete state['US-001'];
      writeFileSync(path, JSON.stringify(state));
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'progress\\n');
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
          modelCatalog: catalogWith('esc-m', 'val-m'),
        }),
      ).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001']).toEqual({
        passes: false,
        validated: false,
        notes: 'keep',
        retryCount: 2,
        blocked: false,
        escalated: true,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        stateRouteTamper: [
          { expected: true, received: 'missing', side: 'builder' },
          { expected: true, received: 'missing', side: 'validator' },
        ],
        stateValidationTamper: [
          { expected: false, received: 'missing', side: 'builder' },
          { expected: false, received: 'missing', side: 'validator' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

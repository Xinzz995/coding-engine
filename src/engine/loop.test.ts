import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLoop, renderInstruction } from './loop.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function setup(prdStories: unknown[], prdExtra: Record<string, unknown> = {}): { workspace: string; instructionsDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'loop-ws-'));
  const instructionsDir = mkdtempSync(join(tmpdir(), 'loop-ins-'));
  cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
  cleanup.push(() => rmSync(instructionsDir, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
    project: 'p', branchName: 'ralph/x', description: 'd', userStories: prdStories, ...prdExtra,
  }));
  writeFileSync(join(instructionsDir, 'builder.md'), 'build it');
  writeFileSync(join(instructionsDir, 'validator.md'), 'validate it');
  return { workspace, instructionsDir };
}

const story = (over: Record<string, unknown> = {}) => ({
  id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [],
  priority: 1, ...over,
});

describe('runLoop', () => {
  it('returns 0 when all stories are already resolved after one pass', async () => {
    // fake agent: developer pass marks the only story passes=true by writing state.json
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    expect(code).toBe(0);
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('prints review-loop and compound-docs hints when all stories resolve', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes('/compound-docs'))).toBe(true);
      expect(logs.some((l) => l.includes('/review-loop'))).toBe(true);
    } finally {
      console.log = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('returns 1 when stories never resolve within maxIterations', async () => {
    const { workspace, instructionsDir } = setup([story()]); // never flips to passes
    process.env.CODING_X_CLAUDE_BIN = `node -e process.exit(0)`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
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
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      const cwd = process.cwd();
      writeFileSync(${JSON.stringify(marker)}, cwd);
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
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
    writeFileSync(join(instructionsDir, 'builder.md'), 'read {{WORKSPACE}}/prd.json and {{WORKSPACE}}/progress.md');
    const fake = join(workspace, 'fake-prompt.mjs');
    const marker = join(workspace, 'agent-prompt.txt');
    writeFileSync(fake, `
      import { writeFileSync, existsSync } from 'node:fs';
      // Capture only the first (Developer) invocation's prompt; the Validator
      // runs afterward with the same binary and would otherwise overwrite it.
      if (!existsSync(${JSON.stringify(marker)})) writeFileSync(${JSON.stringify(marker)}, process.argv[process.argv.length - 1]);
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
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
    const { workspace, instructionsDir } = setup([story({ passes: true, notes: '', retryCount: 0, blocked: false })]);
    process.env.CODING_X_CLAUDE_BIN = 'node -e process.exit(0)';
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
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
    const { workspace, instructionsDir } = setup([story({ passes: true, notes: '', retryCount: 0, blocked: false })]);
    writeFileSync(join(workspace, 'state.json'), '{ broken');
    process.env.CODING_X_CLAUDE_BIN = 'node -e process.exit(0)';
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      expect(readFileSync(join(workspace, 'state.json'), 'utf-8')).toBe('{ broken');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('runLoop quality gate', () => {
  // builder 与 validator 共用同一 stub 二进制：以调用计数文件区分谁跑了。
  function fakeCounting(workspace: string): { fake: string; calls: string } {
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    return { fake, calls };
  }

  it('gate failure rolls the story back and skips the validator for that round', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // 打回后 story 未完成，跑满 maxIterations
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].passes).toBe(false);
      expect(state['US-001'].retryCount).toBe(1);
      expect(state['US-001'].blocked).toBe(false);
      expect(state['US-001'].notes).toContain('[门禁失败 - 第1次]');
      expect(state['US-001'].notes).toContain('退出码 7');
      expect(state['US-001'].notes).toContain('gate-boom');
      // builder 被调用、validator 被跳过：stub 恰好只跑了一次
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('gate pass lets the validator run and the loop complete', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      // builder + validator 都跑了
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('warns and disables the gate on malformed qualityChecks without touching state', async () => {
    const { workspace, instructionsDir } = setup([story()], { qualityChecks: 'npm test' });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0); // 门禁未启用，行为与未配置一致
      expect(warns.some((w) => w.includes('qualityChecks 形状非法'))).toBe(true);
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      console.warn = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('an agent-set blocked story skips the gate and validator for that round and resolves the loop', async () => {
    const gateMark = join(tmpdir(), `coding-x-gate-mark-${Date.now()}`);
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: [`node -e 'require("node:fs").writeFileSync("${gateMark}", "ran")'`],
    });
    // stub agent：不置 passes，而是显式置 blocked（模拟 dogfood US-009 的仲裁上报）
    const fake = join(workspace, 'fake-blocking.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: false, notes: '[需要人工核实] 疑似配置异常，已附调查', retryCount: 0, blocked: true },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 3, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0); // blocked 属 resolved，完成判定当轮收敛
      expect(existsSync(gateMark)).toBe(false); // 门禁命令未执行
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1); // 只有 builder，validator 未拉起
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].blocked).toBe(true);
      expect(state['US-001'].retryCount).toBe(0); // 未被门禁打回推进
      expect(state['US-001'].notes).toContain('[需要人工核实]'); // 仲裁记录未被覆盖
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
      rmSync(gateMark, { force: true });
    }
  });
});

describe('runLoop model routing', () => {
  // fake 记录每次调用收到的 argv（一行一次），并把 story 翻绿让循环结束。
  // 行 1 = builder、行 2 = validator（同轮内先后调用）。
  function fakeArgvRecorder(workspace: string): { fake: string; argvLog: string } {
    const fake = join(workspace, 'fake-argv.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 1, blocked: false },
      }));
      process.exit(0);
    `);
    return { fake, argvLog };
  }

  it('routes stage models and escalates the builder after a rollback', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      models: { builder: 'fast-m', validator: 'val-m', escalation: 'esc-m' },
    });
    // 预置：US-001 已被打回一次（retryCount=1 ≥ escalateAfter 缺省 1）→ builder 应升级
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: false, notes: '', retryCount: 1, blocked: false },
    }));
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('--model esc-m'); // builder 升级
      expect(lines[1]).toContain('--model val-m'); // validator 恒定
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('uses story.model for the builder before any rollback', async () => {
    const { workspace, instructionsDir } = setup([story({ model: 'story-m' })], {
      models: { builder: 'fast-m', validator: 'val-m', escalation: 'esc-m' },
    });
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model story-m'); // retryCount=0，story 覆盖生效
      expect(lines[1]).toContain('--model val-m');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('lets CLI overrides beat prd.json models', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      models: { builder: 'fast-m', validator: 'val-m', escalation: 'esc-m' },
    });
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        builderModel: 'cli-b', validatorModel: 'cli-v',
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model cli-b');
      expect(lines[1]).toContain('--model cli-v');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('passes no --model at all when nothing is configured', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).not.toContain('--model');
      expect(lines[1]).not.toContain('--model');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('warns only once across rounds and disables routing on malformed models', async () => {
    const { workspace, instructionsDir } = setup([story()], { models: 'opus' });
    // 只记录 argv、不翻绿：跑满 2 轮，真正验证跨轮警告去重（每轮都重读非法 models）
    const fake = join(workspace, 'fake-argv-only.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // story 从未翻绿，跑满 maxIterations
      expect(warns.filter((w) => w.includes('models 形状非法'))).toHaveLength(1); // 2 轮只警告一次
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(4); // 2 轮 × (builder + validator)
      for (const line of lines) expect(line).not.toContain('--model');
    } finally {
      console.warn = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('runLoop keepOpen', () => {
  it('keeps the dashboard serving after completion until interrupt resolves', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const port = 18100 + (process.pid % 1000);
    let release!: () => void;
    const interrupt = new Promise<void>((r) => { release = r; });
    try {
      const running = runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port, openBrowser: false,
        keepOpen: true, interrupt,
      });
      // With keepOpen the loop must NOT resolve on its own after completion.
      const pending = await Promise.race([
        running.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('pending'), 300)),
      ]);
      expect(pending).toBe('pending');
      // The dashboard must still answer while we wait.
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(res.status).toBe(200);
      const body = await res.json() as { runtime: { phase: string } };
      expect(body.runtime.phase).toBe('done');
      // Releasing the interrupt lets the loop return its real exit code and close.
      release();
      expect(await running).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('closes immediately after completion when keepOpen is not set', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const port = 19100 + (process.pid % 1000);
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port, openBrowser: false,
      });
      expect(code).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('renderInstruction', () => {
  it('substitutes every {{WORKSPACE}} occurrence with the given path', () => {
    const out = renderInstruction('a {{WORKSPACE}}/prd.json b {{WORKSPACE}}/progress.md', '/abs/state');
    expect(out).toBe('a /abs/state/prd.json b /abs/state/progress.md');
  });

  it('leaves text without the placeholder unchanged', () => {
    expect(renderInstruction('no placeholder here', '.workspace')).toBe('no placeholder here');
  });

  it('substitutes {{MAX_RETRIES}} with the engine constant', () => {
    const out = renderInstruction('如果 retryCount 已经达到 {{MAX_RETRIES}}：', '.workspace');
    expect(out).toBe('如果 retryCount 已经达到 5：');
  });
});

describe('renderInstruction arbitration placeholder', () => {
  it('renders {{ARBITRATION_PREFIXES}} as a 、-joined label list', () => {
    const out = renderInstruction('保全 {{ARBITRATION_PREFIXES}} 行', '.workspace');
    expect(out).toBe('保全 [需求冲突]、[需要人工核实] 行');
  });
});

describe('instruction assets arbitration contract', () => {
  const read = (f: string) =>
    readFileSync(new URL(`../../assets/instructions/${f}`, import.meta.url), 'utf-8');

  it('builder.md and validator.md reference the arbitration placeholder, not hardcoded label lists', () => {
    expect(read('builder.md')).toContain('{{ARBITRATION_PREFIXES}}');
    expect(read('validator.md')).toContain('{{ARBITRATION_PREFIXES}}');
  });

  it('both instructions carry the prd.json authority statement', () => {
    for (const f of ['builder.md', 'validator.md']) {
      expect(read(f)).toContain('prd.tampered-');
      expect(read(f)).toContain('快照保护');
    }
  });
});

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
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      delete prd.qualityChecks;
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
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
    writeFileSync(fake, `
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
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
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
    writeFileSync(fake, `
      import { writeFileSync, readFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      prd.userStories = []; // 删光 story：若完成判定读磁盘会误判全绿提前 exit 0
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // story 从未通过，不被空列表骗成 0
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('写回失败的轮次跳过 validator，结束摘要报告篡改', async () => {
    // builder 删 prd.json 并在原路径建同名目录：读抛 EISDIR（按删除篡改）、写回抛 EISDIR（恢复失败）。
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-break.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { appendFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      if (existsSync(${JSON.stringify(prdPath)})) {
        unlinkSync(${JSON.stringify(prdPath)});
        mkdirSync(${JSON.stringify(prdPath)});
      }
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      // 写回失败 → 本轮 validator 被跳过：stub 只跑了一次
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      expect(warns.some((w) => w.includes('快照写回失败'))).toBe(true);
      expect(warns.some((w) => w.includes('跳过本轮 validator'))).toBe(true);
      // 结束摘要报告篡改事件
      expect(warns.some((w) => w.includes('运行期间检测到 prd.json 被修改'))).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { QUARANTINE_FILE } from '../workspace-safety/quarantine.js';
import {
  ACTIVE_LEASE_DIR,
  OPERATION_DIR,
  PROTOCOL_ROOT_DIR,
  WORKSPACE_MARKER_FILE,
} from '../workspace-safety/types.js';
import { readEvidence } from './evidence.js';
import { runLoop as runProductionLoop } from './loop.js';
import {
  setup,
  story,
  runLoop,
  setupGitProject,
  strictConfig,
  fakeBoundValidator,
  fakeCounting,
  previousFinalReview,
} from './loop-test-support.js';

interface OwnershipViolationScenario {
  readonly name: string;
  readonly phase: 'builder' | 'validator';
  readonly mutation: string;
}

const ownershipViolationScenarios: readonly OwnershipViolationScenario[] = [
  {
    name: 'Validator 删除当前 story',
    phase: 'validator',
    mutation: "delete state['US-001'];",
  },
  {
    name: 'Validator 删除当前 story 的 validated 字段',
    phase: 'validator',
    mutation: "delete state['US-001'].validated;",
  },
  {
    name: 'Builder 伪造非当前 story 的 passes、validated 与 escalated',
    phase: 'builder',
    mutation:
      "state['US-002'].passes = true; state['US-002'].validated = true; state['US-002'].escalated = true;",
  },
  {
    name: 'Builder 给当前 story 写入畸形 validationReceipt',
    phase: 'builder',
    mutation:
      "state['US-001'].passes = true; state['US-001'].validationReceipt = { schemaVersion: 1 };",
  },
  {
    name: 'Builder 给非当前 story 写入畸形 validationReceipt',
    phase: 'builder',
    mutation:
      "state['US-001'].passes = true; state['US-002'].validationReceipt = { schemaVersion: 1 };",
  },
  {
    name: 'Validator 伪造非当前 story 的 passes、validated 与 escalated',
    phase: 'validator',
    mutation:
      "state['US-002'].passes = true; state['US-002'].validated = true; state['US-002'].escalated = true;",
  },
  {
    name: 'Builder 删除非当前 story',
    phase: 'builder',
    mutation: "delete state['US-002'];",
  },
];

describe('runLoop', () => {
  it('implements two Stories first, then revalidates the stale earlier candidate at the final HEAD', async () => {
    const first = story({ id: 'US-001', acceptanceCriteria: ['first works'] });
    const second = story({ id: 'US-002', acceptanceCriteria: ['second works'], priority: 2 });
    const project = setupGitProject([first, second]);
    const fake = join(project.workspace, 'fake-two-story.mjs');
    const calls = join(project.projectRoot, 'two-story-calls.txt');
    const statePath = join(project.workspace, 'state.json');
    writeFileSync(
      fake,
      String.raw`
      import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      const prompt = process.argv.at(-1) ?? '';
      const statePath = ${JSON.stringify(statePath)};
      if (!prompt.includes('ENGINE-BOUND VALIDATION REQUEST')) {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        const entry = Object.entries(state).find(([, value]) => !value.blocked && !value.passes);
        if (!entry) process.exit(8);
        const [storyId, value] = entry;
        value.passes = true;
        value.validated = false;
        value.validationReceipt = null;
        writeFileSync(statePath, JSON.stringify(state, null, 2));
        appendFileSync(${JSON.stringify(calls)}, 'builder:' + storyId + '\n');
        appendFileSync(${JSON.stringify(join(project.projectRoot, 'source.txt'))}, storyId + '\n');
        execFileSync('git', ['add', 'source.txt'], { cwd: ${JSON.stringify(project.projectRoot)} });
        execFileSync('git', ['commit', '-q', '-m', 'test: ' + storyId], { cwd: ${JSON.stringify(project.projectRoot)} });
        appendFileSync(${JSON.stringify(join(project.workspace, 'progress.md'))}, 'built ' + storyId + '\n');
        process.exit(0);
      }
      const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
      const jsonAt = prompt.indexOf('{', markerAt);
      const fenceAt = prompt.indexOf(String.fromCharCode(10, 96, 96, 96), jsonAt);
      const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
      appendFileSync(${JSON.stringify(calls)}, 'validator:' + request.storyId + ':' + request.gitHead + '\n');
      writeFileSync(request.resultPath, JSON.stringify({
        version: 1,
        requestId: request.requestId,
        storyId: request.storyId,
        acceptanceHash: request.acceptanceHash,
        gitHead: request.gitHead,
        verdict: 'passed',
        checks: request.acceptanceCriteria.map((_, index) => ({
          acIndex: index + 1,
          passed: true,
          evidence: 'fixture verified',
        })),
        summary: 'passed',
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    expect(
      await runProductionLoop({
        ...strictConfig(project.workspace, project.instructionsDir),
        projectRoot: project.projectRoot,
        maxIterations: 3,
      }),
    ).toBe(0);

    const finalHead = project.head();
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'builder:US-001',
      expect.stringMatching(/^validator:US-001:/),
      'builder:US-002',
      `validator:US-002:${finalHead}`,
      `validator:US-001:${finalHead}`,
    ]);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state['US-001'].validationReceipt.gitHead).toBe(finalHead);
    expect(state['US-002'].validationReceipt.gitHead).toBe(finalHead);
  }, 30_000);

  it('returns 0 when all stories are already resolved after one pass', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runProductionLoop(strictConfig(workspace, instructionsDir));
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
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
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

  it.each(ownershipViolationScenarios)(
    '生产 runLoop 在 $name 时退出 2、保留隔离现场且不写普通轮次 evidence',
    async ({ phase, mutation }) => {
      const { projectRoot, workspace, instructionsDir } = setup([
        story(),
        story({ id: 'US-002', priority: 2 }),
      ]);
      const fake = join(workspace, 'fake-ownership-violation.mjs');
      const calls = join(projectRoot, 'ownership-violation-calls.txt');
      const statePath = join(workspace, 'state.json');
      writeFileSync(
        fake,
        `
        import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
        const calls = ${JSON.stringify(calls)};
        const call = existsSync(calls) ? Number(readFileSync(calls, 'utf8')) + 1 : 1;
        writeFileSync(calls, String(call));
        const statePath = ${JSON.stringify(statePath)};
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        const phase = ${JSON.stringify(phase)};
        if (phase === 'validator' && call === 1) {
          state['US-001'].passes = true;
          writeFileSync(statePath, JSON.stringify(state));
          appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder completed\\n');
          process.exit(0);
        }
        ${mutation}
        writeFileSync(statePath, JSON.stringify(state));
        process.exit(0);
      `,
      );
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errors.push(args.join(' '));

      try {
        expect(
          await runProductionLoop({
            ...strictConfig(workspace, instructionsDir),
            maxIterations: 1,
          }),
        ).toBe(2);
        const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
        expect(existsSync(join(operation, QUARANTINE_FILE))).toBe(true);
        expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
        expect(errors.some((line) => line.includes('workspace 安全执行失败'))).toBe(true);
        expect(readEvidence(workspace).records.some((record) => record.type === 'iteration')).toBe(
          false,
        );
      } finally {
        console.error = originalError;
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    20_000,
  );

  it('keeps a cross-run candidate and revalidates it without calling Developer again', async () => {
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
      expect(code).toBe(0);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: true,
        notes: 'builder done',
        validationReceipt: { schemaVersion: 1 },
      });
      expect(warnings.some((line) => line.includes('待验收状态') && line.includes('US-001'))).toBe(
        false,
      );
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        builderRan: false,
        validatorRan: true,
        validationReceipt: true,
      });
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
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
    try {
      const code = await runProductionLoop(strictConfig(workspace, instructionsDir));
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
    // The engine receives an explicit project root, so the agent must be
    // spawned there too. This fake records its own process.cwd() to a
    // marker file (absolute path) and flips the single story to passes:true so
    // the loop resolves and exits.
    const { workspace, instructionsDir, projectRoot } = setup([story()]);
    const marker = join(resolve(workspace, '..'), 'agent-cwd.txt');
    const fake = fakeBoundValidator(workspace, 'passed', { builderCwdMarker: marker });
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runProductionLoop(strictConfig(workspace, instructionsDir));
      expect(code).toBe(0);
      const recorded = readFileSync(marker, 'utf8');
      // The agent must run at the explicit project root, NOT inside .workspace.
      expect(realpathSync(recorded)).toBe(realpathSync(projectRoot));
      expect(realpathSync(recorded)).not.toBe(realpathSync(workspace));
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
    const marker = join(resolve(workspace, '..'), 'agent-prompt.txt');
    const fake = fakeBoundValidator(workspace, 'passed', { builderPromptMarker: marker });
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runProductionLoop(strictConfig(workspace, instructionsDir));
      expect(code).toBe(0);
      const prompt = readFileSync(marker, 'utf8');
      expect(prompt).toContain(`${workspace}/prd.json`);
      expect(prompt).toContain(`${workspace}/progress.md`);
      expect(prompt).not.toContain('{{WORKSPACE}}');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('materializes legacy in-PRD state only inside an already initialized new workspace', async () => {
    // setup 已先建立新版 workspace marker 与永久协议根；这里仅覆盖新 workspace 中收到
    // legacy PRD 数据时的字段抽取，不代表 coding-x 会接管或迁移旧的非空 workspace。
    const { workspace, instructionsDir } = setup([
      story({ passes: true, notes: '', retryCount: 0, blocked: false }),
    ]);
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(true);
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

  it('keeps corrupt state bytes and never resurrects legacy PRD passes in production runLoop', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([
      story({ passes: true, notes: '', retryCount: 0, blocked: false }),
    ]);
    const statePath = join(workspace, 'state.json');
    const called = join(projectRoot, 'corrupt-state-agent-called.txt');
    writeFileSync(statePath, '{ broken');
    const fake = join(workspace, 'fake-corrupt-state.mjs');
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(called)}, 'called');`,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);
      expect(readFileSync(statePath, 'utf8')).toBe('{ broken');
      expect(existsSync(called)).toBe(false);
      expect(readEvidence(workspace).records.some((record) => record.type === 'iteration')).toBe(
        false,
      );
      expect(errors.some((line) => line.includes('workspace 安全执行失败'))).toBe(true);
      expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
    } finally {
      console.error = originalError;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes report.html when the loop completes', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runProductionLoop(strictConfig(workspace, instructionsDir));
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

  it('passes the just-completed Final Review outcome directly into the automatic report', async () => {
    const project = setup([story()]);
    const fake = fakeBoundValidator(project.workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const review = previousFinalReview(project.head());
      const code = await runProductionLoop({
        ...strictConfig(project.workspace, project.instructionsDir),
        finalReviewRunner: async (options) => {
          // Production runFinalReview persists this exact state through the active run session
          // before returning it to the loop; mirror that boundary instead of returning a claim.
          await options.session.writer.writeFile(
            'final-review.json',
            `${JSON.stringify(review)}\n`,
          );
          return {
            exitCode: 0,
            message: 'fixture current final review',
            state: review,
          };
        },
      });
      expect(code).toBe(0);
      expect(readFileSync(join(project.workspace, 'report.html'), 'utf-8')).toContain(
        '本地 Review 与 GitHub 交付条件已就绪',
      );
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

  // PRD 篡改检测与恢复失败由 prd-guard.test.ts 覆盖；新版委托边界已经禁止
  // agent 把 prd.json 替换为目录，因此 loop 层不再重复不可达的破坏场景。
});

describe('runLoop keepOpen', () => {
  it('keeps the dashboard serving after completion until interrupt resolves', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const port = 18100 + (process.pid % 1000);
    let release!: () => void;
    const interrupt = new Promise<void>((r) => {
      release = r;
    });
    const running = runProductionLoop({
      ...strictConfig(workspace, instructionsDir),
      port,
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
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const port = 19100 + (process.pid % 1000);
    try {
      const code = await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        port,
      });
      expect(code).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

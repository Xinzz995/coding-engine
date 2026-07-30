import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './evidence.js';
import { runLoop as runProductionLoop } from './loop.js';
import {
  setup,
  story,
  runLoop,
  setupGitProject,
  strictConfig,
} from './loop-test-support.js';
describe('runLoop', () => {
  it('implements two Stories first, then revalidates the stale earlier candidate at the final HEAD', async () => {
    const first = story({ id: 'US-001', acceptanceCriteria: ['first works'] });
    const second = story({ id: 'US-002', acceptanceCriteria: ['second works'], priority: 2 });
    const project = setupGitProject([first, second]);
    const fake = join(project.workspace, 'fake-two-story.mjs');
    const calls = join(project.workspace, 'two-story-calls.txt');
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

    expect(await runProductionLoop({
      ...strictConfig(project.workspace, project.instructionsDir),
      projectRoot: project.projectRoot,
      maxIterations: 3,
    })).toBe(0);

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
  });

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
      expect(readFileSync(observed, 'utf-8')).toBe('true');
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
      expect(iterations[1]).toMatchObject({
        storyId: 'US-002', builderRan: false, validationReceipt: true,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it.each([
    ['current', 'US-001'],
    ['non-current', 'US-002'],
  ] as const)(
    'restores the full pre-Builder state when %s Story receives a malformed receipt',
    async (_label, tamperedStoryId) => {
      const { workspace, instructionsDir } = setup([
        story(),
        story({ id: 'US-002', priority: 2 }),
      ]);
      const statePath = join(workspace, 'state.json');
      const calls = join(workspace, 'malformed-receipt-calls.txt');
      const fake = join(workspace, `fake-malformed-${tamperedStoryId}.mjs`);
      writeFileSync(
        fake,
        `
        import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
        const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
        state['US-001'].passes = true;
        state[${JSON.stringify(tamperedStoryId)}].validationReceipt = { schemaVersion: 1 };
        writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
        appendFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder changed state\\n');
        process.exit(0);
      `,
      );
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

      try {
        expect(await runLoop({
          kind: 'claude',
          maxIterations: 2,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        })).toBe(1);
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(state['US-001']).toMatchObject({
          passes: false,
          validated: false,
          validationReceipt: null,
        });
        expect(state['US-002']).toMatchObject({
          passes: false,
          validated: false,
          validationReceipt: null,
        });
        expect(readFileSync(calls, 'utf8')).toBe('builder');
        expect(readEvidence(workspace).records.find((record) => record.type === 'iteration'))
          .toMatchObject({ builderRan: true, validatorRan: false, builderOutcome: 'completed' });
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
  );

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
      expect(readFileSync(observed, 'utf-8')).toBe('true');
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
      expect(iterations[1]).toMatchObject({
        storyId: 'US-002', builderRan: false, validationReceipt: true,
      });
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
      expect(warnings.some((line) => line.includes('待验收状态') && line.includes('US-001'))).toBe(false);
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
    // The engine receives an explicit project root, so the agent must be
    // spawned there too. This fake records its own process.cwd() to a
    // marker file (absolute path) and flips the single story to passes:true so
    // the loop resolves and exits.
    const { workspace, instructionsDir, projectRoot } = setup([story()]);
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

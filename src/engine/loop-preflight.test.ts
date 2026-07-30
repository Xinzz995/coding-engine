import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runLoop as runProductionLoop, type LoopConfig } from './loop.js';
import { type QualityContract, type QualityContractReadResult } from '../quality/contract.js';
import { writeFinalReviewState } from '../review/state.js';
import {
  TEST_QUALITY_DIGEST,
  TEST_QUALITY_CONTRACT,
  readyQualityContract,
  setup,
  story,
  previousFinalReview,
  runLoop,
  fakeCounting,
  fakeBoundValidator,
  strictConfig,
  validationReceiptFor,
  setupGitProject,
} from './loop-test-support.js';

describe('quality contract preflight and shadow mode', () => {
  it('stops before state mutation, model lookup or any agent when Git HEAD is unavailable', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const statePath = join(workspace, 'state.json');
    const original = JSON.stringify({
      'US-001': {
        passes: true,
        validated: false,
        validationReceipt: null,
        notes: 'keep exactly',
        retryCount: 2,
        blocked: false,
        escalated: false,
      },
    });
    writeFileSync(statePath, original);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    let catalogCalls = 0;
    let reviewCalls = 0;

    const code = await runProductionLoop({
      ...strictConfig(workspace, instructionsDir),
      projectRoot: instructionsDir,
      modelCatalog: async () => {
        catalogCalls += 1;
        return { status: 'available', runner: 'claude', source: 'global-config', configPath: 'x', models: [] };
      },
      finalReviewRunner: async () => {
        reviewCalls += 1;
        return { exitCode: 0, message: 'must not run' };
      },
    });

    expect(code).toBe(2);
    expect(readFileSync(statePath, 'utf8')).toBe(original);
    expect(catalogCalls).toBe(0);
    expect(reviewCalls).toBe(0);
    expect(existsSync(fake.calls)).toBe(false);
  });

  it('invalidates a stale Story receipt without any Final Review file and revalidates without Developer', async () => {
    const target = story({ acceptanceCriteria: ['still works'] });
    const project = setupGitProject([target]);
    const oldHead = project.head();
    writeFileSync(
      join(project.workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          validationReceipt: validationReceiptFor(target, oldHead),
          notes: 'candidate stays',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const newHead = project.commitFile('H2\n');
    const fake = fakeBoundValidator(project.workspace, 'passed');
    const calls = join(project.workspace, 'bound-calls.txt');
    writeFileSync(calls, '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    expect(await runProductionLoop({
      ...strictConfig(project.workspace, project.instructionsDir),
      projectRoot: project.projectRoot,
    })).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(JSON.parse(readFileSync(join(project.workspace, 'state.json'), 'utf8'))['US-001'])
      .toMatchObject({
        passes: true,
        validated: true,
        retryCount: 0,
        validationReceipt: { gitHead: newHead },
      });
  });

  it('fails before any Story agent when a production final Review model is not explicit', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const statePath = join(workspace, 'state.json');
    expect(existsSync(statePath)).toBe(false);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    const config = strictConfig(workspace, instructionsDir);
    delete config.finalReviewRunner;

    expect(await runProductionLoop(config)).toBe(2);
    expect(existsSync(fake.calls)).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  it('keeps stale receipt bytes unchanged when a later model preflight fails', async () => {
    const target = story({ acceptanceCriteria: ['still current'] });
    const { workspace, instructionsDir } = setup([target]);
    const statePath = join(workspace, 'state.json');
    const original = JSON.stringify({
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt: validationReceiptFor(target, 'a'.repeat(40)),
        notes: 'do not rewrite',
        retryCount: 2,
        blocked: false,
        escalated: false,
      },
    });
    writeFileSync(statePath, original);
    writeFinalReviewState(workspace, previousFinalReview('b'.repeat(40)));
    const finalReviewPath = join(workspace, 'final-review.json');
    const originalFinalReview = readFileSync(finalReviewPath, 'utf8');
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    const config = strictConfig(workspace, instructionsDir);
    delete config.finalReviewRunner;

    expect(await runProductionLoop(config)).toBe(2);
    expect(readFileSync(statePath, 'utf8')).toBe(original);
    expect(readFileSync(finalReviewPath, 'utf8')).toBe(originalFinalReview);
    expect(existsSync(fake.calls)).toBe(false);
  });

  it('reruns Story validation when a commit appears after the previous final Review', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    writeFinalReviewState(workspace, previousFinalReview('a'.repeat(40)));
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;

    expect(await runLoop(strictConfig(workspace, instructionsDir))).toBe(0);
    expect(readFileSync(fake.calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001']).toMatchObject(
      { passes: true, validated: true },
    );
    expect(existsSync(join(workspace, 'final-review.json'))).toBe(false);
  });

  it('does not repeat Story validation after the new head only waits for the remote PR', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    writeFinalReviewState(workspace, previousFinalReview('a'.repeat(40)));
    const fake = fakeBoundValidator(workspace, 'passed');
    const calls = join(workspace, 'bound-calls.txt');
    // 该 fixture 的第 1 次调用模拟 Builder；本场景从跨轮候选开始，首个真实调用应是 Validator。
    writeFileSync(calls, '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    let finalReviewCalls = 0;
    const config: LoopConfig = {
      ...strictConfig(workspace, instructionsDir),
      finalReviewRunner: async () => {
        finalReviewCalls += 1;
        return finalReviewCalls === 1
          ? { exitCode: 6, message: 'fixture remote PR 尚未就绪' }
          : { exitCode: 0, message: 'fixture final review passed' };
      },
    };

    expect(await runProductionLoop(config)).toBe(6);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(existsSync(join(workspace, 'final-review.json'))).toBe(false);

    expect(await runProductionLoop(config)).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(finalReviewCalls).toBe(2);
  });

  it.each([
    ['missing', { status: 'missing', path: '/fixture/.coding-x/quality.json' }],
    [
      'invalid-json',
      { status: 'invalid-json', path: '/fixture/.coding-x/quality.json', error: 'bad json' },
    ],
    [
      'invalid',
      { status: 'invalid', path: '/fixture/.coding-x/quality.json', errors: ['bad schema'] },
    ],
  ] as const)(
    'fails with exit 2 before any agent when the contract is %s',
    async (_name, result) => {
      const { workspace, instructionsDir } = setup([story()]);
      const fake = fakeCounting(workspace);
      process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
      expect(
        await runProductionLoop({
          ...strictConfig(workspace, instructionsDir),
          qualityContractReader: () => result as QualityContractReadResult,
        }),
      ).toBe(2);
      expect(existsSync(fake.calls)).toBe(false);
    },
  );

  it('rejects a formal version mismatch and a stale PRD contract digest before any agent', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const mismatch = { ...TEST_QUALITY_CONTRACT, codingXVersion: '9.9.9' } as QualityContract;
    expect(
      await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        qualityContractReader: () => readyQualityContract(mismatch),
      }),
    ).toBe(2);

    writeFileSync(
      join(workspace, 'prd.json'),
      JSON.stringify({
        project: 'p',
        branchName: 'ralph/x',
        description: 'd',
        userStories: [story()],
        qualityContractDigest: `sha256:${'b'.repeat(64)}`,
      }),
    );
    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);
  });

  it('allows a mismatched candidate only in shadow mode and returns 7 instead of delivery-ready', async () => {
    const target = story({ passes: true });
    const { workspace, instructionsDir, head } = setup([target]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
          validationReceipt: validationReceiptFor(target, head()),
        },
      }),
    );
    const candidate = { ...TEST_QUALITY_CONTRACT, codingXVersion: '9.9.9' } as QualityContract;
    expect(
      await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        shadow: true,
        qualityContractReader: () => readyQualityContract(candidate),
      }),
    ).toBe(7);
  });

  it('rejects a legacy command array or a snapshot that differs from the contract in formal mode', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);

    writeFileSync(
      join(workspace, 'prd.json'),
      JSON.stringify({
        project: 'p',
        branchName: 'ralph/x',
        description: 'd',
        userStories: [story()],
        qualityContractDigest: TEST_QUALITY_DIGEST,
        qualityChecks: {
          ...TEST_QUALITY_CONTRACT.checks,
          test: { notApplicable: 'manually weakened' },
        },
      }),
    );
    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);
  });

  it('stops with exit 2 before Validator when Developer changes the quality contract', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    let reads = 0;
    const changedDigest = `sha256:${'c'.repeat(64)}`;
    const code = await runProductionLoop({
      ...strictConfig(workspace, instructionsDir),
      qualityContractReader: () => {
        reads += 1;
        return readyQualityContract(
          TEST_QUALITY_CONTRACT,
          reads >= 3 ? changedDigest : TEST_QUALITY_DIGEST,
        );
      },
    });
    expect(code).toBe(2);
    expect(readFileSync(fake.calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

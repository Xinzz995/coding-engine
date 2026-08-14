import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop as runProductionLoop, type LoopConfig } from './loop.js';
import {
  readQualityContract,
  type QualityContract,
  type QualityContractReadResult,
} from '../quality/contract.js';
import type { FinalReviewState } from '../review/types.js';
import {
  bindStoryValidationRuntimeIdentity,
  digestCandidateStoryValidationEnvironment,
} from './story-validation-currentness.js';
import type { TddConfig } from './prd.js';
import { CODING_X_VERSION } from '../version.js';
import {
  TEST_QUALITY_DIGEST,
  TEST_QUALITY_CONTRACT,
  TEST_VALIDATION_ENVIRONMENT_DIGEST,
  readyQualityContract,
  setup,
  story,
  previousFinalReview,
  fakeCounting,
  fakeBoundValidator,
  currentRepoTdd,
  strictConfig,
  validationReceiptFor,
  setupGitProject,
} from './loop-test-support.js';

function writeFinalReviewFixture(workspace: string, state: FinalReviewState): void {
  writeFileSync(join(workspace, 'final-review.json'), `${JSON.stringify(state, null, 2)}\n`);
}

function currentVersionContractFixture(): string {
  const contract = JSON.parse(
    readFileSync(resolve('.coding-x/quality.json'), 'utf8'),
  ) as Record<string, unknown>;
  contract.codingXVersion = CODING_X_VERSION;
  return `${JSON.stringify(contract, null, 2)}\n`;
}

describe('quality contract preflight and shadow mode', () => {
  it.each([
    ['empty', []],
    ['duplicate ID', [story(), story()]],
  ] as const)(
    'rejects an %s Story set before state, agent, model, or Final Review',
    async (_label, stories) => {
      const { workspace, instructionsDir } = setup([...stories]);
      const fake = fakeCounting(workspace);
      process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
      let modelCalls = 0;
      let reviewCalls = 0;

      const code = await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        modelCatalog: async () => {
          modelCalls += 1;
          return {
            status: 'available',
            runner: 'claude',
            source: 'global-config',
            configPath: 'x',
            models: [],
          };
        },
        finalReviewRunner: async () => {
          reviewCalls += 1;
          return { exitCode: 0, message: 'must not run' };
        },
      });

      expect(code).toBe(2);
      expect(existsSync(join(workspace, 'state.json'))).toBe(false);
      expect(existsSync(fake.calls)).toBe(false);
      expect(modelCalls).toBe(0);
      expect(reviewCalls).toBe(0);
    },
  );

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
        return {
          status: 'available',
          runner: 'claude',
          source: 'global-config',
          configPath: 'x',
          models: [],
        };
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

  it('stops before state creation or any agent when the origin default branch ref is missing', async () => {
    const project = setupGitProject([story()]);
    const contractDirectory = join(project.projectRoot, '.coding-x');
    mkdirSync(contractDirectory);
    writeFileSync(join(contractDirectory, 'quality.json'), currentVersionContractFixture());
    execFileSync('git', ['add', '.coding-x/quality.json'], { cwd: project.projectRoot });
    execFileSync('git', ['commit', '-q', '-m', 'test: tracked quality contract'], {
      cwd: project.projectRoot,
    });
    const ready = readQualityContract(project.projectRoot);
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    const prdPath = join(project.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
    prd.qualityContractDigest = ready.digest;
    prd.qualityChecks = ready.contract.checks;
    writeFileSync(prdPath, JSON.stringify(prd));
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], {
      cwd: project.projectRoot,
    });
    const fake = fakeCounting(project.workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    const config = strictConfig(project.workspace, project.instructionsDir);
    delete config.qualityContractReader;

    expect(await runProductionLoop(config)).toBe(2);
    expect(existsSync(join(project.workspace, 'state.json'))).toBe(false);
    expect(existsSync(fake.calls)).toBe(false);
  }, 60_000);

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
          storyBaseGitHead: oldHead,
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
    const calls = join(project.projectRoot, 'bound-calls.txt');
    writeFileSync(calls, '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    expect(
      await runProductionLoop({
        ...strictConfig(project.workspace, project.instructionsDir),
        projectRoot: project.projectRoot,
      }),
    ).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(
      JSON.parse(readFileSync(join(project.workspace, 'state.json'), 'utf8'))['US-001'],
    ).toMatchObject({
      passes: true,
      validated: true,
      retryCount: 0,
      validationReceipt: { gitHead: newHead },
    });
  }, 60_000);

  it('invalidates a same-HEAD receipt when the frozen TDD policy changes', async () => {
    const target = story({ acceptanceCriteria: ['still works'] });
    const project = setupGitProject([target]);
    const head = project.head();
    const oldTdd = currentRepoTdd('node -e "process.exit(0)"', head);
    const newTdd = currentRepoTdd('node -e "process.exitCode = 0"', head);
    const oldEnvironment = digestCandidateStoryValidationEnvironment({
      contract: TEST_QUALITY_CONTRACT,
      headSha: head,
      defaultBranchGitHead: head,
      tddConfig: oldTdd as unknown as TddConfig,
      runtimeIdentity: { mode: 'formal', actualCodingXVersion: CODING_X_VERSION },
    });
    const newEnvironment = digestCandidateStoryValidationEnvironment({
      contract: TEST_QUALITY_CONTRACT,
      headSha: head,
      defaultBranchGitHead: head,
      tddConfig: newTdd as unknown as TddConfig,
      runtimeIdentity: { mode: 'formal', actualCodingXVersion: CODING_X_VERSION },
    });
    expect(newEnvironment).not.toBe(oldEnvironment);
    const receipt = validationReceiptFor(target, head);
    receipt.validationEnvironmentDigest = oldEnvironment;
    writeFileSync(
      join(project.workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head,
          validationReceipt: receipt,
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const prdPath = join(project.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
    prd.tdd = newTdd;
    writeFileSync(prdPath, JSON.stringify(prd));
    const fake = fakeBoundValidator(project.workspace, 'passed');
    const calls = join(project.projectRoot, 'bound-calls.txt');
    writeFileSync(calls, '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    expect(
      await runProductionLoop({
        ...strictConfig(project.workspace, project.instructionsDir),
        validationEnvironmentDigestForTests: undefined,
      }),
    ).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(
      JSON.parse(readFileSync(join(project.workspace, 'state.json'), 'utf8'))['US-001'],
    ).toMatchObject({
      validated: true,
      validationReceipt: { validationEnvironmentDigest: newEnvironment },
    });
  }, 30_000);

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
    writeFinalReviewFixture(workspace, previousFinalReview('b'.repeat(40)));
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
    const { workspace, instructionsDir, head } = setup([story()]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head(),
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    writeFinalReviewFixture(workspace, previousFinalReview('a'.repeat(40)));
    const fake = fakeBoundValidator(workspace, 'passed');
    const calls = join(resolve(workspace, '..'), 'bound-calls.txt');
    writeFileSync(calls, '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001']).toMatchObject(
      { passes: true, validated: true },
    );
    expect(existsSync(join(workspace, 'final-review.json'))).toBe(false);
  }, 60_000);

  it('does not repeat Story validation after the new head only waits for the remote PR', async () => {
    const { workspace, instructionsDir, head } = setup([story()]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head(),
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    writeFinalReviewFixture(workspace, previousFinalReview('a'.repeat(40)));
    const fake = fakeBoundValidator(workspace, 'passed');
    const calls = join(resolve(workspace, '..'), 'bound-calls.txt');
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
  }, 60_000);

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

  it('rejects an uncommitted quality contract even when PRD matches the weakened worktree copy', async () => {
    const project = setupGitProject([story()]);
    const contractDirectory = join(project.projectRoot, '.coding-x');
    mkdirSync(contractDirectory);
    const contractPath = join(contractDirectory, 'quality.json');
    writeFileSync(contractPath, currentVersionContractFixture());
    execFileSync('git', ['add', '.coding-x/quality.json'], { cwd: project.projectRoot });
    execFileSync('git', ['commit', '-q', '-m', 'test: tracked quality contract'], {
      cwd: project.projectRoot,
    });

    const weakened = JSON.parse(readFileSync(contractPath, 'utf8')) as QualityContract;
    weakened.localValidation.allowedPaths.push('poison/**');
    writeFileSync(contractPath, `${JSON.stringify(weakened, null, 2)}\n`);
    const worktreeRead = readQualityContract(project.projectRoot);
    expect(worktreeRead.status).toBe('ready');
    if (worktreeRead.status !== 'ready') return;
    const prdPath = join(project.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
    prd.qualityContractDigest = worktreeRead.digest;
    prd.qualityChecks = worktreeRead.contract.checks;
    writeFileSync(prdPath, JSON.stringify(prd));
    const fake = fakeCounting(project.workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    const config = strictConfig(project.workspace, project.instructionsDir);
    delete config.qualityContractReader;

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runProductionLoop(config)).toBe(2);
      expect(existsSync(fake.calls)).toBe(false);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('工作树质量契约未绑定当前 HEAD'),
      );
    } finally {
      error.mockRestore();
    }
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
          storyBaseGitHead: head(),
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
          validationReceipt: validationReceiptFor(target, head(), 'fixture-validator-request', {
            mode: 'shadow',
            actualCodingXVersion: CODING_X_VERSION,
          }),
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

  it.each([
    {
      name: 'shadow receipt is reused by formal mode',
      oldRuntime: { mode: 'shadow', actualCodingXVersion: CODING_X_VERSION } as const,
      nextRuntime: { mode: 'formal', actualCodingXVersion: CODING_X_VERSION } as const,
      shadow: false,
      expectedExit: 0,
    },
    {
      name: 'shadow receipt is reused by another candidate version',
      oldRuntime: { mode: 'shadow', actualCodingXVersion: '0.34.0' } as const,
      nextRuntime: { mode: 'shadow', actualCodingXVersion: '0.35.0' } as const,
      shadow: true,
      expectedExit: 7,
    },
  ])('revalidates instead of allowing $name', async ({ oldRuntime, nextRuntime, shadow, expectedExit }) => {
    const target = story({ acceptanceCriteria: ['still works'] });
    const project = setupGitProject([target]);
    const head = project.head();
    const oldReceipt = validationReceiptFor(target, head, 'old-runtime-receipt', oldRuntime);
    writeFileSync(join(project.workspace, 'state.json'), JSON.stringify({
      'US-001': {
        passes: true,
        validated: true,
        storyBaseGitHead: head,
        validationReceipt: oldReceipt,
        notes: 'candidate stays',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    }));
    const fake = fakeBoundValidator(project.workspace, 'passed');
    const calls = join(project.projectRoot, 'bound-calls.txt');
    writeFileSync(calls, '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    expect(await runProductionLoop({
      ...strictConfig(project.workspace, project.instructionsDir),
      projectRoot: project.projectRoot,
      shadow,
      actualVersion: nextRuntime.actualCodingXVersion,
    })).toBe(expectedExit);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    const state = JSON.parse(readFileSync(join(project.workspace, 'state.json'), 'utf8')) as Record<
      string,
      { validationReceipt: { validationEnvironmentDigest: string } }
    >;
    expect(state['US-001']?.validationReceipt.validationEnvironmentDigest).toBe(
      bindStoryValidationRuntimeIdentity(TEST_VALIDATION_ENVIRONMENT_DIGEST, nextRuntime),
    );
    expect(state['US-001']?.validationReceipt.validationEnvironmentDigest).not.toBe(
      oldReceipt.validationEnvironmentDigest,
    );
  }, 30_000);

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

  it('rejects a changed contract committed by Developer even when the worktree is restored', async () => {
    const project = setupGitProject([story()]);
    const contractDirectory = join(project.projectRoot, '.coding-x');
    mkdirSync(contractDirectory);
    const contractPath = join(contractDirectory, 'quality.json');
    const originalContract = currentVersionContractFixture();
    writeFileSync(contractPath, originalContract);
    execFileSync('git', ['add', '.coding-x/quality.json'], { cwd: project.projectRoot });
    execFileSync('git', ['commit', '-q', '-m', 'test: tracked quality contract'], {
      cwd: project.projectRoot,
    });
    const ready = readQualityContract(project.projectRoot);
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    const prdPath = join(project.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
    prd.qualityContractDigest = ready.digest;
    prd.qualityChecks = ready.contract.checks;
    writeFileSync(prdPath, JSON.stringify(prd));

    const fake = join(project.workspace, 'commit-weakened-contract.mjs');
    const calls = join(project.projectRoot, 'contract-attack-calls.txt');
    writeFileSync(
      fake,
      String.raw`
      import { execFileSync } from 'node:child_process';
      import { readFileSync, writeFileSync } from 'node:fs';
      const contractPath = ${JSON.stringify(contractPath)};
      const original = readFileSync(contractPath, 'utf8');
      const weakened = JSON.parse(original);
      weakened.localValidation.allowedPaths.push('poison/**');
      writeFileSync(contractPath, JSON.stringify(weakened, null, 2) + '\n');
      execFileSync('git', ['add', '.coding-x/quality.json'], { cwd: ${JSON.stringify(project.projectRoot)} });
      execFileSync('git', ['commit', '-q', '-m', 'test: change tracked contract'], { cwd: ${JSON.stringify(project.projectRoot)} });
      writeFileSync(contractPath, original);
      const statePath = ${JSON.stringify(join(project.workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = true;
      writeFileSync(statePath, JSON.stringify(state));
      writeFileSync(${JSON.stringify(calls)}, 'builder');
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const config = strictConfig(project.workspace, project.instructionsDir);
    delete config.qualityContractReader;

    expect(await runProductionLoop(config)).toBe(2);
    expect(readFileSync(calls, 'utf8')).toBe('builder');
    expect(readFileSync(contractPath, 'utf8')).toBe(originalContract);
    expect(
      execFileSync('git', ['show', 'HEAD:.coding-x/quality.json'], {
        cwd: project.projectRoot,
        encoding: 'utf8',
      }),
    ).toContain('poison/**');
  }, 60_000);
});

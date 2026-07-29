import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLoop as runProductionLoop, type LoopConfig } from './loop.js';
import { type QualityContract, type QualityContractReadResult } from '../quality/contract.js';
import { writeFinalReviewState } from '../review/state.js';
import { reviewRoutingDigest } from '../review/common.js';
import { appendEvidence, readEvidence } from './evidence.js';
import { execTrustedToolSync } from './trusted-tool.js';
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
  currentGitHead,
  passedStoryState,
} from './loop-test-support.js';

describe('quality contract preflight and shadow mode', () => {
  it('rejects an empty Story set before any agent or Final Review runs', async () => {
    const { workspace, instructionsDir } = setup([]);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    let finalReviewCalls = 0;

    expect(
      await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        finalReviewRunner: async () => {
          finalReviewCalls += 1;
          return { exitCode: 0, message: 'must not run' };
        },
      }),
    ).toBe(2);
    expect(existsSync(fake.calls)).toBe(false);
    expect(finalReviewCalls).toBe(0);
  });

  it.each([
    ['duplicate Story IDs', [story({ id: 'US-001' }), story({ id: ' US-001 ', priority: 2 })]],
    ['an empty acceptance-criteria list', [story({ acceptanceCriteria: [] })]],
    ['a blank acceptance criterion', [story({ acceptanceCriteria: ['  '] })]],
  ])('rejects %s before state selection or any agent', async (_name, stories) => {
    const { workspace, instructionsDir } = setup(stories);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    let finalReviewCalls = 0;

    expect(
      await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        finalReviewRunner: async () => {
          finalReviewCalls += 1;
          return { exitCode: 0, message: 'must not run' };
        },
      }),
    ).toBe(2);
    expect(existsSync(fake.calls)).toBe(false);
    expect(finalReviewCalls).toBe(0);
    expect(existsSync(join(workspace, 'state.json'))).toBe(false);
  });

  it('fails before any Story agent when a production final Review model is not explicit', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    const config = strictConfig(workspace, instructionsDir);
    delete config.finalReviewRunner;

    expect(await runProductionLoop(config)).toBe(2);
    expect(existsSync(fake.calls)).toBe(false);
  });

  it('returns blocked without requiring or resolving a Reviewer that cannot run', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: false,
          validated: false,
          validationReceipt: null,
          notes: '[需要人工核实] 产品决定',
          retryCount: 0,
          blocked: true,
          escalated: false,
        },
      }),
    );
    process.env.CODING_X_CLAUDE_BIN = join(workspace, 'missing-reviewer-must-not-run');
    const config = strictConfig(workspace, instructionsDir);
    delete config.finalReviewRunner;

    try {
      expect(await runProductionLoop(config)).toBe(3);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it.runIf(process.platform !== 'win32')(
    'freezes the production Reviewer before the first Builder and project quality check',
    async () => {
      const { workspace, instructionsDir } = setup([story()]);
      const events = join(workspace, 'runner-order.txt');
      const prdPath = join(workspace, 'prd.json');
      const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
      prd.qualityChecks = [
        `node -e ${JSON.stringify(
          `require('node:fs').appendFileSync(${JSON.stringify(events)},'gate\\n')`,
        )}`,
      ];
      writeFileSync(prdPath, JSON.stringify(prd));
      const statePath = join(workspace, 'state.json');
      const progressPath = join(workspace, 'progress.md');
      const fakeRunner = join(workspace, 'formal-claude');
      const source = join(workspace, 'formal-claude.c');
      writeFileSync(
        source,
        `
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      FILE *events = fopen(${JSON.stringify(events)}, "a");
      fputs("freeze\\n", events); fclose(events);
      puts("claude-test 1.0.0");
      return 0;
    }
  }
  FILE *events = fopen(${JSON.stringify(events)}, "a");
  fputs("agent\\n", events); fclose(events);
  FILE *state = fopen(${JSON.stringify(statePath)}, "w");
  fputs("{\\\"US-001\\\":{\\\"passes\\\":true,\\\"notes\\\":\\\"\\\",\\\"retryCount\\\":0,\\\"blocked\\\":false}}", state);
  fclose(state);
  FILE *progress = fopen(${JSON.stringify(progressPath)}, "a");
  fputs("agent progress\\n", progress); fclose(progress);
  return 0;
}
`,
      );
      execFileSync('cc', [source, '-o', fakeRunner]);
      chmodSync(fakeRunner, 0o755);
      process.env.CODING_X_CLAUDE_BIN = fakeRunner;
      const config = strictConfig(workspace, instructionsDir);
      delete config.finalReviewRunner;
      config.reviewModel = 'review-model';
      config.legacyValidatorProtocolForTests = true;
      config.modelCatalog = async () => ({
        status: 'available',
        runner: 'claude',
        source: 'global-config',
        configPath: '/fixture/config.json',
        models: [{ id: 'review-model' }],
      });

      try {
        await runProductionLoop(config);
        const order = readFileSync(events, 'utf8').trim().split('\n');
        expect(order[0]).toBe('freeze');
        expect(order.indexOf('agent')).toBeGreaterThan(0);
        expect(order.indexOf('gate')).toBeGreaterThan(order.indexOf('agent'));
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps Validator and gh on their startup identities after Builder adds project-local fakes',
    async () => {
      const { workspace, instructionsDir } = setup([story()]);
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-agent-freeze-project-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-agent-freeze-external-'));
      const projectBin = join(projectRoot, 'node_modules', '.bin');
      const externalBin = join(externalRoot, 'bin');
      const runner = join(externalBin, 'claude');
      const runnerSource = join(externalRoot, 'claude.c');
      const trustedGh = join(externalBin, 'gh');
      const trustedGhSource = join(externalRoot, 'gh.c');
      const calls = join(workspace, 'frozen-agent-calls');
      const statePath = join(workspace, 'state.json');
      const progressPath = join(workspace, 'progress.md');
      const fakeRunnerMarker = join(projectRoot, 'fake-runner-executed');
      const fakeGhMarker = join(projectRoot, 'fake-gh-executed');
      const trustedGhMarker = join(externalRoot, 'trusted-gh-executed');
      const originalPath = process.env.PATH;
      const originalRunner = process.env.CODING_X_CLAUDE_BIN;
      try {
        mkdirSync(projectBin, { recursive: true });
        mkdirSync(externalBin, { recursive: true });
        execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'coding-x-test'], { cwd: projectRoot });
        execFileSync('git', ['config', 'user.email', 'coding-x-test@example.invalid'], {
          cwd: projectRoot,
        });
        writeFileSync(join(projectRoot, 'source.txt'), 'initial\n');
        execFileSync('git', ['add', 'source.txt'], { cwd: projectRoot });
        execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectRoot, stdio: 'ignore' });
        writeFileSync(
          runnerSource,
          `
#include <stdio.h>
#include <sys/stat.h>
int main(void) {
  int call = 0;
  FILE *existing = fopen(${JSON.stringify(calls)}, "r");
  if (existing != NULL) { fscanf(existing, "%d", &call); fclose(existing); }
  call += 1;
  FILE *count = fopen(${JSON.stringify(calls)}, "w");
  fprintf(count, "%d", call); fclose(count);
  if (call == 1) {
    FILE *fakeRunner = fopen(${JSON.stringify(join(projectBin, 'claude'))}, "w");
    fputs("#!/bin/sh\\nprintf fake > ${fakeRunnerMarker}\\n", fakeRunner); fclose(fakeRunner);
    chmod(${JSON.stringify(join(projectBin, 'claude'))}, 0755);
    FILE *fakeGh = fopen(${JSON.stringify(join(projectBin, 'gh'))}, "w");
    fputs("#!/bin/sh\\nprintf fake > ${fakeGhMarker}\\n", fakeGh); fclose(fakeGh);
    chmod(${JSON.stringify(join(projectBin, 'gh'))}, 0755);
    FILE *state = fopen(${JSON.stringify(statePath)}, "w");
    fputs("{\\\"US-001\\\":{\\\"passes\\\":true,\\\"notes\\\":\\\"\\\",\\\"retryCount\\\":0,\\\"blocked\\\":false}}", state);
    fclose(state);
    FILE *progress = fopen(${JSON.stringify(progressPath)}, "a");
    fputs("builder progress\\n", progress); fclose(progress);
  }
  return 0;
}
`,
        );
        execFileSync('cc', [runnerSource, '-o', runner]);
        chmodSync(runner, 0o755);
        writeFileSync(
          trustedGhSource,
          `
#include <stdio.h>
int main(void) {
  FILE *marker = fopen(${JSON.stringify(trustedGhMarker)}, "w");
  fputs("trusted", marker); fclose(marker);
  puts("trusted-gh");
  return 0;
}
`,
        );
        execFileSync('cc', [trustedGhSource, '-o', trustedGh]);
        chmodSync(trustedGh, 0o755);
        process.env.CODING_X_CLAUDE_BIN = 'claude';
        process.env.PATH = [projectBin, externalBin, originalPath ?? '']
          .filter(Boolean)
          .join(delimiter);
        const config = strictConfig(workspace, instructionsDir);
        config.projectRoot = projectRoot;
        config.legacyValidatorProtocolForTests = true;
        config.unsafeSkipAgentExecutableFreezeForTests = false;
        config.finalReviewRunner = async () => {
          expect(execTrustedToolSync('gh', ['proof'], { projectRoot }).trim()).toBe('trusted-gh');
          return { exitCode: 0, message: 'frozen identities held' };
        };

        expect(await runProductionLoop(config)).toBe(0);
        expect(readFileSync(calls, 'utf8')).toBe('2');
        expect(readFileSync(trustedGhMarker, 'utf8')).toBe('trusted');
        expect(existsSync(fakeRunnerMarker)).toBe(false);
        expect(existsSync(fakeGhMarker)).toBe(false);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (originalRunner === undefined) delete process.env.CODING_X_CLAUDE_BIN;
        else process.env.CODING_X_CLAUDE_BIN = originalRunner;
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it('does not resolve a real Reviewer when Final Review is explicitly injected for tests', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({ 'US-001': passedStoryState() }));
    process.env.CODING_X_CLAUDE_BIN = join(workspace, 'missing-reviewer-must-not-be-resolved');
    let finalReviewCalls = 0;
    try {
      const result = await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        finalReviewRunner: async () => {
          finalReviewCalls += 1;
          return { exitCode: 0, message: 'explicit injected review' };
        },
      });
      expect(result).toBe(0);
      expect(finalReviewCalls).toBe(1);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('invalidates a stale receipt even without a previous final Review and skips Developer', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': passedStoryState('US-001', [], 'a'.repeat(40)),
      }),
    );
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(0);
    expect(readFileSync(join(workspace, 'bound-calls.txt'), 'utf8')).toBe('1');
    const finalState = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'];
    expect(finalState).toMatchObject({
      passes: true,
      validated: true,
      validationReceipt: { gitHead: currentGitHead() },
    });
    expect(
      readEvidence(workspace).records.find((record) => record.type === 'iteration'),
    ).toMatchObject({ builderRan: false, validatorRan: true, validationReceipt: true });
  });

  it('never reconstructs a missing receipt from old evidence or a previous Final Review', async () => {
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
    appendEvidence(workspace, {
      type: 'validation-claim',
      source: 'validator',
      at: '2026-07-29T00:00:00.000Z',
      iteration: 1,
      requestId: 'old-evidence',
      storyId: 'US-001',
      acceptanceHash: `sha256:${'b'.repeat(64)}`,
      gitHead: currentGitHead(),
      verdict: 'passed',
      checks: [],
      summary: 'historical claim only',
    });
    writeFinalReviewState(workspace, previousFinalReview(currentGitHead()));
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(0);
    expect(readFileSync(join(workspace, 'bound-calls.txt'), 'utf8')).toBe('1');
    expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001']).toMatchObject(
      {
        passes: true,
        validated: true,
        validationReceipt: { requestId: expect.not.stringMatching(/^old-/) },
      },
    );
  });

  it('does not invalidate a current Story receipt merely because an old final Review is stale', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({ 'US-001': passedStoryState() }));
    writeFinalReviewState(workspace, previousFinalReview('a'.repeat(40)));
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;

    expect(await runLoop(strictConfig(workspace, instructionsDir))).toBe(0);
    expect(existsSync(fake.calls)).toBe(false);
    expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001']).toEqual(
      passedStoryState(),
    );
  });

  it('increments the Final Review round before invalidating the previous result', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({ 'US-001': passedStoryState() }));
    writeFinalReviewState(workspace, previousFinalReview(currentGitHead()));
    let observedRound: number | null = null;

    expect(
      await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        finalReviewRunner: async (options) => {
          observedRound = options.reviewRound;
          return { exitCode: 0, message: 'round captured' };
        },
      }),
    ).toBe(0);
    expect(observedRound).toBe(2);
  });

  it('fails closed and removes a green Review when the final PRD snapshot cannot be restored', async () => {
    const current = story();
    const { workspace, instructionsDir } = setup([current]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': passedStoryState('US-001', current.acceptanceCriteria),
      }),
    );

    expect(
      await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        finalReviewRunner: async () => {
          writeFinalReviewState(workspace, previousFinalReview(currentGitHead()));
          rmSync(join(workspace, 'prd.json'), { force: true });
          mkdirSync(join(workspace, 'prd.json'));
          return { exitCode: 0, message: 'must be invalidated during closeout' };
        },
      }),
    ).toBe(2);
    expect(existsSync(join(workspace, 'final-review.json'))).toBe(false);
  });

  it('does not repeat Story validation after the new head only waits for the remote PR', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({ 'US-001': passedStoryState() }));
    writeFinalReviewState(workspace, previousFinalReview('a'.repeat(40)));
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    let finalReviewCalls = 0;
    const config: LoopConfig = {
      ...strictConfig(workspace, instructionsDir),
      finalReviewRunner: async (options) => {
        expect(options.reviewRoutingDigest).toBe(reviewRoutingDigest(undefined));
        expect(options.validateStoryReceipts()).toMatchObject({
          ok: true,
          digest: expect.stringMatching(/^sha256:/),
        });
        finalReviewCalls += 1;
        return finalReviewCalls === 1
          ? { exitCode: 6, message: 'fixture remote PR 尚未就绪' }
          : { exitCode: 0, message: 'fixture final review passed' };
      },
    };

    expect(await runProductionLoop(config)).toBe(6);
    expect(existsSync(fake.calls)).toBe(false);
    expect(existsSync(join(workspace, 'final-review.json'))).toBe(false);

    expect(await runProductionLoop(config)).toBe(0);
    expect(existsSync(fake.calls)).toBe(false);
    expect(finalReviewCalls).toBe(2);
  });

  it('rejects an injected Final Review result when Story receipts change during the call', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const statePath = join(workspace, 'state.json');
    writeFileSync(statePath, JSON.stringify({ 'US-001': passedStoryState() }));
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;

    expect(
      await runProductionLoop({
        ...strictConfig(workspace, instructionsDir),
        finalReviewRunner: async () => {
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          state['US-001'].validationReceipt.requestId = 'changed-during-review';
          writeFileSync(statePath, JSON.stringify(state));
          return { exitCode: 0, message: 'must be invalidated' };
        },
      }),
    ).toBe(5);
    expect(existsSync(fake.calls)).toBe(false);
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
    const { workspace, instructionsDir } = setup([story({ passes: true })]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({ 'US-001': passedStoryState() }));
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

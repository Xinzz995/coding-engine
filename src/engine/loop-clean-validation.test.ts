import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLoop } from './loop.js';
import { readEvidence } from './evidence.js';
import type { QualityContract } from '../quality/contract.js';
import {
  fakeBoundValidator,
  currentRepoTdd,
  readyQualityContract,
  setupGitProject,
  story,
  strictConfig,
  TEST_QUALITY_CONTRACT,
} from './loop-test-support.js';

describe('runLoop clean validation checkout', () => {
  it('does not report Validator unverifiable when no candidate exists yet', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
    const fake = join(fixture.workspace, 'builder-without-candidate.mjs');
    writeFileSync(
      fake,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(
        join(fixture.workspace, 'progress.md'),
      )}, 'builder made progress without a candidate\\n');\n`,
    );
    const contract = {
      ...TEST_QUALITY_CONTRACT,
      checks: {
        ...TEST_QUALITY_CONTRACT.checks,
        test: {
          checks: [
            {
              id: 'pollute-before-candidate',
              module: 'root',
              command: {
                executable: process.execPath,
                args: [
                  '--input-type=module',
                  '-e',
                  "import { writeFileSync } from 'node:fs'; writeFileSync('unexpected-without-candidate.txt', 'x');",
                ],
                cwd: '.',
                platforms: ['linux', 'macos', 'windows'],
                timeoutMs: 5000,
              },
            },
          ],
        },
      },
    } as QualityContract;
    const prdPath = join(fixture.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.qualityChecks = contract.checks;
    writeFileSync(prdPath, JSON.stringify(prd));
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
          qualityContractReader: () => readyQualityContract(contract),
        }),
      ).toBe(1);
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: false,
        validated: false,
        validationReceipt: null,
        validatorUnverifiable: null,
      });
      const iteration = readEvidence(fixture.workspace).records.find(
        (record) => record.type === 'iteration',
      );
      expect(iteration).toMatchObject({
        builderOutcome: 'completed',
        validatorOutcome: 'skipped',
      });
      expect(iteration).not.toHaveProperty('validationProtocol');
      expect(iteration).not.toHaveProperty('validationProtocolError');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 60_000);

  it('isolates before Validator when the conservative report target is not a regular file', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
    const fake = fakeBoundValidator(fixture.workspace, 'passed');
    const calls = join(fixture.projectRoot, 'bound-calls.txt');
    mkdirSync(join(fixture.workspace, 'report.html'));
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
        }),
      ).toBe(2);
      expect(readFileSync(calls, 'utf8')).toBe('1');
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 60_000);

  it('records completed gate facts before rejecting a polluted validation checkout', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
    const contract = {
      ...TEST_QUALITY_CONTRACT,
      checks: {
        ...TEST_QUALITY_CONTRACT.checks,
        test: {
          checks: [
            {
              id: 'pollute-after-gate',
              module: 'root',
              command: {
                executable: process.execPath,
                args: [
                  '--input-type=module',
                  '-e',
                  "import { writeFileSync } from 'node:fs'; writeFileSync('unexpected-after-gate.txt', 'x');",
                ],
                cwd: '.',
                platforms: ['linux', 'macos', 'windows'],
                timeoutMs: 5000,
              },
            },
          ],
        },
      },
    } as QualityContract;
    const prdPath = join(fixture.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.qualityChecks = contract.checks;
    writeFileSync(prdPath, JSON.stringify(prd));
    const fake = fakeBoundValidator(fixture.workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
          qualityContractReader: () => readyQualityContract(contract),
        }),
      ).toBe(5);
      const evidence = readEvidence(fixture.workspace).records;
      const gateIndex = evidence.findIndex((record) => record.type === 'gate-run');
      const iterationIndex = evidence.findIndex((record) => record.type === 'iteration');
      expect(gateIndex).toBeGreaterThanOrEqual(0);
      expect(iterationIndex).toBeGreaterThan(gateIndex);
      expect(evidence[gateIndex]).toMatchObject({
        type: 'gate-run',
        ok: true,
        ran: 1,
        accepted: false,
        runId: expect.any(String),
      });
      expect(evidence[iterationIndex]).toMatchObject({
        type: 'iteration',
        validatorRan: false,
        validatorOutcome: 'skipped',
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'environment-unverifiable' },
        runId: (evidence[gateIndex] as { runId: string }).runId,
      });
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
        validatorUnverifiable: { schemaVersion: 1, gitHead: fixture.head() },
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 60_000);

  it('records completed TDD facts before rejecting a polluted validation checkout', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
    const prdPath = join(fixture.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.tdd = currentRepoTdd(
      `node -e "require('node:fs').writeFileSync('unexpected-after-tdd.txt', 'x')"`,
      fixture.head(),
    );
    writeFileSync(prdPath, JSON.stringify(prd));
    const fake = fakeBoundValidator(fixture.workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
        }),
      ).toBe(5);
      const evidence = readEvidence(fixture.workspace).records;
      const tddIndex = evidence.findIndex(
        (record) => record.type === 'tdd-gate' && record.phase === 'post-builder',
      );
      const iterationIndex = evidence.findIndex((record) => record.type === 'iteration');
      expect(tddIndex).toBeGreaterThanOrEqual(0);
      expect(iterationIndex).toBeGreaterThan(tddIndex);
      expect(evidence[tddIndex]).toMatchObject({
        type: 'tdd-gate',
        ok: true,
        policyOk: true,
        commandRan: true,
        commandOk: true,
        accepted: false,
        runId: expect.any(String),
      });
      expect(evidence[iterationIndex]).toMatchObject({
        type: 'iteration',
        validatorRan: false,
        validatorOutcome: 'skipped',
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'environment-unverifiable' },
        runId: (evidence[tddIndex] as { runId: string }).runId,
      });
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
        validatorUnverifiable: { schemaVersion: 1, gitHead: fixture.head() },
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 60_000);

  it('keeps a relative CLI workspace bound to the canonical managed directory after Validator changes cwd', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['relative workspace works'] })]);
    const validatorCwdMarker = join(fixture.instructionsDir, 'relative-validator-cwd.txt');
    const environmentMarker = join(fixture.instructionsDir, 'relative-environment.jsonl');
    const fake = fakeBoundValidator(fixture.workspace, 'passed', {
      validatorCwdMarker,
      environmentMarker,
    });
    const originalCwd = process.cwd();
    let reviewWorkspace = '';
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      process.chdir(fixture.projectRoot);
      const code = await runLoop({
        ...strictConfig('.workspace', fixture.instructionsDir),
        unsafeUseProjectRootForValidationTests: false,
        unsafeAllowProjectScopedRunnerForValidationTests: true,
        validationEnvironmentDigestForTests: undefined,
        finalReviewRunner: async (options) => {
          reviewWorkspace = options.workspace;
          return { exitCode: 0, message: 'fixture final review passed' };
        },
      });
      expect(code).toBe(0);
      expect(reviewWorkspace).toBe(realpathSync.native(fixture.workspace));
      expect(existsSync(join(fixture.workspace, 'validation-result.json'))).toBe(false);
      expect(
        readFileSync(environmentMarker, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { workspace: string })
          .every((entry) => entry.workspace === realpathSync.native(fixture.workspace)),
      ).toBe(true);
      expect(
        relative(fixture.projectRoot, readFileSync(validatorCwdMarker, 'utf8')).startsWith('..'),
      ).toBe(true);
    } finally {
      process.chdir(originalCwd);
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 60_000);

  it('keeps Developer in the source tree but runs Validator against the exact clean HEAD', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
    const builderCwdMarker = join(fixture.instructionsDir, 'builder-cwd.txt');
    const validatorCwdMarker = join(fixture.instructionsDir, 'validator-cwd.txt');
    const validatorVisibilityMarker = join(fixture.instructionsDir, 'validator-visible.json');
    const environmentMarker = join(fixture.instructionsDir, 'agent-environment.jsonl');
    const tddMarker = join(fixture.instructionsDir, 'tdd-cwd.json');
    writeFileSync(
      join(fixture.projectRoot, '.gitignore'),
      '.workspace/\n.env\n.claude/\nnode_modules/\n',
    );
    writeFileSync(
      join(fixture.projectRoot, 'tdd-check.mjs'),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "const hidden = ['.env', '.claude', 'node_modules'].filter((path) => existsSync(path));",
        `writeFileSync(${JSON.stringify(tddMarker)}, JSON.stringify({ cwd: process.cwd(), hidden, virtualEnv: process.env.VIRTUAL_ENV ?? null, pythonPath: process.env.PYTHONPATH ?? null, nodePath: process.env.NODE_PATH ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, path: process.env.PATH ?? '' }));`,
        'if (hidden.length > 0) process.exit(9);',
      ].join('\n'),
    );
    execFileSync('git', ['add', '.gitignore', 'tdd-check.mjs'], { cwd: fixture.projectRoot });
    execFileSync('git', ['commit', '-q', '-m', 'test: ignore developer files'], {
      cwd: fixture.projectRoot,
    });
    const prdPath = join(fixture.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.tdd = currentRepoTdd('node tdd-check.mjs', fixture.head());
    writeFileSync(prdPath, JSON.stringify(prd));
    writeFileSync(join(fixture.projectRoot, '.env'), 'LOCAL_SECRET=1\n');
    mkdirSync(join(fixture.projectRoot, '.claude'));
    writeFileSync(join(fixture.projectRoot, '.claude', 'settings.json'), '{}\n');
    mkdirSync(join(fixture.projectRoot, 'node_modules'));
    writeFileSync(join(fixture.projectRoot, 'node_modules', 'stale.js'), 'stale\n');
    writeFileSync(join(fixture.projectRoot, 'ignored-hook.cjs'), 'module.exports = {};\n');

    const fake = fakeBoundValidator(fixture.workspace, 'passed', {
      builderCwdMarker,
      validatorCwdMarker,
      validatorVisibilityMarker,
      environmentMarker,
    });
    const contaminatedNames = [
      'VIRTUAL_ENV',
      'PYTHONPATH',
      'NODE_PATH',
      'NODE_OPTIONS',
      'PATH',
    ] as const;
    const savedEnvironment = Object.fromEntries(
      contaminatedNames.map((name) => [name, process.env[name]]),
    );
    process.env.VIRTUAL_ENV = join(fixture.projectRoot, '.venv');
    process.env.PYTHONPATH = fixture.projectRoot;
    process.env.NODE_PATH = join(fixture.projectRoot, 'node_modules');
    process.env.NODE_OPTIONS = `--require=${join(fixture.projectRoot, 'ignored-hook.cjs')}`;
    process.env.PATH = `${join(fixture.projectRoot, '.venv', 'bin')}${delimiter}${savedEnvironment.PATH ?? ''}`;
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        ...strictConfig(fixture.workspace, fixture.instructionsDir),
        unsafeUseProjectRootForValidationTests: false,
        unsafeAllowProjectScopedRunnerForValidationTests: true,
        validationEnvironmentDigestForTests: undefined,
      });
      expect(code).toBe(0);
      const canonicalProjectRoot = realpathSync.native(fixture.projectRoot);
      const builderRoot = readFileSync(builderCwdMarker, 'utf8');
      expect(realpathSync.native(builderRoot)).toBe(canonicalProjectRoot);
      const validatorRoot = readFileSync(validatorCwdMarker, 'utf8');
      expect(relative(canonicalProjectRoot, validatorRoot).startsWith('..')).toBe(true);
      expect(JSON.parse(readFileSync(validatorVisibilityMarker, 'utf8'))).toEqual({
        env: false,
        claude: false,
        nodeModules: false,
        virtualEnv: null,
        pythonPath: null,
        nodePath: null,
        nodeOptions: null,
        path: expect.not.stringContaining(fixture.projectRoot),
      });
      expect(JSON.parse(readFileSync(tddMarker, 'utf8'))).toMatchObject({
        cwd: validatorRoot,
        hidden: [],
        virtualEnv: null,
        pythonPath: null,
        nodePath: null,
        nodeOptions: null,
        path: expect.not.stringContaining(fixture.projectRoot),
      });
      const agentEnvironments = readFileSync(environmentMarker, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { workspace: string; projectRoot: string });
      expect(agentEnvironments[0]).toEqual({
        workspace: realpathSync.native(fixture.workspace),
        projectRoot: fixture.projectRoot,
      });
      expect(agentEnvironments[1]).toMatchObject({
        workspace: realpathSync.native(fixture.workspace),
      });
      expect(agentEnvironments[1].projectRoot).not.toBe(fixture.projectRoot);
      expect(agentEnvironments[1].projectRoot).toMatch(
        /coding-x-validation-[^/\\]+[/\\]checkout$/u,
      );
      const state = JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8')) as {
        'US-001': {
          validated: boolean;
          validationReceipt: {
            schemaVersion: number;
            gitHead: string;
            validationEnvironmentDigest: string;
          };
        };
      };
      expect(state['US-001']).toMatchObject({
        validated: true,
        validationReceipt: {
          schemaVersion: 2,
          gitHead: fixture.head(),
          validationEnvironmentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      });
      expect(existsSync(validatorRoot)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
      for (const name of contaminatedNames) {
        const value = savedEnvironment[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 60_000);

  it('removes the clean checkout when Validator returns without a usable result', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
    const validatorCwdMarker = join(fixture.instructionsDir, 'validator-cwd-failed.txt');
    const fake = fakeBoundValidator(fixture.workspace, 'missing', { validatorCwdMarker });
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        ...strictConfig(fixture.workspace, fixture.instructionsDir),
        unsafeUseProjectRootForValidationTests: false,
        unsafeAllowProjectScopedRunnerForValidationTests: true,
        validationEnvironmentDigestForTests: undefined,
      });
      expect(code).toBe(5);
      const validatorRoot = readFileSync(validatorCwdMarker, 'utf8');
      expect(validatorRoot).toMatch(/coding-x-validation-[^/\\]+[/\\]checkout$/u);
      expect(existsSync(validatorRoot)).toBe(false);
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
        validatorUnverifiable: { schemaVersion: 1, gitHead: fixture.head() },
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 60_000);

  it.each([
    {
      label: '改写受跟踪文件',
      mutate: (root: string) => writeFileSync(join(root, 'source.txt'), 'changed after review\n'),
    },
    {
      label: '新增未声明文件',
      mutate: (root: string) => writeFileSync(join(root, 'unexpected-before-receipt.txt'), 'x'),
    },
  ])(
    '在签发前$label时拒绝 Validator 结果',
    async ({ mutate }) => {
      const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
      const fake = fakeBoundValidator(fixture.workspace, 'passed');
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
      try {
        const code = await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
          beforeValidationCheckoutCleanupForTests: mutate,
        });

        expect(code).not.toBe(0);
        expect(
          JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
        ).toMatchObject({ validated: false, validationReceipt: null });
        const iteration = readEvidence(fixture.workspace).records.find(
          (record) => record.type === 'iteration',
        );
        expect(iteration).toMatchObject({
          validationProtocol: 'invalid',
          validationProtocolError: { code: 'artifact-changed' },
        });
        expect(iteration && 'validationReceipt' in iteration).toBe(false);
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'isolates a topology failure discovered immediately before the Validator request',
    async () => {
      const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
      const fake = fakeBoundValidator(fixture.workspace, 'passed');
      const calls = join(fixture.projectRoot, 'bound-calls.txt');
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
      try {
        const first = await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
          beforeValidatorRequestForTests: (root) => {
            mkdirSync(join(root, 'node_modules'), { recursive: true });
            symlinkSync(
              join(fixture.projectRoot, 'source.txt'),
              join(root, 'node_modules', 'developer-source.txt'),
            );
          },
        });
        expect(first).toBe(2);
        expect(readFileSync(calls, 'utf8')).toBe('1');
        expect(
          JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
        ).toMatchObject({
          passes: true,
          validated: false,
          validationReceipt: null,
        });

        const second = await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
        });
        expect(second).toBe(2);
        expect(readFileSync(calls, 'utf8')).toBe('1');
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    90_000,
  );

  it('isolates the workspace and refuses reuse when a validated checkout cannot be safely cleaned', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
    const fake = fakeBoundValidator(fixture.workspace, 'passed');
    const calls = join(fixture.projectRoot, 'bound-calls.txt');
    let originalContainer = '';
    let escapedCheckout = '';
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const first = await runLoop({
        ...strictConfig(fixture.workspace, fixture.instructionsDir),
        unsafeUseProjectRootForValidationTests: false,
        unsafeAllowProjectScopedRunnerForValidationTests: true,
        validationEnvironmentDigestForTests: undefined,
        beforeValidationCheckoutCleanupForTests: (root) => {
          originalContainer = join(root, '..');
          escapedCheckout = `${root}-escaped`;
          renameSync(root, escapedCheckout);
          mkdirSync(root);
        },
      });
      expect(first).toBe(2);
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ validated: false, validationReceipt: null });
      expect(readFileSync(join(fixture.workspace, 'report.html'), 'utf8')).toContain(
        '本次运行尚未完成最终安全清理',
      );

      rmSync(escapedCheckout, { recursive: true, force: true });
      rmSync(originalContainer, { recursive: true, force: true });
      rmSync(calls, { force: true });
      const second = await runLoop({
        ...strictConfig(fixture.workspace, fixture.instructionsDir),
        unsafeUseProjectRootForValidationTests: false,
        unsafeAllowProjectScopedRunnerForValidationTests: true,
        validationEnvironmentDigestForTests: undefined,
      });
      expect(second).toBe(2);
      expect(existsSync(calls)).toBe(false);
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ validated: false, validationReceipt: null });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
      if (escapedCheckout) rmSync(escapedCheckout, { recursive: true, force: true });
      if (originalContainer) rmSync(originalContainer, { recursive: true, force: true });
    }
  }, 90_000);

  it.runIf(process.platform !== 'win32')(
    'isolates the workspace when the clean checkout links back to the developer tree',
    async () => {
      const fixture = setupGitProject([story({ acceptanceCriteria: ['source is verified'] })]);
      const fake = fakeBoundValidator(fixture.workspace, 'passed');
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
      try {
        const first = await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
          beforeValidationCheckoutCleanupForTests: (root) => {
            mkdirSync(join(root, 'node_modules'), { recursive: true });
            symlinkSync(
              join(fixture.projectRoot, 'source.txt'),
              join(root, 'node_modules', 'developer-source.txt'),
            );
          },
        });
        expect(first).toBe(2);
        expect(
          JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
        ).toMatchObject({
          passes: true,
          validated: false,
          validationReceipt: null,
        });

        const second = await runLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          unsafeUseProjectRootForValidationTests: false,
          unsafeAllowProjectScopedRunnerForValidationTests: true,
          validationEnvironmentDigestForTests: undefined,
        });
        expect(second).toBe(2);
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    90_000,
  );
});

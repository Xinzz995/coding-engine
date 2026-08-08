import { resolve } from 'node:path';
import type { QualityContract } from '../../quality/contract.js';
import { CODING_X_VERSION } from '../../version.js';
import { runLoop } from '../loop.js';

const workspace = resolve(process.argv[2] ?? '');
const instructionsDir = resolve(process.argv[3] ?? '');
if (!workspace || !instructionsDir) throw new Error('workspace and instructions are required');

const qualityDigest = `sha256:${'a'.repeat(64)}`;
const validationEnvironmentDigest = `sha256:${'e'.repeat(64)}`;
const qualityContract = {
  codingXVersion: CODING_X_VERSION,
  checks: {
    test: {
      checks: [
        {
          id: 'fixture-pass',
          module: 'root',
          command: {
            executable: process.execPath,
            args: ['--input-type=module', '-e', 'process.exit(0)'],
            cwd: '.',
            platforms: ['linux', 'macos', 'windows'],
            timeoutMs: 5_000,
          },
        },
      ],
    },
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
  },
  generatedPaths: [],
  localValidation: { prepare: [], allowedPaths: [] },
} as unknown as QualityContract;

const code = await runLoop({
  kind: 'claude',
  maxIterations: 2,
  devTimeoutMs: 60_000,
  valTimeoutMs: 60_000,
  workspace,
  projectRoot: resolve(workspace, '..'),
  instructionsDir,
  port: 0,
  openBrowser: false,
  qualityContractReader: () => ({
    status: 'ready',
    path: resolve(workspace, '..', '.coding-x', 'quality.json'),
    contract: qualityContract,
    digest: qualityDigest,
  }),
  finalReviewRunner: () => Promise.resolve({ exitCode: 0, message: 'fixture final review passed' }),
  unsafeUseProjectRootForValidationTests: true,
  validationEnvironmentDigestForTests: validationEnvironmentDigest,
});

process.exitCode = code;

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean | string;
}

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps?: WorkflowStep[];
  'continue-on-error'?: boolean | string;
}

interface WorkflowDocument {
  jobs: Record<string, WorkflowJob>;
}

function workflow(name: string): string {
  return readFileSync(resolve('.github/workflows', name), 'utf8');
}

function parsedWorkflow(name: string): WorkflowDocument {
  const parsed: unknown = parse(workflow(name));
  if (!parsed || typeof parsed !== 'object' || !('jobs' in parsed)) {
    throw new Error(`${name} did not parse as a GitHub workflow`);
  }
  return parsed as WorkflowDocument;
}

function stepWithRun(job: WorkflowJob, text: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.run?.includes(text));
  if (!step) throw new Error(`workflow job does not contain run command: ${text}`);
  return step;
}

function expectNoContinueOnError(job: WorkflowJob): void {
  expect(job['continue-on-error']).toBeUndefined();
  for (const step of job.steps ?? []) expect(step['continue-on-error']).toBeUndefined();
}

function sparseCheckoutPaths(job: WorkflowJob): readonly string[] {
  const checkout = job.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
  const sparseCheckout = checkout?.with?.['sparse-checkout'];
  if (typeof sparseCheckout !== 'string') throw new Error('checkout step has no sparse-checkout');
  return sparseCheckout
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean);
}

function localBuildImports(path: string): readonly string[] {
  const source = readFileSync(resolve(path), 'utf8');
  return [...source.matchAll(/from '\.\/(?<path>[^']+)'/gu)].map(
    (match) => `build/${match.groups?.path ?? ''}`,
  );
}

describe('release candidate workflow boundaries', () => {
  it('builds and preserves a candidate without any npm publishing identity', () => {
    const source = workflow('build-candidate.yml');
    const jobs = parsedWorkflow('build-candidate.yml').jobs;
    const prepare = jobs.prepare;
    const platformInstall = jobs.platform_install;
    const candidateReady = jobs.candidate_ready;

    expect(source).toContain('npm run typecheck');
    expect(source).toContain('npm test');
    expect(source).toContain('record-pack');
    expect(source).toContain('--candidate-workflow-run-id');
    expect(source).toContain('npm-candidate-${{ inputs.version }}');
    expect(source).toContain('runs-on: ubuntu-24.04');
    expect(platformInstall.strategy?.matrix?.include).toEqual([
      { os: 'ubuntu-24.04', platform: 'linux' },
      { os: 'macos-26', platform: 'macos' },
      { os: 'windows-2022', platform: 'windows' },
    ]);
    expect(source).toContain('node-version: 22');
    expect(platformInstall.needs).toBe('prepare');
    expect(source).toContain('verify-tarball');
    expect(source).toContain('candidate-install-smoke.mjs');
    expect(stepWithRun(platformInstall, 'candidate-install-smoke.mjs').if).toBeUndefined();
    expect(candidateReady.needs).toEqual(['prepare', 'platform_install']);
    expect(candidateReady.if).toBe('always()');
    expect(candidateReady.steps).toHaveLength(1);
    expect(candidateReady.steps?.[0]?.if).toBeUndefined();
    expect(candidateReady.steps?.[0]?.env).toEqual({
      PREPARE_RESULT: '${{ needs.prepare.result }}',
      PLATFORM_RESULT: '${{ needs.platform_install.result }}',
    });
    expect(source.match(/persist-credentials: false/gu)).toHaveLength(2);
    expect(candidateReady.permissions).toEqual({});
    expectNoContinueOnError(prepare);
    expectNoContinueOnError(platformInstall);
    expectNoContinueOnError(candidateReady);
    expect(source).not.toContain('id-token: write');
    expect(source).not.toContain('environment: npm-staging');
    expect(source).not.toContain('npm stage publish');
    expect(source).not.toContain('npm exec');
    expect(source).not.toContain('npx ');
  });

  it('executes the real candidate gate and rejects every result pair except two successes', () => {
    const candidateReady = parsedWorkflow('build-candidate.yml').jobs.candidate_ready;
    const gate = candidateReady.steps?.[0]?.run;
    expect(typeof gate).toBe('string');
    const root = mkdtempSync(join(tmpdir(), 'candidate-ready-gate-'));
    const results = ['success', 'failure', 'cancelled', 'skipped', '', 'unknown'];
    try {
      for (const prepareResult of results) {
        for (const platformResult of results) {
          const executed = spawnSync(
            'bash',
            ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', gate ?? 'exit 99'],
            {
              cwd: root,
              encoding: 'utf8',
              env: {
                ...process.env,
                GITHUB_STEP_SUMMARY: 'summary.md',
                PREPARE_RESULT: prepareResult,
                PLATFORM_RESULT: platformResult,
              },
            },
          );
          const expected = prepareResult === 'success' && platformResult === 'success' ? 0 : 1;
          expect(
            executed.status,
            `prepare=${JSON.stringify(prepareResult)}, platform=${JSON.stringify(platformResult)}; ${String(executed.error)}`,
          ).toBe(expected);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the supported OS allowlist and every published version source aligned', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const packageLock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
    const expectedVersion = '0.37.1';
    const expectedOs = ['darwin', 'linux', 'win32'];

    expect(packageJson).toMatchObject({ version: expectedVersion, os: expectedOs });
    expect(packageLock).toMatchObject({
      version: expectedVersion,
      packages: { '': { version: expectedVersion, os: expectedOs } },
    });
    for (const path of [
      '.claude-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
      '.codex-plugin/plugin.json',
    ]) {
      expect(JSON.parse(readFileSync(resolve(path), 'utf8')).version, path).toBe(expectedVersion);
    }
    expect(readFileSync(resolve('src/version.ts'), 'utf8')).toContain(
      `CODING_X_VERSION = '${expectedVersion}'`,
    );
  });

  it('machine-verifies the candidate and all three repositories before staging approval', () => {
    const source = workflow('stage-candidate.yml');
    const jobs = parsedWorkflow('stage-candidate.yml').jobs;
    const verify = jobs.verify;
    const stage = jobs.stage;
    const environmentVerify = stepWithRun(verify, 'verify-stage-environment');
    const environmentReverify = stepWithRun(stage, 'verify-stage-environment');
    const verifyRun = stepWithRun(verify, 'verify-candidate-run');

    expect(source).toContain('candidate_run_id:');
    expect(source).toContain('engine_pr:');
    expect(source).toContain('go_pr:');
    expect(source).toContain('python_pr:');
    expect(source.match(/verify-stage-environment/gu)).toHaveLength(2);
    expect(environmentVerify.run).toContain('--policy .release/npm-staging-policy.json');
    expect(environmentVerify.run).toContain('--repository "$GITHUB_REPOSITORY"');
    expect(environmentVerify.run).toContain('/environments/npm-staging');
    expect(environmentVerify.run).toContain('/deployment-branch-policies');
    expect(environmentVerify.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(environmentReverify.run).toContain('--policy .release/npm-staging-policy.json');
    expect(environmentReverify.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(verifyRun.run).toContain('node build/release-evidence.mjs verify-candidate-run');
    expect(verifyRun.run).toContain('--run-json "$RUNNER_TEMP/candidate-run.json"');
    expect(verifyRun.run).toContain('--candidate-workflow-run-id "$CANDIDATE_WORKFLOW_RUN_ID"');
    expect(verifyRun.run).toContain('--commit "$CURRENT_MAIN_COMMIT"');
    expect(verifyRun.if).toBeUndefined();
    expectNoContinueOnError(verify);
    expectNoContinueOnError(stage);
    expect(stage.needs).toBe('verify');
    expect(verify.permissions).toEqual({ actions: 'read', checks: 'read', contents: 'read' });
    expect(stage.permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
      'id-token': 'write',
    });
    expect(source).toContain('git/ref/heads/main');
    expect(source).toContain('if [ "$CURRENT_MAIN_COMMIT" != "$REMOTE_MAIN_COMMIT" ]');
    expect(source).toContain('run-id: ${{ inputs.candidate_run_id }}');
    expect(source).toContain('--candidate-workflow-run-id');
    expect(source).toContain('--stage-workflow-run-id');
    expect(source).toContain('verify-dogfood');
    expect(source).toContain('verify-dogfood-set');
    expect(source).toContain('.release/dogfood-policy.json');
    expect(source).toContain('issues/$pr_number/comments');
    expect(source).toContain('check-runs?per_page=100&filter=all');
    const requiredSparsePaths = [
      '.release/dogfood-policy.json',
      '.release/npm-staging-policy.json',
      'build/release-evidence.mjs',
      ...localBuildImports('build/release-evidence.mjs'),
    ];
    for (const job of [verify, stage]) {
      expect(sparseCheckoutPaths(job)).toEqual(expect.arrayContaining(requiredSparsePaths));
    }
    expect(source).toContain('Re-read all three repositories after approval');
    expect(source).toContain('dogfood-current.json');
    expect(source).toContain('Three-repository evidence changed during approval');
    expect(source.indexOf('Verify live npm staging environment policy')).toBeLessThan(
      source.indexOf('Verify selected candidate run'),
    );
    expect(source.indexOf('Reverify live npm staging environment policy')).toBeLessThan(
      source.indexOf('Download only the pre-approval verified handoff'),
    );
    expect(source.indexOf('verify-dogfood')).toBeLessThan(
      source.indexOf('environment: npm-staging'),
    );
    expect(source).toContain('environment: npm-staging');
    expect(source).toContain('id-token: write');
    expect(source).toContain('npm stage publish');
    expect(source.indexOf('environment: npm-staging')).toBeLessThan(
      source.indexOf('npm stage publish'),
    );
    expect(source).not.toContain('npm ci');
    expect(source).not.toContain('npm test');
    expect(source).not.toContain('npm run build');
  });

  it('releases from the original candidate run selected by the immutable stage evidence', () => {
    const source = workflow('publish.yml');

    expect(source).toContain('.candidateWorkflowRunId');
    expect(source).toContain('.github/workflows/build-candidate.yml');
    expect(source).toContain('run-id: ${{ steps.candidate.outputs.candidate_run_id }}');
    expect(source).toContain('--stage-workflow-run-id "$STAGE_RUN_ID"');
    expect(source.indexOf('Download the stage identity artifact')).toBeLessThan(
      source.indexOf('Download the original pre-stage candidate artifact'),
    );
  });
});

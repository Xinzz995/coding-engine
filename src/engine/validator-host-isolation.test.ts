import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import {
  assertHostContextIsolation,
  establishValidatorHostIsolation,
} from './validator-host-isolation.js';
import {
  VALIDATOR_RUNNER_CANARY_CHECKS,
  VALIDATOR_RUNNER_CANARY_SCHEMA_VERSION,
  VALIDATOR_RUNNER_PROFILE_POLICY_VERSION,
  type ValidatorRunnerCanaryEvidence,
  type ValidatorRunnerProfile,
} from './validator-runner-profile.js';
import type { ValidatorRunnerObservation } from './validator-runner-observation.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

// establish 只在缺少 observation 注入时使用 session；这些用例不会触碰它。
const unusedSession = null as unknown as WorkspaceSession;

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  cleanups = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(): {
  projectRoot: string;
  engineWorkspaceRoot: string;
  cleanCheckoutRoot: string;
  executablePath: string;
} {
  const projectRoot = tempDir('vhi-project-');
  const engineWorkspaceRoot = join(projectRoot, '.workspace');
  mkdirSync(engineWorkspaceRoot);
  const cleanCheckoutRoot = tempDir('vhi-checkout-');
  const binDir = tempDir('vhi-bin-');
  const executablePath = join(binDir, 'codex');
  writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { projectRoot, engineWorkspaceRoot, cleanCheckoutRoot, executablePath };
}

function observationFor(
  executablePath: string,
  runner: 'codex' | 'claude' | 'cursor' = 'codex',
  runnerVersion?: string,
): ValidatorRunnerObservation {
  const versions = {
    codex: 'codex-cli 0.147.0-alpha.6.5',
    claude: '2.1.220 (Claude Code)',
    cursor: '2026.07.20-8cc9c0b',
  } as const;
  return {
    runnerVersion: runnerVersion ?? versions[runner],
    executablePath,
    executableSha256: DIGEST_A,
    platform: process.platform,
    architecture: process.arch,
  };
}

function passedCanaryFor(profile: ValidatorRunnerProfile): ValidatorRunnerCanaryEvidence {
  return {
    schemaVersion: VALIDATOR_RUNNER_CANARY_SCHEMA_VERSION,
    policyVersion: VALIDATOR_RUNNER_PROFILE_POLICY_VERSION,
    runner: profile.runner,
    runnerVersion: profile.runnerVersion,
    platform: profile.platform,
    architecture: profile.architecture,
    model: profile.model,
    executableSha256: profile.executableSha256,
    profileDigest: profile.profileDigest,
    source: 'engine-observed-v1',
    checks: Object.fromEntries(
      VALIDATOR_RUNNER_CANARY_CHECKS.map((check) => [check, 'passed']),
    ) as ValidatorRunnerCanaryEvidence['checks'],
  };
}

function baseRequest(parts: ReturnType<typeof fixture>) {
  return {
    session: unusedSession,
    runner: 'codex' as const,
    model: 'test-model',
    projectRoot: parts.projectRoot,
    engineWorkspaceRoot: parts.engineWorkspaceRoot,
    cleanCheckoutRoot: parts.cleanCheckoutRoot,
    commandContractSha256: DIGEST_B,
    observationForTests: observationFor(parts.executablePath),
  };
}

describe('establishValidatorHostIsolation', () => {
  it('becomes ready with an engine-observed canary, seals the invocation and preseals auth', async () => {
    const parts = fixture();
    const fakeHostCodexHome = tempDir('vhi-host-codex-');
    writeFileSync(join(fakeHostCodexHome, 'auth.json'), '{"token":"host-secret"}');
    let observedRunnerState: string | null = null;

    const outcome = await establishValidatorHostIsolation({
      ...baseRequest(parts),
      hostEnvironment: {
        PATH: process.env.PATH,
        CODEX_HOME: fakeHostCodexHome,
      },
      canaryProvider: (profile) => {
        observedRunnerState = profile.temporary.runnerState;
        return passedCanaryFor(profile);
      },
    });

    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.sealedInvocation.executable).toBe(parts.executablePath);
    expect(outcome.sealedInvocation.args).toContain('--ephemeral');
    expect(outcome.sealedInvocation.environment.HOME).toBe(outcome.profile.temporary.home);
    expect(outcome.resultPath).toBe(outcome.profile.temporary.resultPath);
    expect(outcome.binding.profileDigest).toBe(`sha256:${outcome.profile.profileDigest}`);
    expect(outcome.binding.canaryDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    // 单次调用域已创建，预置认证在 Runner 状态目录内、模型沙箱不可读区域。
    expect(observedRunnerState).not.toBeNull();
    expect(existsSync(join(observedRunnerState!, 'auth.json'))).toBe(true);
    expect(existsSync(outcome.profile.temporary.temp)).toBe(true);

    const cleanup = outcome.dispose();
    expect(cleanup.status).toBe('removed');
    expect(existsSync(outcome.profile.temporary.root)).toBe(false);
  });

  it('fails closed for Claude despite a passing-shaped canary and disposes the domain', async () => {
    const parts = fixture();
    const outcome = await establishValidatorHostIsolation({
      ...baseRequest(parts),
      runner: 'claude',
      observationForTests: observationFor(parts.executablePath, 'claude'),
      canaryProvider: (profile) => passedCanaryFor(profile),
    });
    expect(outcome).toMatchObject({ status: 'unverifiable', code: 'native-boundary-incomplete' });
    expect(outcome.dispose().status).toBe('removed');
  });

  it('fails closed for an unaudited runner version before any canary runs', async () => {
    const parts = fixture();
    let canaryRan = false;
    const outcome = await establishValidatorHostIsolation({
      ...baseRequest(parts),
      observationForTests: observationFor(parts.executablePath, 'codex', 'codex-cli 0.148.0'),
      canaryProvider: (profile) => {
        canaryRan = true;
        return passedCanaryFor(profile);
      },
    });
    expect(outcome).toMatchObject({ status: 'unverifiable', code: 'unsupported-version' });
    expect(canaryRan).toBe(false);
    expect(outcome.dispose().status).toBe('removed');
  });

  it('stays canary-missing without a provider and never downgrades to wide permissions', async () => {
    const parts = fixture();
    const outcome = await establishValidatorHostIsolation(baseRequest(parts));
    expect(outcome).toMatchObject({ status: 'unverifiable', code: 'canary-missing' });
    expect(outcome.dispose().status).toBe('removed');
  });

  it('rejects canary evidence bound to a different profile digest', async () => {
    const parts = fixture();
    const outcome = await establishValidatorHostIsolation({
      ...baseRequest(parts),
      canaryProvider: (profile) => ({
        ...passedCanaryFor(profile),
        profileDigest: DIGEST_B,
      }),
    });
    expect(outcome).toMatchObject({ status: 'unverifiable', code: 'canary-binding-mismatch' });
    expect(outcome.dispose().status).toBe('removed');
  });

  it('rejects a canary with any non-passed engine observation', async () => {
    const parts = fixture();
    const outcome = await establishValidatorHostIsolation({
      ...baseRequest(parts),
      canaryProvider: (profile) => ({
        ...passedCanaryFor(profile),
        checks: {
          ...passedCanaryFor(profile).checks,
          'credential-hidden': 'failed',
        },
      }),
    });
    expect(outcome).toMatchObject({ status: 'unverifiable', code: 'canary-failed' });
    if (outcome.status === 'unverifiable') {
      expect(outcome.message).toContain('credential-hidden');
    }
    expect(outcome.dispose().status).toBe('removed');
  });

  it('rejects a checkout nested inside the source project as an invalid profile boundary', async () => {
    const parts = fixture();
    const nestedCheckout = join(parts.projectRoot, 'nested-checkout');
    mkdirSync(nestedCheckout);
    const outcome = await establishValidatorHostIsolation({
      ...baseRequest(parts),
      cleanCheckoutRoot: nestedCheckout,
      canaryProvider: (profile) => passedCanaryFor(profile),
    });
    expect(outcome).toMatchObject({ status: 'unverifiable', code: 'invalid-profile' });
    expect(outcome.dispose().status).toBe('removed');
  });

  it('reports an unobservable runner before touching the session when the binary cannot resolve', async () => {
    const parts = fixture();
    const outcome = await establishValidatorHostIsolation({
      session: unusedSession,
      runner: 'codex',
      model: 'test-model',
      projectRoot: parts.projectRoot,
      engineWorkspaceRoot: parts.engineWorkspaceRoot,
      cleanCheckoutRoot: parts.cleanCheckoutRoot,
      commandContractSha256: DIGEST_B,
      hostEnvironment: { PATH: parts.projectRoot, CODING_X_CODEX_BIN: 'missing-codex-binary-xyz' },
    });
    expect(outcome).toMatchObject({ status: 'unverifiable', code: 'runner-unobservable' });
    expect(outcome.dispose().status).toBe('removed');
  });
});

describe('assertHostContextIsolation', () => {
  async function readyProfile(parts: ReturnType<typeof fixture>): Promise<ValidatorRunnerProfile> {
    const outcome = await establishValidatorHostIsolation({
      ...baseRequest(parts),
      canaryProvider: (profile) => passedCanaryFor(profile),
    });
    if (outcome.status !== 'ready') throw new Error('expected ready profile');
    outcome.dispose();
    return outcome.profile;
  }

  it('enforced for a freshly resolved profile whose identity domain holds only auth', async () => {
    const parts = fixture();
    const outcome = await establishValidatorHostIsolation({
      ...baseRequest(parts),
      canaryProvider: (profile) => passedCanaryFor(profile),
    });
    expect(outcome.status).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(outcome.hostContextIsolation.enforced).toBe(true);
    // 核对通过后种 credential 探针，此刻 Runner 状态目录仍只应有 auth（探针在 canary 内种）。
    outcome.dispose();
  });

  it('fails when a non-preset config file appears in the runner state directory', async () => {
    const parts = fixture();
    const profile = await readyProfile(parts);
    // 域已被 dispose；重建 Runner 状态目录并放入非预置的 AGENTS.md 模拟污染。
    mkdirSync(profile.temporary.runnerState, { recursive: true });
    writeFileSync(join(profile.temporary.runnerState, 'AGENTS.md'), 'global rules\n');
    cleanups.push(() => rmSync(profile.temporary.root, { recursive: true, force: true }));
    const fact = assertHostContextIsolation(profile);
    expect(fact.enforced).toBe(false);
    expect(fact.failures.some((f) => f.includes('AGENTS.md'))).toBe(true);
  });

  it('fails when required isolation args are missing from the profile', async () => {
    const parts = fixture();
    const profile = await readyProfile(parts);
    mkdirSync(profile.temporary.runnerState, { recursive: true });
    writeFileSync(join(profile.temporary.runnerState, 'auth.json'), '{}');
    cleanups.push(() => rmSync(profile.temporary.root, { recursive: true, force: true }));
    const stripped = {
      ...profile,
      args: profile.args.filter((a) => a !== '--ignore-rules'),
    } as ValidatorRunnerProfile;
    const fact = assertHostContextIsolation(stripped);
    expect(fact.enforced).toBe(false);
    expect(fact.failures.some((f) => f.includes('--ignore-rules'))).toBe(true);
  });

  it('fails when an environment redirect escapes the identity domain', async () => {
    const parts = fixture();
    const profile = await readyProfile(parts);
    mkdirSync(profile.temporary.runnerState, { recursive: true });
    writeFileSync(join(profile.temporary.runnerState, 'auth.json'), '{}');
    cleanups.push(() => rmSync(profile.temporary.root, { recursive: true, force: true }));
    const escaped = {
      ...profile,
      environment: { ...profile.environment, CODEX_HOME: '/Users/host/.codex' },
    } as ValidatorRunnerProfile;
    const fact = assertHostContextIsolation(escaped);
    expect(fact.enforced).toBe(false);
    expect(fact.failures.some((f) => f.includes('CODEX_HOME'))).toBe(true);
  });
});

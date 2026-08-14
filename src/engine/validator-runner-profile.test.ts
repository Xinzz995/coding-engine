import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentKind } from './agent.js';
import { VALIDATION_PROTOCOL_VERSION } from '../contracts/validation-contract.js';
import {
  resolveValidatorRunnerProfile,
  VALIDATOR_RUNNER_CANARY_CHECKS,
  VALIDATOR_RUNNER_CANARY_SCHEMA_VERSION,
  VALIDATOR_RUNNER_PROFILE_POLICY_VERSION,
  type ValidatorRunnerCanaryEvidence,
  type ValidatorRunnerProfile,
  type ValidatorRunnerProfileRequest,
} from './validator-runner-profile.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
// 期望值与实现同样经过 resolve/join，保证三平台（含 Windows 盘符与分隔符）一致。
const IDENTITY_ROOT = resolve('/private/tmp/coding-x-validator/identity');
const identity = (...parts: string[]): string => join(IDENTITY_ROOT, ...parts);

function request(
  runner: AgentKind = 'codex',
  overrides: Partial<ValidatorRunnerProfileRequest> = {},
): ValidatorRunnerProfileRequest {
  const versions: Record<AgentKind, string> = {
    codex: 'codex-cli 0.147.0-alpha.6.5',
    claude: '2.1.220 (Claude Code)',
    cursor: '2026.07.20-8cc9c0b',
  };
  return {
    runner,
    runnerVersion: versions[runner],
    platform: 'darwin',
    architecture: 'arm64',
    model: 'test-model',
    executablePath: `/opt/coding-x-runners/${runner}`,
    executableSha256: DIGEST_A,
    cleanCheckoutRoot: '/private/tmp/coding-x-validator/checkout',
    sourceProjectRoot: '/workspace/project',
    engineWorkspaceRoot: '/workspace/project/.workspace',
    identityRoot: '/private/tmp/coding-x-validator/identity',
    claimProtocolVersion: VALIDATION_PROTOCOL_VERSION,
    commandContractSha256: DIGEST_B,
    hostEnvironment: {
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      HOME: '/Users/host',
      CODEX_HOME: '/Users/host/.codex',
      CODEX_API_KEY: 'must-not-pass',
      ANTHROPIC_API_KEY: 'must-not-pass',
      CURSOR_API_KEY: 'must-not-pass',
      CLAUDE_CODE_PLUGIN_DIR: '/Users/host/plugin',
    },
    ...overrides,
  };
}

function profileFor(value: ValidatorRunnerProfileRequest): ValidatorRunnerProfile {
  const resolution = resolveValidatorRunnerProfile(value);
  expect(resolution.status).toBe('unverifiable');
  if (resolution.status !== 'unverifiable' || resolution.profile === undefined) {
    throw new Error('test expected a built profile');
  }
  return resolution.profile;
}

function passedCanary(
  profile: ValidatorRunnerProfile,
  overrides: Partial<ValidatorRunnerCanaryEvidence> = {},
): ValidatorRunnerCanaryEvidence {
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
    ...overrides,
  };
}

describe('resolveValidatorRunnerProfile', () => {
  it('keeps the audited Codex profile unverifiable until an exactly bound real canary exists', () => {
    const resolution = resolveValidatorRunnerProfile(request());
    expect(resolution).toMatchObject({
      status: 'unverifiable',
      code: 'canary-missing',
      profile: {
        runner: 'codex',
        runnerVersion: 'codex-cli 0.147.0-alpha.6.5',
        normalizedRunnerVersion: '0.147.0-alpha.6.5',
        claimTransport: 'result-file',
        promptMode: 'stdin',
      },
    });
    if (resolution.status !== 'unverifiable' || resolution.profile === undefined) return;

    const profile = resolution.profile;
    expect(profile.args).toEqual(
      expect.arrayContaining([
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--strict-config',
        '--sandbox',
        'workspace-write',
        '-',
      ]),
    );
    expect(profile.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(profile.args).not.toContain('--approve-for-me');
    // claim 只走 ADR-015 结果文件；结构化 stdout 不是 claim 通道。
    expect(profile.args).not.toContain('--output-schema');
    expect(profile.args).not.toContain('--json');
    expect(profile.temporary.resultPath).toBe(identity('tmp', 'validation-result.json'));
    for (const feature of ['apps', 'hooks', 'memories', 'plugins', 'enable_mcp_apps']) {
      expect(profile.args).toContain(feature);
    }
    expect(profile.environment).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: identity('home'),
      CODEX_HOME: identity('codex'),
      XDG_CONFIG_HOME: identity('config'),
      TMPDIR: identity('tmp'),
    });
    expect(profile.environment).not.toHaveProperty('CODEX_API_KEY');
    expect(profile.environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(profile.environment).not.toHaveProperty('CURSOR_API_KEY');
    expect(profile.environment).not.toHaveProperty('CLAUDE_CODE_PLUGIN_DIR');
    expect(profile.commandEnvironment).toMatchObject({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      TMPDIR: identity('tmp'),
    });
    expect(profile.commandEnvironment).not.toHaveProperty('HOME');
    expect(profile.allowedProjectInputs).toEqual([
      'tracked-clean-checkout',
      'AGENTS.md',
      'quality-contract',
    ]);
    expect(profile.forbiddenHostInputs).toEqual([
      'rules',
      'memory',
      'mcp',
      'plugins',
      'hooks',
      'apps',
      'session',
    ]);
  });

  it('becomes ready only when every engine-observed canary check matches the complete profile', () => {
    const initial = request();
    const profile = profileFor(initial);
    const resolution = resolveValidatorRunnerProfile({
      ...initial,
      canary: passedCanary(profile),
    });
    expect(resolution).toEqual({ status: 'ready', profile });
  });

  it.each([
    ['runnerVersion', { runnerVersion: 'codex-cli 0.147.0-alpha.6.4' }],
    ['platform', { platform: 'linux' as NodeJS.Platform }],
    ['architecture', { architecture: 'x64' }],
    ['model', { model: 'another-model' }],
    ['executableSha256', { executableSha256: DIGEST_B }],
    ['profileDigest', { profileDigest: DIGEST_B }],
  ])('rejects canary binding drift in %s', (_name, override) => {
    const initial = request();
    const profile = profileFor(initial);
    const resolution = resolveValidatorRunnerProfile({
      ...initial,
      canary: passedCanary(profile, override),
    });
    expect(resolution).toMatchObject({
      status: 'unverifiable',
      code: 'canary-binding-mismatch',
    });
  });

  it('rejects a failed or absent canary check instead of trusting the model claim', () => {
    const initial = request();
    const profile = profileFor(initial);
    const canary = passedCanary(profile, {
      checks: {
        ...passedCanary(profile).checks,
        'credential-hidden': 'failed',
        'controlled-command-allowed': 'unverifiable',
      },
    });
    const resolution = resolveValidatorRunnerProfile({ ...initial, canary });
    expect(resolution).toMatchObject({
      status: 'unverifiable',
      code: 'canary-failed',
    });
    if (resolution.status === 'unverifiable') {
      expect(resolution.message).toContain('credential-hidden');
      expect(resolution.message).toContain('controlled-command-allowed');
    }
  });

  it('rejects unknown canary fields and checks instead of accepting a newer shape loosely', () => {
    const initial = request();
    const profile = profileFor(initial);
    const canary = {
      ...passedCanary(profile),
      unknownField: true,
      checks: { ...passedCanary(profile).checks, 'future-check': 'passed' },
    } as unknown as ValidatorRunnerCanaryEvidence;
    const resolution = resolveValidatorRunnerProfile({ ...initial, canary });
    expect(resolution).toMatchObject({
      status: 'unverifiable',
      code: 'canary-binding-mismatch',
    });
    if (resolution.status === 'unverifiable') {
      expect(resolution.message).toContain('unknown:unknownField');
      expect(resolution.message).toContain('checks.unknown:future-check');
    }
  });

  it('does not let a valid-looking canary paper over Claude native containment gaps', () => {
    const initial = request('claude');
    const profile = profileFor(initial);
    const resolution = resolveValidatorRunnerProfile({
      ...initial,
      canary: passedCanary(profile),
    });
    expect(resolution).toMatchObject({
      status: 'unverifiable',
      code: 'native-boundary-incomplete',
      profile: {
        normalizedRunnerVersion: '2.1.220',
        claimTransport: 'result-file',
      },
    });
    expect(profile.args).toEqual(
      expect.arrayContaining([
        '--bare',
        '--safe-mode',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--disable-slash-commands',
      ]),
    );
    expect(profile.args).not.toContain('--dangerously-skip-permissions');
    expect(profile.environment).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('does not let a valid-looking canary paper over Cursor command and host-context gaps', () => {
    const initial = request('cursor');
    const profile = profileFor(initial);
    const resolution = resolveValidatorRunnerProfile({
      ...initial,
      canary: passedCanary(profile),
    });
    expect(resolution).toMatchObject({
      status: 'unverifiable',
      code: 'native-boundary-incomplete',
      profile: { normalizedRunnerVersion: '2026.07.20-8cc9c0b' },
    });
    expect(profile.args).toEqual(
      expect.arrayContaining(['--sandbox', 'enabled', '--workspace', profile.cleanCheckoutRoot]),
    );
    expect(profile.args).not.toContain('--force');
    expect(profile.args).not.toContain('--approve-mcps');
    expect(profile.args).not.toContain('--trust');
    expect(profile.environment).not.toHaveProperty('CURSOR_API_KEY');
  });

  it.each([
    ['codex', 'codex-cli 0.148.0'],
    ['claude', '2.1.221 (Claude Code)'],
    ['cursor', '2026.08.01-next'],
  ] as const)('fails closed for unaudited %s version %s', (runner, runnerVersion) => {
    expect(resolveValidatorRunnerProfile(request(runner, { runnerVersion }))).toMatchObject({
      status: 'unverifiable',
      code: 'unsupported-version',
    });
  });

  it('fails closed before profile construction on an unsupported host platform', () => {
    expect(resolveValidatorRunnerProfile(request('codex', { platform: 'freebsd' }))).toMatchObject({
      status: 'unverifiable',
      code: 'unsupported-platform',
    });
  });

  it.each([
    ['relative checkout', { cleanCheckoutRoot: 'checkout' }],
    ['nested identity', { identityRoot: '/private/tmp/coding-x-validator/checkout/identity' }],
    [
      'identity contains checkout',
      {
        cleanCheckoutRoot: '/private/tmp/coding-x-validator/identity/checkout',
        identityRoot: '/private/tmp/coding-x-validator/identity',
      },
    ],
    [
      'checkout executable',
      { executablePath: '/private/tmp/coding-x-validator/checkout/bin/codex' },
    ],
    ['project identity', { identityRoot: '/workspace/project/.validator-home' }],
    ['workspace identity', { identityRoot: '/workspace/project/.workspace/validator-home' }],
    ['project checkout', { cleanCheckoutRoot: '/workspace/project/validator-checkout' }],
    ['project executable', { executablePath: '/workspace/project/node_modules/.bin/codex' }],
    ['bad executable digest', { executableSha256: 'not-a-digest' }],
    ['bad command digest', { commandContractSha256: 'not-a-digest' }],
    ['unaudited claim protocol', { claimProtocolVersion: VALIDATION_PROTOCOL_VERSION + 1 }],
  ])('rejects invalid profile boundary: %s', (_name, override) => {
    expect(resolveValidatorRunnerProfile(request('codex', override))).toMatchObject({
      status: 'unverifiable',
      code: 'invalid-profile',
    });
  });

  it.each(['OPENAI_API_KEY', 'ACCESS_TOKEN', 'SESSION_ID', 'XDG_CONFIG_HOME', 'MCP_CONFIG'])(
    'rejects secret or host-context command environment variable %s',
    (name) => {
      expect(
        resolveValidatorRunnerProfile(
          request('codex', { commandEnvironment: { [name]: 'must-not-pass' } }),
        ),
      ).toMatchObject({ status: 'unverifiable', code: 'invalid-profile' });
    },
  );

  it('rejects case-colliding Windows environment names and creates an isolated Windows identity', () => {
    const collision = resolveValidatorRunnerProfile(
      request('codex', {
        platform: 'win32',
        architecture: 'x64',
        hostEnvironment: { PATH: 'C:\\Windows', Path: 'C:\\Tools' },
      }),
    );
    expect(collision).toMatchObject({ status: 'unverifiable', code: 'invalid-profile' });

    const resolution = resolveValidatorRunnerProfile(
      request('codex', {
        platform: 'win32',
        architecture: 'x64',
        hostEnvironment: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
      }),
    );
    expect(resolution).toMatchObject({
      status: 'unverifiable',
      code: 'canary-missing',
      profile: {
        environment: {
          PATH: 'C:\\Windows',
          USERPROFILE: identity('home'),
          APPDATA: identity('config'),
          LOCALAPPDATA: identity('data'),
        },
      },
    });
  });

  it('renders a runner-default profile without --model and binds the null route into the digest', () => {
    const resolution = resolveValidatorRunnerProfile(request('codex', { model: null }));
    expect(resolution).toMatchObject({ status: 'unverifiable', code: 'canary-missing' });
    if (resolution.status !== 'unverifiable' || resolution.profile === undefined) return;
    expect(resolution.profile.model).toBeNull();
    expect(resolution.profile.args).not.toContain('--model');
    expect(resolution.profile.profileDigest).not.toBe(profileFor(request()).profileDigest);
  });

  it('binds the model, executable bytes, safe PATH and quality command contract into the profile digest', () => {
    const baseline = profileFor(request());
    const changes: Partial<ValidatorRunnerProfileRequest>[] = [
      { model: 'different-model' },
      { executableSha256: DIGEST_B },
      { hostEnvironment: { PATH: '/different/bin' } },
      { commandContractSha256: DIGEST_A },
      { commandEnvironment: { NODE_ENV: 'test' } },
    ];
    for (const change of changes) {
      expect(profileFor(request('codex', change)).profileDigest).not.toBe(baseline.profileDigest);
    }
  });

  it('invalidates canary evidence when a fresh run changes checkout or identity paths', () => {
    const first = profileFor(request());
    const second = profileFor(
      request('codex', {
        cleanCheckoutRoot: '/private/tmp/another-run/checkout',
        identityRoot: '/private/tmp/another-run/identity',
      }),
    );
    expect(second.profileDigest).not.toBe(first.profileDigest);
    expect(second.temporary.root).not.toBe(first.temporary.root);

    const resolution = resolveValidatorRunnerProfile({
      ...request('codex', {
        cleanCheckoutRoot: '/private/tmp/another-run/checkout',
        identityRoot: '/private/tmp/another-run/identity',
      }),
      canary: passedCanary(first),
    });
    expect(resolution).toMatchObject({
      status: 'unverifiable',
      code: 'canary-binding-mismatch',
    });
  });
});

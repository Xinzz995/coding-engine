import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import type { runAgent } from './agent.js';
import { readGitHead } from './validation-protocol.js';
import { runValidatorCanary } from './validator-canary.js';
import {
  resolveValidatorRunnerProfile,
  validatorRunnerTemporaryDomain,
  type ValidatorRunnerProfile,
} from './validator-runner-profile.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
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

interface CanaryFixture {
  profile: ValidatorRunnerProfile;
  checkout: string;
  head: string;
}

function fixture(): CanaryFixture {
  const projectRoot = tempDir('canary-project-');
  mkdirSync(join(projectRoot, '.workspace'));
  const checkout = tempDir('canary-checkout-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: checkout });
  execFileSync('git', ['config', 'user.name', 'coding-x test'], { cwd: checkout });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: checkout });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: checkout });
  writeFileSync(join(checkout, 'AGENTS.md'), 'canary-agents-first-line\nbody\n');
  writeFileSync(join(checkout, 'source.txt'), 'canary-source-first-line\n');
  execFileSync('git', ['add', '.'], { cwd: checkout });
  execFileSync('git', ['commit', '-q', '-m', 'test: canary checkout'], { cwd: checkout });
  const head = readGitHead(checkout);
  if (!head) throw new Error('fixture head unavailable');

  const binDir = tempDir('canary-bin-');
  const executablePath = join(binDir, 'codex');
  writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const identityRoot = tempDir('canary-identity-');
  const layout = validatorRunnerTemporaryDomain(identityRoot, 'codex');
  for (const directory of [
    layout.home,
    layout.config,
    layout.cache,
    layout.data,
    layout.temp,
    layout.sessions,
    layout.runnerState,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const resolution = resolveValidatorRunnerProfile({
    runner: 'codex',
    runnerVersion: 'codex-cli 0.147.0-alpha.6.5',
    platform: process.platform,
    architecture: process.arch,
    model: 'test-model',
    executablePath,
    executableSha256: DIGEST_A,
    cleanCheckoutRoot: checkout,
    sourceProjectRoot: projectRoot,
    engineWorkspaceRoot: join(projectRoot, '.workspace'),
    identityRoot,
    claimProtocolVersion: 1,
    commandContractSha256: DIGEST_B,
    hostEnvironment: { PATH: process.env.PATH },
  });
  if (resolution.status !== 'unverifiable' || resolution.profile === undefined) {
    throw new Error('fixture expected a canary-missing profile');
  }
  return { profile: resolution.profile, checkout, head };
}

interface PromptProbes {
  outsideReadPath: string;
  outsideWritePath: string;
  agentsProbePath: string;
  checkoutProbePath: string;
  respondToken: string;
  resultPath: string;
}

function parsePrompt(prompt: string): PromptProbes {
  const take = (pattern: RegExp): string => {
    const match = prompt.match(pattern);
    if (!match) throw new Error(`canary prompt 缺少探针：${pattern}`);
    return match[1];
  };
  return {
    outsideReadPath: take(/2\. 读取文件 (.+?) 并原样输出其内容/u),
    outsideWritePath: take(/3\. 向 (.+?) 写入文本 escape/u),
    agentsProbePath: take(/4\. 读取 (.+?) 并原样输出其第一行/u),
    checkoutProbePath: take(/5\. 读取 (.+?) 并原样输出其第一行/u),
    respondToken: take(/\{"canary":"(.+?)"\}/u),
    resultPath: take(/原子写入 (.+?)。/u),
  };
}

type FakeRunnerBehavior = (
  probes: PromptProbes,
  options: Parameters<typeof runAgent>[0],
) => { extraOutput?: string; skipClaim?: boolean; skipHead?: boolean; write?: boolean } | void;

function fakeRunner(behavior: FakeRunnerBehavior = () => undefined): typeof runAgent {
  return async (options) => {
    const probes = parsePrompt(options.prompt);
    const tweaks = behavior(probes, options) ?? {};
    const lines = ['NO-INJECTED-CONTEXT', 'READ-DENIED'];
    if (tweaks.write) {
      writeFileSync(probes.outsideWritePath, 'escape');
      lines.push('WRITE-OK');
    } else {
      lines.push('WRITE-DENIED');
    }
    lines.push(readFileSync(probes.agentsProbePath, 'utf8').split(/\r?\n/u, 1)[0]);
    lines.push(readFileSync(probes.checkoutProbePath, 'utf8').split(/\r?\n/u, 1)[0]);
    if (!tweaks.skipHead) lines.push(readGitHead(options.cwd) ?? 'HEAD-UNAVAILABLE');
    if (!tweaks.skipClaim) {
      writeFileSync(probes.resultPath, JSON.stringify({ canary: probes.respondToken }));
    }
    if (tweaks.extraOutput) lines.push(tweaks.extraOutput);
    lines.push('CANARY-COMPLETE');
    options.output?.stdout.write(`${lines.join('\n')}\n`);
    return {
      timedOut: false,
      exitCode: 0,
      durationMs: 20,
      outputTail: '',
      processTreeNotEmpty: false,
      terminationReason: null,
    };
  };
}

function contextFor(parts: CanaryFixture, runAgentForTests: typeof runAgent) {
  return {
    session: unusedSession,
    story: {
      storyId: 'US-001',
      acceptanceHash: `sha256:${'f'.repeat(64)}`,
      checkCount: 1,
      gitHead: parts.head,
    },
    timeoutMs: 5_000,
    runAgentForTests,
  };
}

describe('runValidatorCanary', () => {
  it('produces fully engine-observed passing evidence bound to the exact profile', async () => {
    const parts = fixture();
    const run = await runValidatorCanary(parts.profile, contextFor(parts, fakeRunner()));
    expect(run.evidence).toBeDefined();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.evidence).toMatchObject({
      source: 'engine-observed-v1',
      profileDigest: parts.profile.profileDigest,
      runnerVersion: parts.profile.runnerVersion,
    });
    expect(Object.values(run.evidence!.checks).every((check) => check === 'passed')).toBe(true);
    // 证据可直接让解析器判 ready：canary 与 profile 精确互绑。
    const sentinels = readFileSync(
      join(parts.profile.temporary.runnerState, 'memories', 'coding-x-canary.md'),
      'utf8',
    );
    expect(sentinels).toContain('coding-x-canary-host-memory-hidden-');
  });

  it('fails host-memory-hidden when the runner surfaces a planted sentinel token', async () => {
    const parts = fixture();
    const run = await runValidatorCanary(
      parts.profile,
      contextFor(
        parts,
        fakeRunner((_probes, options) => {
          const leaked = readFileSync(
            join(parts.profile.temporary.runnerState, 'memories', 'coding-x-canary.md'),
            'utf8',
          );
          void options;
          return { extraOutput: leaked };
        }),
      ),
    );
    expect(run.evidence?.checks['host-memory-hidden']).toBe('failed');
    expect(run.diagnostic).toContain('host-memory-hidden');
  });

  it('fails outside-write-denied when the runner escapes the sandbox write boundary', async () => {
    const parts = fixture();
    const run = await runValidatorCanary(
      parts.profile,
      contextFor(
        parts,
        fakeRunner(() => ({ write: true })),
      ),
    );
    expect(run.evidence?.checks['outside-write-denied']).toBe('failed');
  });

  it('fails structured-claim-returned without an exact respond token claim', async () => {
    const parts = fixture();
    const run = await runValidatorCanary(
      parts.profile,
      contextFor(
        parts,
        fakeRunner(() => ({ skipClaim: true })),
      ),
    );
    expect(run.evidence?.checks['structured-claim-returned']).toBe('failed');
  });

  it('fails controlled-command-allowed when the expected HEAD never appears', async () => {
    const parts = fixture();
    const run = await runValidatorCanary(
      parts.profile,
      contextFor(
        parts,
        fakeRunner(() => ({ skipHead: true })),
      ),
    );
    expect(run.evidence?.checks['controlled-command-allowed']).toBe('failed');
  });

  it('fails temporary-domain-clean when the domain grows a symbolic link', async () => {
    const parts = fixture();
    const run = await runValidatorCanary(
      parts.profile,
      contextFor(
        parts,
        fakeRunner(() => {
          symlinkSync(parts.checkout, join(parts.profile.temporary.temp, 'escape-link'));
        }),
      ),
    );
    expect(run.evidence?.checks['temporary-domain-clean']).toBe('failed');
  });

  it.each([
    ['non-zero exit', { exitCode: 1, timedOut: false }],
    ['timeout', { exitCode: null, timedOut: true }],
  ] as const)('returns no evidence on %s so the resolver fails closed', async (_name, outcome) => {
    const parts = fixture();
    const failingRunner: typeof runAgent = async (options) => {
      parsePrompt(options.prompt);
      return {
        timedOut: outcome.timedOut,
        exitCode: outcome.exitCode,
        durationMs: 10,
        outputTail: '',
        processTreeNotEmpty: false,
        terminationReason: outcome.timedOut ? 'timeout' : null,
      };
    };
    const run = await runValidatorCanary(parts.profile, contextFor(parts, failingRunner));
    expect(run.evidence).toBeUndefined();
    expect(run.diagnostic).toContain('canary');
  });

  it('returns no evidence when the canary output exceeds the safety bound', async () => {
    const parts = fixture();
    const noisyRunner: typeof runAgent = async (options) => {
      parsePrompt(options.prompt);
      const chunk = 'x'.repeat(64 * 1024);
      for (let written = 0; written <= 1024 * 1024; written += chunk.length) {
        options.output?.stdout.write(chunk);
      }
      return {
        timedOut: false,
        exitCode: 0,
        durationMs: 10,
        outputTail: '',
        processTreeNotEmpty: false,
        terminationReason: null,
      };
    };
    const run = await runValidatorCanary(parts.profile, contextFor(parts, noisyRunner));
    expect(run.evidence).toBeUndefined();
    expect(run.diagnostic).toContain('上限');
  });

  it('cleans up the outside probe directory after every run', async () => {
    const parts = fixture();
    let probeRoot: string | null = null;
    const run = await runValidatorCanary(
      parts.profile,
      contextFor(
        parts,
        fakeRunner((probes) => {
          probeRoot = join(probes.outsideReadPath, '..');
        }),
      ),
    );
    expect(run.evidence).toBeDefined();
    expect(probeRoot).not.toBeNull();
    expect(existsSync(probeRoot!)).toBe(false);
  });
});

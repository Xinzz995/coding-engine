import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLoop } from './loop.js';
import { readEvidence } from './evidence.js';
import {
  FAKE_RUNNER_INPUT_SOURCE,
  fakeBoundValidator,
  setupGitProject,
  story,
  strictConfig,
} from './loop-test-support.js';
import type { ValidatorRunnerObservation } from './validator-runner-observation.js';

const PINNED = {
  codex: 'codex-cli 0.147.0-alpha.6.5',
  claude: '2.1.220 (Claude Code)',
} as const;

function observation(executablePath: string, runnerVersion: string): ValidatorRunnerObservation {
  return {
    runnerVersion,
    executablePath,
    executableSha256: 'a'.repeat(64),
    platform: process.platform,
    architecture: process.arch,
  };
}

/**
 * 三段式合规 fake runner：builder 留候选、canary 按探针协议诚实作答（不泄漏 sentinel、
 * 不越界写）、validator 写结构化 passed claim。canary 分支把 resultPath 写入 marker，
 * 供测试反推临时身份域根并断言收口。
 */
function fakeIsolationRunner(workspace: string, canaryMarker: string): string {
  const fake = join(workspace, 'fake-isolation-runner.mjs');
  const statePath = join(workspace, 'state.json');
  const progressPath = join(workspace, 'progress.md');
  writeFileSync(
    fake,
    String.raw`
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    ${FAKE_RUNNER_INPUT_SOURCE}
    if (prompt.includes('宿主隔离反测')) {
      const take = (pattern) => {
        const match = prompt.match(pattern);
        if (!match) process.exit(21);
        return match[1];
      };
      const agentsPath = take(/1\. 读取 (.+?) 并原样输出其第一行/u);
      const probePath = take(/2\. 读取 (.+?) 并原样输出其第一行/u);
      const respondToken = take(/\{"canary":"(.+?)"\}/u);
      const resultPath = take(/原子写入 (.+?)。/u);
      writeFileSync(${JSON.stringify(canaryMarker)}, resultPath);
      const lines = [];
      lines.push(readFileSync(agentsPath, 'utf8').split(/\r?\n/u)[0]);
      lines.push(readFileSync(probePath, 'utf8').split(/\r?\n/u)[0]);
      lines.push(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
      lines.push('WRITE-DENIED');
      writeFileSync(resultPath, JSON.stringify({ canary: respondToken }));
      lines.push('NO-PRESET-CONTEXT');
      lines.push('CANARY-COMPLETE');
      process.stdout.write(lines.join('\n') + '\n');
      process.exit(0);
    }
    const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
    if (markerAt >= 0) {
      const jsonAt = prompt.indexOf('{', markerAt);
      const fenceAt = prompt.indexOf(String.fromCharCode(10, 96, 96, 96), jsonAt);
      if (jsonAt < 0 || fenceAt < 0) process.exit(9);
      const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
      const checks = request.acceptanceCriteria.map((_, index) => ({
        acIndex: index + 1,
        passed: true,
        evidence: 'fixture verified AC',
      }));
      writeFileSync(request.resultPath, JSON.stringify({
        version: 1,
        requestId: request.requestId,
        storyId: request.storyId,
        acceptanceHash: request.acceptanceHash,
        gitHead: request.gitHead,
        verdict: 'passed',
        checks,
        summary: '全部 AC 通过',
      }));
      process.exit(0);
    }
    const statePath = ${JSON.stringify(statePath)};
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state['US-001'].passes = true;
    state['US-001'].validated = false;
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    appendFileSync(${JSON.stringify(progressPath)}, '## builder completed US-001\n');
    process.exit(0);
  `,
  );
  return fake;
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  cleanups = [];
  delete process.env.CODING_X_CLAUDE_BIN;
  delete process.env.CODING_X_CODEX_BIN;
  vi.restoreAllMocks();
});

describe('runLoop Validator host isolation (ADR-025)', () => {
  it('keeps the candidate, issues no receipt and exits 5 when the profile boundary cannot be proven', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['AC 1'] })]);
    const fake = fakeBoundValidator(fixture.workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warned.push(String(message));
    });

    // 真实链：project-root 验证目录违反 profile 分离不变式 → invalid-profile。
    const code = await runLoop({
      ...strictConfig(fixture.workspace, fixture.instructionsDir),
      validatorRunnerBindingForTests: undefined,
      validatorRunnerObservationForTests: observation(
        join(fixture.instructionsDir, 'claude'),
        PINNED.claude,
      ),
    });

    expect(code).toBe(5);
    expect(warned.some((line) => line.includes('ADR-025'))).toBe(true);
    // Builder 正常产出候选；Validator 未被启动（宽权限回退不存在）。
    expect(readFileSync(join(resolve(fixture.workspace, '..'), 'bound-calls.txt'), 'utf8')).toBe(
      '1',
    );
    const state = JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8')) as {
      'US-001': Record<string, unknown>;
    };
    expect(state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
      retryCount: 0,
    });
    expect(state['US-001'].validatorUnverifiable).toMatchObject({ gitHead: fixture.head() });
    const iteration = readEvidence(fixture.workspace).records.find(
      (record) => record.type === 'iteration',
    );
    expect(iteration).toMatchObject({
      validatorOutcome: 'skipped',
      validationProtocol: 'invalid',
      validationProtocolError: { code: 'environment-unverifiable' },
      validatorProfile: {
        policyVersion: 'validator-host-isolation-v1',
        resolution: 'invalid-profile',
      },
    });
  });

  it('refuses a wrapper command as unobservable instead of sealing a partial invocation', async () => {
    const fixture = setupGitProject([story({ acceptanceCriteria: ['AC 1'] })]);
    const fake = fakeBoundValidator(fixture.workspace, 'passed');
    process.env.CODING_X_CODEX_BIN = `node ${fake}`;

    const code = await runLoop({
      ...strictConfig(fixture.workspace, fixture.instructionsDir),
      kind: 'codex',
      validatorRunnerBindingForTests: undefined,
    });

    expect(code).toBe(5);
    const iteration = readEvidence(fixture.workspace).records.find(
      (record) => record.type === 'iteration',
    );
    expect(iteration).toMatchObject({
      validatorOutcome: 'skipped',
      validatorProfile: { resolution: 'runner-unobservable' },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'runs the sealed Codex profile with the real engine canary end to end and binds the v3 receipt',
    async () => {
      const fixture = setupGitProject([story({ acceptanceCriteria: ['AC 1'] })]);
      const canaryMarker = join(fixture.instructionsDir, 'canary-result-path.txt');
      const fake = fakeIsolationRunner(fixture.workspace, canaryMarker);
      // 密封调用只接受单一可执行入口：用 POSIX shim 把 profile argv 交给 fake runner。
      const binDir = mkdtempSync(join(tmpdir(), 'sealed-runner-'));
      cleanups.push(() => rmSync(binDir, { recursive: true, force: true }));
      const shim = join(binDir, 'codex');
      writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
      process.env.CODING_X_CODEX_BIN = shim;

      // 不注入 canary：走生产默认的引擎 canary 执行器（builder → canary → validator 三次调用）。
      const code = await runLoop({
        ...strictConfig(fixture.workspace, fixture.instructionsDir),
        kind: 'codex',
        unsafeUseProjectRootForValidationTests: false,
        validationEnvironmentDigestForTests: undefined,
        validatorRunnerBindingForTests: undefined,
        validatorRunnerObservationForTests: observation(shim, PINNED.codex),
      });

      expect(code).toBe(0);
      const iteration = readEvidence(fixture.workspace).records.find(
        (record) => record.type === 'iteration',
      ) as {
        validatorProfile?: {
          resolution: string;
          runnerVersion?: string;
          profileDigest?: string;
          canaryEvidenceDigest?: string;
          canaryDurationMs?: number;
        };
      };
      expect(iteration).toMatchObject({
        validationReceipt: true,
        validationProtocol: 'passed',
        validatorProfile: {
          resolution: 'ready',
          runnerVersion: PINNED.codex,
          profileDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          canaryEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          canaryDurationMs: expect.any(Number),
        },
      });

      const state = JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8')) as {
        'US-001': {
          validated: boolean;
          validationReceipt: {
            schemaVersion: number;
            runnerProfileDigest: string;
            canaryEvidenceDigest: string;
          };
        };
      };
      expect(state['US-001'].validated).toBe(true);
      // 凭证与证据索引互绑：同一 profile 与 canary 摘要出现在两处。
      expect(state['US-001'].validationReceipt).toMatchObject({
        schemaVersion: 3,
        runnerProfileDigest: `sha256:${iteration.validatorProfile!.profileDigest}`,
        canaryEvidenceDigest: `sha256:${iteration.validatorProfile!.canaryEvidenceDigest}`,
      });

      // canary 曾在临时身份域的授权输出区写回执；收口后整个域必须删除。
      const canaryResultPath = readFileSync(canaryMarker, 'utf8').trim();
      const identityRoot = resolve(canaryResultPath, '..', '..');
      expect(identityRoot).toContain('coding-x-validator-identity-');
      expect(existsSync(identityRoot)).toBe(false);
      expect(existsSync(join(fixture.workspace, 'validation-result.json'))).toBe(false);
    },
    60_000,
  );
});

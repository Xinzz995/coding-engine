import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  environmentEntries,
  runManagedWorkspaceProcess,
} from '../workspace-safety/coordinator.js';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession, type WorkspaceSession } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { observeManagedProcessSettlement } from '../workspace-safety/operation.js';
import type { ReviewPackage } from './package.js';
import {
  ReviewTemporaryDirectory,
  ReviewTemporaryDirectoryError,
} from './temporary-directory.js';
import {
  codexReviewPermissionOverrides,
  parseCodexReviewJsonl,
  parseModelReviewOutput,
  probeRunnerIsolation,
  readRunnerVersion,
  reviewRunnerEnvironment,
  RunnerPolicyViolation,
  runSafeReviewAxis,
} from './runner.js';

const temporaryRoots: string[] = [];

function removeFixtureRoot(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    unlinkSync(path);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) removeFixtureRoot(join(path, name));
  rmdirSync(path);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) {
    removeFixtureRoot(temporaryRoots.pop()!);
  }
});

const fakeSession = {} as WorkspaceSession;

async function confirmedWorkspaceRejection(
  drainReason: 'natural' | 'timeout',
): Promise<WorkspaceSafetyError> {
  const workspace = mkdtempSync(join(tmpdir(), `review-settled-${drainReason}-`));
  temporaryRoots.push(workspace);
  await bootstrapWorkspace({ workspacePath: workspace });
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
  const session = createWorkspaceSession(lease);
  const target = join(workspace, 'rejected-change.txt');
  const script =
    `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'changed');` +
    (drainReason === 'timeout' ? 'setInterval(() => {}, 1000);' : '');
  let failure: unknown;
  try {
    await runManagedWorkspaceProcess(session, {
      kind: 'final-review',
      delegation: 'read-only-v1',
      executable: process.execPath,
      args: ['-e', script],
      cwd: workspace,
      environment: environmentEntries(process.env),
      timeoutMs: drainReason === 'timeout' ? 1_000 : 5_000,
      supervisorTimeouts: {
        naturalDrainMs: 25,
        terminateDrainMs: 3_000,
        pollMs: 10,
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(WorkspaceSafetyError);
  expect(observeManagedProcessSettlement(failure)).toMatchObject({
    status: 'confirmed',
    drainReason,
  });
  return failure as WorkspaceSafetyError;
}

function injectNextExactSealFailure(): () => string {
  const createTemporary = ReviewTemporaryDirectory.create.bind(ReviewTemporaryDirectory);
  let root = '';
  vi.spyOn(ReviewTemporaryDirectory, 'create').mockImplementation((options) => {
    const temporary = createTemporary(options);
    root = temporary.root;
    temporaryRoots.push(root);
    vi.spyOn(temporary, 'sealExactTree').mockImplementation(() => {
      throw new Error('injected exact-tree seal failure');
    });
    return temporary;
  });
  return () => root;
}

type ManagedResult = Awaited<ReturnType<typeof runManagedWorkspaceProcess>>;

function managedResult(stdout: string, over: Partial<ManagedResult> = {}): ManagedResult {
  return {
    verdict: 'completed' as const,
    exitCode: 0,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    timedOut: false,
    processTreeNotEmpty: false,
    terminationReason: null,
    durationMs: 2,
    ...over,
  };
}

function packageFixture(input: string): ReviewPackage {
  const root = mkdtempSync(join(tmpdir(), 'review-runner-test-'));
  temporaryRoots.push(root);
  const inputPath = join(root, 'review-input.json');
  const schemaPath = join(root, 'response-schema.json');
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(inputPath, input);
  writeFileSync(schemaPath, '{}\n');
  writeFileSync(manifestPath, '{}\n');
  return {
    root,
    projectRoot: process.cwd(),
    inputPath,
    schemaPath,
    schema: '{}\n',
    manifestPath,
    input,
    inputBytes: Buffer.byteLength(input),
    digest: 'sha256:fixture',
    cleanup: () => ({ status: 'removed' }),
    assertUnchanged: () => undefined,
    prepareManagedUse: () => undefined,
    beginManagedUse: () => undefined,
    confirmManagedUseSettled: () => undefined,
  };
}

function managedPackageFixture(input = '{}\n'): ReviewPackage {
  const temporary = ReviewTemporaryDirectory.create({
    prefix: 'coding-x-review-managed-test-',
    projectRoot: process.cwd(),
  });
  temporaryRoots.push(temporary.root);
  const inputPath = join(temporary.root, 'review-input.json');
  const schemaPath = join(temporary.root, 'response-schema.json');
  const manifestPath = join(temporary.root, 'manifest.json');
  const schema = '{}\n';
  const manifest = '{}\n';
  writeFileSync(inputPath, input, { mode: 0o400 });
  writeFileSync(schemaPath, schema, { mode: 0o400 });
  writeFileSync(manifestPath, manifest, { mode: 0o400 });
  chmodSync(temporary.root, 0o500);
  temporary.sealExactTree({
    files: [
      {
        path: 'review-input.json',
        bytes: Buffer.from(input),
        maximumBytes: Math.max(4096, Buffer.byteLength(input)),
      },
      { path: 'response-schema.json', bytes: Buffer.from(schema), maximumBytes: 4096 },
      { path: 'manifest.json', bytes: Buffer.from(manifest), maximumBytes: 4096 },
    ],
  });
  return {
    root: temporary.root,
    projectRoot: process.cwd(),
    inputPath,
    schemaPath,
    schema,
    manifestPath,
    input,
    inputBytes: Buffer.byteLength(input),
    digest: 'sha256:managed-fixture',
    cleanup: () => temporary.cleanup(),
    assertUnchanged: () => temporary.assertUnchanged(),
    prepareManagedUse: () => temporary.prepareManagedUse(),
    beginManagedUse: () => temporary.beginManagedUse(),
    confirmManagedUseSettled: () => temporary.confirmManagedUseSettled(),
  };
}

function codexAnswer(value: unknown): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(value) },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
}

function valid(over: Record<string, unknown> = {}) {
  return {
    status: 'failed',
    summary: '发现一个阻断问题',
    requestDeepReview: false,
    unverifiableReason: null,
    findings: [
      {
        severity: 'P1',
        title: '错误传播丢失',
        location: { path: 'src/a.ts', line: 4, symbol: null },
        ruleSource: 'AGENTS.md',
        impact: '调用方会收到假成功',
        recommendation: '保留失败状态',
        requiresHumanDecision: false,
      },
    ],
    ...over,
  };
}

describe('parseModelReviewOutput', () => {
  it('derives blocking status from findings instead of trusting a passed claim', () => {
    expect(parseModelReviewOutput(valid({ status: 'passed' })).status).toBe('failed');
  });

  it('allows non-blocking findings while deriving passed', () => {
    const output = valid({
      status: 'failed',
      findings: [
        {
          severity: 'P2',
          title: '命名可读性',
          location: { path: 'src/a.ts', line: null, symbol: null },
          ruleSource: 'engineering baseline',
          impact: '增加理解成本',
          recommendation: '后续改名',
          requiresHumanDecision: false,
        },
      ],
    });
    expect(parseModelReviewOutput(output).status).toBe('passed');
  });

  it('normalizes nullable structured-output fields to absent optional values', () => {
    expect(
      parseModelReviewOutput({
        status: 'passed',
        summary: '没有问题',
        requestDeepReview: false,
        unverifiableReason: null,
        findings: [],
      }),
    ).toEqual({
      status: 'passed',
      summary: '没有问题',
      requestDeepReview: false,
      findings: [],
    });
    expect(
      parseModelReviewOutput(
        valid({
          unverifiableReason: null,
          findings: [
            {
              ...valid().findings[0],
              location: { path: 'src/a.ts', line: null, symbol: null },
            },
          ],
        }),
      ).findings[0].location,
    ).toEqual({ path: 'src/a.ts' });
  });

  it('rejects malformed, unbound or ambiguous output shapes', () => {
    const { unverifiableReason: _reason, ...withoutReason } = valid();
    const { line: _line, ...withoutLine } = valid().findings[0].location;
    const { symbol: _symbol, ...withoutSymbol } = valid().findings[0].location;
    expect(() => parseModelReviewOutput(withoutReason)).toThrow('缺少 unverifiableReason');
    expect(() =>
      parseModelReviewOutput(
        valid({
          findings: [{ ...valid().findings[0], location: withoutLine }],
        }),
      ),
    ).toThrow('缺少 line');
    expect(() =>
      parseModelReviewOutput(
        valid({
          findings: [{ ...valid().findings[0], location: withoutSymbol }],
        }),
      ),
    ).toThrow('缺少 symbol');
    expect(() => parseModelReviewOutput(valid({ extra: true }))).toThrow('未知字段');
    expect(() => parseModelReviewOutput(valid({ status: 'unverifiable', findings: [] }))).toThrow(
      '提供原因',
    );
    expect(() => parseModelReviewOutput(valid({ findings: [], status: 'failed' }))).toThrow(
      'failed 必须包含',
    );
    expect(() =>
      parseModelReviewOutput(
        valid({
          findings: [
            { ...valid().findings[0], location: { path: '../secret', line: null, symbol: null } },
          ],
        }),
      ),
    ).toThrow('仓库相对路径');
    expect(() =>
      parseModelReviewOutput(
        valid({
          findings: [
            { ...valid().findings[0], location: { path: 'src/a.ts', line: 0, symbol: null } },
          ],
        }),
      ),
    ).toThrow('正整数');
  });

  it('does not echo a model-controlled unknown field into diagnostics', () => {
    const secretKey = 'SHOULD_NOT_APPEAR_AS_UNKNOWN_FIELD';
    let failure: unknown;
    try {
      parseModelReviewOutput(valid({ [secretKey]: true }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('未知字段');
    expect((failure as Error).message).not.toContain(secretKey);
  });
});

describe('parseCodexReviewJsonl', () => {
  it('extracts only a structured final agent message', () => {
    const answer = { status: 'passed', summary: 'ok', requestDeepReview: false, findings: [] };
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'checked' } }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(answer) },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    expect(parseCodexReviewJsonl(stdout)).toEqual(answer);
  });

  it('allows Codex internal todo metadata without treating it as an external tool call', () => {
    const answer = { status: 'passed', summary: 'ok', requestDeepReview: false, findings: [] };
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'todo_list',
          items: [{ text: 'inspect supplied review data', completed: true }],
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(answer) },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    expect(parseCodexReviewJsonl(stdout)).toEqual(answer);
  });

  it.each(['command_execution', 'mcp_tool_call', 'web_search', 'file_change'])(
    'rejects an observed %s tool event even if a final answer exists',
    (type) => {
      const stdout = [
        JSON.stringify({ type: 'item.started', item: { type } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }),
      ].join('\n');
      expect(() => parseCodexReviewJsonl(stdout)).toThrow('已知禁用工具×1');
    },
  );

  it('rejects an unrecognized item type so future capabilities fail closed', () => {
    const stdout = JSON.stringify({
      type: 'item.started',
      item: { type: 'future_capability' },
    });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('未知非被动×1');
  });

  it('rejects an unrecognized top-level event even when a valid final answer follows', () => {
    const answer = { status: 'passed', summary: 'ok', requestDeepReview: false, findings: [] };
    const stdout = [
      JSON.stringify({ type: 'future.event', payload: 'unknown capability' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(answer) },
      }),
    ].join('\n');
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('未知非被动×1');
  });

  it('does not echo a model-controlled event type into diagnostics', () => {
    const secretType = 'SHOULD_NOT_APPEAR_AS_EVENT_TYPE';
    let failure: unknown;
    try {
      parseCodexReviewJsonl(JSON.stringify({ type: secretType }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('未知非被动×1');
    expect((failure as Error).message).not.toContain(secretType);
    expect((failure as Error).message).toMatch(/stdout=\d+B\/sha256:[a-f0-9]{64}/u);
  });

  it('rejects an item event whose item payload is missing', () => {
    const stdout = JSON.stringify({ type: 'item.started' });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('形状损坏×1');
  });

  it('rejects a passive top-level event that unexpectedly carries a tool item', () => {
    const stdout = JSON.stringify({
      type: 'turn.completed',
      item: { type: 'command_execution', command: 'whoami' },
    });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('形状损坏×1');
  });

  it('reports only fixed categories, counts, byte length, and a digest', () => {
    const secrets = [
      'MALICIOUS_EVENT_TYPE',
      'MALICIOUS_COMMAND',
      '/private/secret/path',
      'MODEL_SECRET_TEXT',
    ];
    const stdout = [
      JSON.stringify({ type: secrets[0], payload: secrets[3] }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: secrets[1], cwd: secrets[2] },
      }),
      JSON.stringify({ type: 'item.started', item: { type: 'web_search', query: secrets[3] } }),
      JSON.stringify({ type: 'item.completed', item: secrets[3] }),
    ].join('\n');

    let failure: unknown;
    try {
      parseCodexReviewJsonl(stdout);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RunnerPolicyViolation);
    const message = (failure as Error).message;
    expect(message).toContain('形状损坏×1');
    expect(message).toContain('已知禁用工具×2');
    expect(message).toContain('未知非被动×1');
    expect(message).toContain(`stdout=${Buffer.byteLength(stdout)}B/sha256:`);
    expect(message).toMatch(/sha256:[a-f0-9]{64}/u);
    for (const secret of secrets) expect(message).not.toContain(secret);
  });
});

describe('codexReviewPermissionOverrides', () => {
  it('defaults to deny and grants read-only access only to the exact review package root', () => {
    const cwd = '/tmp/review package';
    expect(codexReviewPermissionOverrides(cwd)).toEqual([
      '-c',
      'default_permissions="coding_x_review"',
      '-c',
      `permissions.coding_x_review.filesystem={ ":minimal" = "read", ":root" = "deny", ":tmpdir" = "deny", ":slash_tmp" = "deny", ${JSON.stringify(resolve(cwd))} = "read" }`,
      '-c',
      'permissions.coding_x_review.network.enabled=false',
    ]);
  });
});

describe('reviewRunnerEnvironment', () => {
  it('canonicalizes the Windows system baseline without passing unrelated values', () => {
    expect(
      reviewRunnerEnvironment(
        'codex',
        {
          SYSTEMROOT: 'C:\\Windows',
          Temp: 'C:\\ReviewTemp',
          tmp: 'C:\\ReviewTemp',
          Path: 'C:\\Tools',
          openai_api_key: 'fixture-key',
          OPENAI_API_KEY_BACKUP: 'must-not-pass',
          CODEX_HOMEX: 'must-not-pass',
          UNRELATED_SECRET: 'must-not-pass',
        },
        'win32',
      ),
    ).toEqual({
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\ReviewTemp',
      TMP: 'C:\\ReviewTemp',
      PATH: 'C:\\Tools',
      OPENAI_API_KEY: 'fixture-key',
      CI: '1',
      NO_COLOR: '1',
    });
  });

  it('keeps exact credentials and declared namespaces without widening their names', () => {
    expect(
      reviewRunnerEnvironment('codex', {
        CODEX_API_KEY: 'codex-key',
        OPENAI_API_KEY: 'openai-key',
        CODEX_HOME: '/codex-home',
        OPENAI_API_KEY_BACKUP: 'must-not-pass',
        CODEX_HOMEX: 'must-not-pass',
      }),
    ).toEqual({
      CODEX_API_KEY: 'codex-key',
      OPENAI_API_KEY: 'openai-key',
      CODEX_HOME: '/codex-home',
      CI: '1',
      NO_COLOR: '1',
    });
    expect(
      reviewRunnerEnvironment('claude', {
        ANTHROPIC_API_KEY: 'anthropic-key',
        GOOGLE_APPLICATION_CREDENTIALS: '/credentials.json',
        CLOUD_ML_REGION: 'region',
        CLAUDE_CODE_USE_VERTEX: '1',
        AWS_PROFILE: 'review',
        ANTHROPIC_VERTEX_PROJECT_ID: 'project',
        ANTHROPIC_API_KEY_OLD: 'must-not-pass',
        GOOGLE_APPLICATION_CREDENTIALS_BACKUP: 'must-not-pass',
        CLOUD_ML_REGION_OLD: 'must-not-pass',
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: 'anthropic-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/credentials.json',
      CLOUD_ML_REGION: 'region',
      CLAUDE_CODE_USE_VERTEX: '1',
      AWS_PROFILE: 'review',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project',
      CI: '1',
      NO_COLOR: '1',
    });
    expect(
      reviewRunnerEnvironment('cursor', {
        CURSOR_API_KEY: 'cursor-key',
        CURSOR_API_ENDPOINT: 'https://cursor.example',
        CURSOR_API_KEY_OLD: 'must-not-pass',
        CURSOR_API_ENDPOINT_BACKUP: 'must-not-pass',
      }),
    ).toEqual({
      CURSOR_API_KEY: 'cursor-key',
      CURSOR_API_ENDPOINT: 'https://cursor.example',
      CI: '1',
      NO_COLOR: '1',
    });
  });

  it('fails closed on case-insensitive Windows environment aliases', () => {
    expect(() =>
      reviewRunnerEnvironment(
        'codex',
        { SystemRoot: 'C:\\Windows', SYSTEMROOT: 'C:\\Other' },
        'win32',
      ),
    ).toThrow('大小写冲突');
  });
});

describe('Reviewer temporary-domain initialization cleanup', () => {
  it('removes a partially initialized Runner invocation before any process starts', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const invocationRoot = injectNextExactSealFailure();
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult('');
    };

    await expect(
      runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage: packageFixture('{}'),
        timeoutMs: 1000,
        managedProcess: managed,
      }),
    ).rejects.toThrow(/Runner 调用初始化现场已安全清理/u);
    expect(calls).toBe(0);
    expect(invocationRoot()).not.toBe('');
    expect(existsSync(invocationRoot())).toBe(false);
  });

  it('removes a partially initialized Runner version domain before execution', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const versionRoot = injectNextExactSealFailure();
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult('');
    };

    await expect(
      readRunnerVersion({
        session: fakeSession,
        runner: 'codex',
        projectRoot: process.cwd(),
        managedProcess: managed,
      }),
    ).rejects.toThrow(/injected exact-tree seal failure/u);
    expect(calls).toBe(0);
    expect(versionRoot()).not.toBe('');
    expect(existsSync(versionRoot())).toBe(false);
  });

  it('removes a partially initialized isolation probe before execution', async () => {
    const probeRoot = injectNextExactSealFailure();
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult('');
    };

    await expect(
      probeRunnerIsolation({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        projectRoot: process.cwd(),
        timeoutMs: 1000,
        managedProcess: managed,
      }),
    ).rejects.toThrow(/Runner 隔离探测初始化失败.*现场已安全清理/u);
    expect(calls).toBe(0);
    expect(probeRoot()).not.toBe('');
    expect(existsSync(probeRoot())).toBe(false);
  });
});

describe('managed Final Review runner execution', () => {
  it.runIf(process.platform === 'win32')(
    'rejects a Windows Runner script wrapper before version or Review execution',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'review-runner-shim-'));
      temporaryRoots.push(root);
      const executable = join(root, 'codex.cmd');
      writeFileSync(executable, '@echo off\r\nexit /b 0\r\n');
      vi.stubEnv('CODING_X_CODEX_BIN', executable);
      const managed = vi.fn<typeof runManagedWorkspaceProcess>();

      await expect(
        readRunnerVersion({
          session: fakeSession,
          runner: 'codex',
          projectRoot: process.cwd(),
          managedProcess: managed,
        }),
      ).rejects.toThrow(/原生可执行文件/u);

      await expect(
        runSafeReviewAxis({
          session: fakeSession,
          runner: 'codex',
          model: 'review-model',
          runnerVersion: 'codex-test',
          axis: 'engineering',
          reviewPackage: packageFixture('{}'),
          timeoutMs: 1000,
          managedProcess: managed,
        }),
      ).rejects.toThrow(/原生可执行文件/u);
      expect(managed).not.toHaveBeenCalled();
    },
  );

  it('uses the fixed read-only managed operation for runner version checks', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const managed: typeof runManagedWorkspaceProcess = async (session, options) => {
      expect(session).toBe(fakeSession);
      expect(options).toMatchObject({
        kind: 'final-review',
        delegation: 'read-only-v1',
        executable: process.execPath,
        args: ['--version'],
      });
      return managedResult('codex-cli 1.2.3\n');
    };

    await expect(
      readRunnerVersion({
        session: fakeSession,
        runner: 'codex',
        projectRoot: process.cwd(),
        managedProcess: managed,
      }),
    ).resolves.toBe('codex-cli 1.2.3');
  });

  it('preserves workspace safety failures from Runner version supervision', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const failure = new WorkspaceSafetyError('isolated', 'process tree not empty');
    let retainedPath = '';
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      retainedPath = options.cwd;
      temporaryRoots.push(retainedPath);
      throw failure;
    };

    const outcome = expect(
      readRunnerVersion({
        session: fakeSession,
        runner: 'codex',
        projectRoot: process.cwd(),
        managedProcess: managed,
      }),
    ).rejects;
    await outcome.toMatchObject({ code: 'isolated' });
    await outcome.toThrow(/process tree not empty.*Runner 版本临时域已保留/u);
    expect(retainedPath).not.toBe('');
    expect(() => realpathSync.native(retainedPath)).not.toThrow();
  });

  it('cleans the Runner version domain after a natural closeout whose workspace delta is rejected', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const workspaceFailure = await confirmedWorkspaceRejection('natural');
    let temporaryPath = '';
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      temporaryPath = options.cwd;
      temporaryRoots.push(temporaryPath);
      throw workspaceFailure;
    };

    await expect(
      readRunnerVersion({
        session: fakeSession,
        runner: 'codex',
        projectRoot: process.cwd(),
        managedProcess: managed,
      }),
    ).rejects.toThrow(/semantic delta was not accepted/u);
    expect(temporaryPath).not.toBe('');
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it('retains the Runner version domain after a supervised timeout', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let retainedPath = '';
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      retainedPath = options.cwd;
      temporaryRoots.push(retainedPath);
      return managedResult('', {
        verdict: 'terminated',
        exitCode: null,
        timedOut: true,
        terminationReason: 'timeout',
      });
    };

    await expect(
      readRunnerVersion({
        session: fakeSession,
        runner: 'codex',
        projectRoot: process.cwd(),
        managedProcess: managed,
      }),
    ).rejects.toThrow(/临时域已保留.*版本核对超时/u);
    expect(existsSync(retainedPath)).toBe(true);
  });

  it.each(['user-interrupt', 'parent-shutdown'] as const)(
    'retains the Runner version domain after %s',
    async (terminationReason) => {
      vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
      let retainedPath = '';
      const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
        retainedPath = options.cwd;
        temporaryRoots.push(retainedPath);
        return managedResult('', {
          verdict: 'terminated',
          exitCode: null,
          terminationReason,
        });
      };

      await expect(
        readRunnerVersion({
          session: fakeSession,
          runner: 'codex',
          projectRoot: process.cwd(),
          managedProcess: managed,
        }),
      ).rejects.toThrow(/临时域已保留.*被外部终止/u);
      expect(existsSync(retainedPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(lstatSync(retainedPath).mode & 0o777).toBe(0o500);
      }
    },
  );

  it('retains a Runner version domain whose fixed tree changes during execution', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let retainedPath = '';
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      retainedPath = options.cwd;
      temporaryRoots.push(retainedPath);
      chmodSync(retainedPath, 0o755);
      writeFileSync(join(retainedPath, 'unexpected-file'), 'pollution\n');
      return managedResult('codex-cli 1.2.3\n');
    };

    await expect(
      readRunnerVersion({
        session: fakeSession,
        runner: 'codex',
        projectRoot: process.cwd(),
        managedProcess: managed,
      }),
    ).rejects.toThrow(/临时域已保留.*(?:根目录权限|固定目录树)发生变化/u);
    expect(existsSync(retainedPath)).toBe(true);
  });

  it('routes the isolation probe through the managed proxy operation', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async (session, options) => {
      calls += 1;
      expect(session).toBe(fakeSession);
      expect(options.kind).toBe('final-review');
      expect(options.delegation).toBe('read-only-v1');
      expect(options.executable).toBe(process.execPath);
      expect(options.args[0]).toMatch(/review-runner-proxy\.mjs$/u);
      const config = JSON.parse(readFileSync(options.args[1], 'utf8')) as {
        promptPath: string;
        promptMode: string;
      };
      expect(config.promptMode).toBe('stdin');
      const prompt = readFileSync(config.promptPath, 'utf8');
      expect(prompt).toContain('Runner 隔离反向测试');
      expect(prompt).toContain('调用成功且得到可用结果');
      expect(prompt).toContain('被拒绝、不可用或报错都必须为 false');
      return managedResult(
        codexAnswer({
          outsideSecret: null,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: false,
        }),
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });
    expect(result.ok, result.failures.join('；')).toBe(true);
    expect(result.policyVersion).toBe('package-read-only-v7');
    expect(calls).toBe(1);
  });

  it('retries one transient non-zero isolation probe exit without changing models', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const models: string[] = [];
    const probeRoots: string[] = [];
    const invocationRoots: string[] = [];
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      calls += 1;
      const config = JSON.parse(readFileSync(options.args[1], 'utf8')) as { args: string[] };
      const modelIndex = config.args.indexOf('--model');
      models.push(config.args[modelIndex + 1]);
      probeRoots.push(dirname(options.cwd));
      invocationRoots.push(dirname(options.args[1]));
      if (calls === 1) {
        return managedResult(
          JSON.stringify({ type: 'turn.failed', terminal_reason: 'api_error' }),
          {
            exitCode: 1,
            stderr: Buffer.from('temporary gateway failure'),
          },
        );
      }
      return managedResult(
        codexAnswer({
          outsideSecret: null,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: false,
        }),
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok, result.failures.join('；')).toBe(true);
    expect(result.model).toBe('review-model');
    expect(calls).toBe(2);
    expect(models).toEqual(['review-model', 'review-model']);
    expect(new Set(probeRoots).size).toBe(1);
    expect(new Set(invocationRoots).size).toBe(2);
  });

  it('does not retry an unclassified non-zero isolation probe exit', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult('', {
        exitCode: 9,
        stderr: Buffer.from('NON_SENSITIVE_RAW_TAIL'),
      });
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('退出码 9');
    expect(result.failures.join('；')).toContain('stderr=22B/sha256:');
    expect(result.failures.join('；')).not.toContain('NON_SENSITIVE_RAW_TAIL');
    expect(calls).toBe(1);
  });

  it('does not retry a malformed isolation probe event stream', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      if (calls === 1) return managedResult('not-jsonl\n');
      return managedResult(
        codexAnswer({
          outsideSecret: null,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: false,
        }),
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('形状损坏×1');
    expect(calls).toBe(1);
  });

  it('does not retry an isolation probe result with an invalid schema shape', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      if (calls === 1) return managedResult(codexAnswer({}));
      return managedResult(
        codexAnswer({
          outsideSecret: null,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: false,
        }),
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('缺少 outsideSecret');
    expect(calls).toBe(1);
  });

  it('does not let malformed Codex output hide a later forbidden tool event', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      if (calls === 1) {
        return managedResult(
          [
            'not-jsonl',
            JSON.stringify({
              type: 'item.completed',
              item: { type: 'command_execution', command: 'touch forbidden' },
            }),
          ].join('\n'),
          { exitCode: 1 },
        );
      }
      return managedResult(
        codexAnswer({
          outsideSecret: null,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: false,
        }),
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('已知禁用工具×1');
    expect(calls).toBe(1);
  });

  it.each([
    [
      'direct result',
      {
        outsideSecret: null,
        fileWriteSucceeded: false,
        dangerousCommandSucceeded: false,
        externalToolSucceeded: true,
      },
    ],
    [
      'nested result',
      {
        type: 'turn.failed',
        terminal_reason: 'api_error',
        structured_output: {
          outsideSecret: null,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: true,
        },
      },
    ],
    [
      'string-wrapped result',
      {
        type: 'turn.failed',
        terminal_reason: 'api_error',
        result: JSON.stringify({
          outsideSecret: null,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: true,
        }),
      },
    ],
  ])('blocks Codex external tool success in a %s', async (_name, value) => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult(
        Object.hasOwn(value, 'type') ? JSON.stringify(value) : codexAnswer(value),
        Object.hasOwn(value, 'type') ? { exitCode: 1 } : {},
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('Runner 声明成功调用了外部工具');
    expect(calls).toBe(1);
  });

  it.each([
    [
      'error.structured_output',
      {
        type: 'turn.failed',
        terminal_reason: 'api_error',
        error: {
          structured_output: {
            layer1: {
              layer2: {
                outsideSecret: 'DEEP_OUTSIDE_SECRET',
                fileWriteSucceeded: true,
              },
            },
          },
        },
      },
      ['Runner 声明能够读取审查包外文件', 'Runner 声明能够写文件'],
    ],
    [
      'details.result',
      {
        type: 'turn.failed',
        terminal_reason: 'api_error',
        details: {
          result: JSON.stringify({
            layer1: {
              layer2: {
                dangerousCommandSucceeded: true,
                externalToolSucceeded: true,
              },
            },
          }),
        },
      },
      ['Runner 声明能够执行危险命令', 'Runner 声明成功调用了外部工具'],
    ],
  ])('blocks deeply wrapped isolation claims in %s without retrying', async (_name, value, diagnostics) => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult(JSON.stringify(value), { exitCode: 1 });
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    for (const diagnostic of diagnostics) {
      expect(result.failures.join('；')).toContain(diagnostic);
    }
    expect(result.failures.join('；')).not.toContain('DEEP_OUTSIDE_SECRET');
    expect(calls).toBe(1);
  });

  it('does not parse claim-shaped text outside explicit result wrappers', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      if (calls === 1) {
        return managedResult(
          JSON.stringify({
            type: 'turn.failed',
            terminal_reason: 'api_error',
            details: '{"externalToolSucceeded":true,"outsideSecret":"TEXT_ONLY"}',
          }),
          { exitCode: 1 },
        );
      }
      return managedResult(
        codexAnswer({
          outsideSecret: null,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: false,
        }),
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok, result.failures.join('；')).toBe(true);
    expect(calls).toBe(2);
  });

  it('fails closed when nested isolation data exceeds the bounded scan depth', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 20; depth += 1) nested = { next: nested };
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult(
        JSON.stringify({
          type: 'turn.failed',
          terminal_reason: 'api_error',
          error: { structured_output: nested },
        }),
        { exitCode: 1 },
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('Runner 隔离声明超出有界扫描范围');
    expect(calls).toBe(1);
  });

  it.each([
    [
      'direct safe probe fields',
      {
        type: 'turn.failed',
        terminal_reason: 'api_error',
        outsideSecret: null,
        fileWriteSucceeded: false,
        dangerousCommandSucceeded: false,
        externalToolSucceeded: false,
      },
      '退出码 1',
    ],
    [
      'a nested unsafe probe result',
      {
        type: 'turn.failed',
        terminal_reason: 'api_error',
        structured_output: {
          outsideSecret: 'runner-claimed-secret-access',
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: false,
        },
      },
      '声明能够读取审查包外文件',
    ],
  ])(
    'does not retry a Codex service failure that already contains %s',
    async (_name, firstEvent, diagnostic) => {
      vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
      let calls = 0;
      const managed: typeof runManagedWorkspaceProcess = async () => {
        calls += 1;
        if (calls === 1) {
          return managedResult(JSON.stringify(firstEvent), { exitCode: 1 });
        }
        return managedResult(
          codexAnswer({
            outsideSecret: null,
            fileWriteSucceeded: false,
            dangerousCommandSucceeded: false,
            externalToolSucceeded: false,
          }),
        );
      };

      const result = await probeRunnerIsolation({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        projectRoot: process.cwd(),
        runnerVersion: 'codex-test',
        timeoutMs: 1000,
        managedProcess: managed,
      });

      expect(result.ok).toBe(false);
      expect(result.failures.join('；')).toContain(diagnostic);
      expect(result.failures.join('；')).not.toContain('runner-claimed-secret-access');
      expect(calls).toBe(1);
    },
  );

  it.each(['claude', 'cursor'] as const)(
    'does not let a %s error envelope hide an unsafe structured result',
    async (runner) => {
      vi.stubEnv(
        runner === 'claude' ? 'CODING_X_CLAUDE_BIN' : 'CODING_X_CURSOR_BIN',
        process.execPath,
      );
      let calls = 0;
      const managed: typeof runManagedWorkspaceProcess = async () => {
        calls += 1;
        return managedResult(
          JSON.stringify({
            is_error: true,
            structured_output: {
              outsideSecret: 'runner-claimed-secret-access',
              fileWriteSucceeded: false,
              dangerousCommandSucceeded: false,
              externalToolSucceeded: false,
            },
          }),
          { exitCode: 1 },
        );
      };

      const result = await probeRunnerIsolation({
        session: fakeSession,
        runner,
        model: 'review-model',
        projectRoot: process.cwd(),
        runnerVersion: `${runner}-test`,
        timeoutMs: 1000,
        managedProcess: managed,
      });

      expect(result.ok).toBe(false);
      expect(result.failures.join('；')).toContain('声明能够读取审查包外文件');
      expect(result.failures.join('；')).not.toContain('runner-claimed-secret-access');
      expect(calls).toBe(1);
    },
  );

  it('does not let an invalid Claude result shape hide an unsafe claim', async () => {
    vi.stubEnv('CODING_X_CLAUDE_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult(
        JSON.stringify({
          is_error: true,
          result: {
            outsideSecret: 'runner-claimed-secret-access',
            fileWriteSucceeded: false,
            dangerousCommandSucceeded: false,
            externalToolSucceeded: false,
          },
        }),
        { exitCode: 1 },
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'claude',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'claude-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('声明能够读取审查包外文件');
    expect(calls).toBe(1);
  });

  it('retries one explicit Claude service failure with no result payload', async () => {
    vi.stubEnv('CODING_X_CLAUDE_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      if (calls === 1) {
        return managedResult(JSON.stringify({ is_error: true }), { exitCode: 1 });
      }
      return managedResult(
        JSON.stringify({
          structured_output: {
            outsideSecret: null,
            fileWriteSucceeded: false,
            dangerousCommandSucceeded: false,
            externalToolSucceeded: false,
          },
        }),
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'claude',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'claude-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok, result.failures.join('；')).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not retry a Claude error envelope that already contains probe fields', async () => {
    vi.stubEnv('CODING_X_CLAUDE_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      if (calls === 1) {
        return managedResult(
          JSON.stringify({
            is_error: true,
            outsideSecret: null,
            fileWriteSucceeded: false,
            dangerousCommandSucceeded: false,
            externalToolSucceeded: false,
          }),
          { exitCode: 1 },
        );
      }
      return managedResult(
        JSON.stringify({
          structured_output: {
            outsideSecret: null,
            fileWriteSucceeded: false,
            dangerousCommandSucceeded: false,
            externalToolSucceeded: false,
          },
        }),
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'claude',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'claude-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('does not retry after the first isolation probe reads the canary secret', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    let canary = '';
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      calls += 1;
      canary = readFileSync(join(dirname(options.cwd), 'outside-secret.txt'), 'utf8');
      return managedResult(
        codexAnswer({
          outsideSecret: canary,
          fileWriteSucceeded: false,
          dangerousCommandSucceeded: false,
          externalToolSucceeded: false,
        }),
        { exitCode: 1 },
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('读取了审查包外的假秘密');
    expect(result.failures.join('；')).not.toContain(canary);
    expect(calls).toBe(1);
  });

  it('does not retry after the first isolation probe reports a policy violation', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult(
        codexAnswer({
          outsideSecret: 'runner-claimed-secret-access',
          unexpectedField: 'schema-is-also-invalid',
        }),
        { exitCode: 1 },
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('声明能够读取审查包外文件');
    expect(calls).toBe(1);
  });

  it('does not retry an isolation probe after cancellation arrives', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const controller = new AbortController();
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      controller.abort();
      return managedResult('', { exitCode: 1 });
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      termination: { signal: controller.signal, reason: 'user-interrupt' },
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('does not retry a deterministic isolation probe setup failure', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      throw new Error('deterministic invocation setup failure');
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('deterministic invocation setup failure');
    expect(calls).toBe(1);
  });

  it.each([
    [
      'workspace safety failure',
      () => new WorkspaceSafetyError('isolated', 'injected workspace safety failure'),
    ],
    [
      'temporary directory failure',
      () => new ReviewTemporaryDirectoryError('injected temporary directory failure'),
    ],
  ])('does not retry an isolation probe after a %s', async (_name, failure) => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      throw failure();
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('keeps a non-sensitive diagnostic after two transient isolation probe failures', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult(
        JSON.stringify({
          type: 'turn.failed',
          terminal_reason: 'api_error',
          detail: 'OUTPUT_SECRET',
        }),
        {
          exitCode: 1,
          stderr: Buffer.from(`${'x'.repeat(3_000)}DIAGNOSTIC_TAIL`),
        },
      );
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('stderr=3015B/sha256:');
    expect(result.failures[0]).toContain('flags=api-error');
    expect(result.failures[0]).not.toContain('DIAGNOSTIC_TAIL');
    expect(result.failures[0]).not.toContain('OUTPUT_SECRET');
    expect(result.failures[0]).not.toContain('x'.repeat(20));
    expect(result.failures[0].length).toBeLessThanOrEqual(400);
    expect(calls).toBe(2);
  });

  it.each([
    [
      'a forbidden tool event',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'touch forbidden' },
      }),
      '已知禁用工具×1',
    ],
    [
      'an invalid item envelope',
      JSON.stringify({ type: 'item.completed', item: '{"type":"command_execution"}' }),
      '形状损坏×1',
    ],
    ['a parseable non-object event', 'null', '形状损坏×1'],
  ])('does not retry an actual Review after %s', async (_name, firstOutput, diagnostic) => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const reviewPackage = managedPackageFixture();
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      if (calls === 1) return managedResult(firstOutput, { exitCode: 1 });
      return managedResult(
        codexAnswer({
          status: 'passed',
          summary: 'safe second result',
          requestDeepReview: false,
          unverifiableReason: null,
          findings: [],
        }),
      );
    };

    let failure: unknown;
    try {
      await runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RunnerPolicyViolation);
    expect((failure as Error).message).toContain(diagnostic);
    expect(calls).toBe(1);
    expect(reviewPackage.cleanup()).toEqual({ status: 'removed' });
  });

  it('retains both isolation-probe domains when descendants outlive the root process', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    let probeRoot = '';
    let invocationRoot = '';
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      calls += 1;
      probeRoot = dirname(options.cwd);
      invocationRoot = dirname(options.args[1]);
      temporaryRoots.push(probeRoot, invocationRoot);
      return managedResult('', {
        verdict: 'process-tree-not-empty',
        processTreeNotEmpty: true,
      });
    };

    const result = await probeRunnerIsolation({
      session: fakeSession,
      runner: 'codex',
      model: 'review-model',
      projectRoot: process.cwd(),
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join('；')).toContain('后代进程');
    expect(result.failures.join('；')).toContain('现场已保留');
    expect(calls).toBe(1);
    expect(existsSync(probeRoot)).toBe(true);
    expect(existsSync(invocationRoot)).toBe(true);
  });

  it('does not retry and retains the invocation plus package after process-tree residue', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const reviewPackage = managedPackageFixture();
    let invocationRoot = '';
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      calls += 1;
      invocationRoot = dirname(options.args[1]);
      temporaryRoots.push(invocationRoot);
      return managedResult('', {
        verdict: 'process-tree-not-empty',
        processTreeNotEmpty: true,
      });
    };

    await expect(
      runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      }),
    ).rejects.toThrow(/临时域已保留.*后代进程/u);
    expect(calls).toBe(1);
    expect(reviewPackage.cleanup()).toMatchObject({
      status: 'retained',
      location: { status: 'verified', path: reviewPackage.root },
    });
    expect(existsSync(reviewPackage.root)).toBe(true);
    expect(existsSync(invocationRoot)).toBe(true);
  });

  it.each(['user-interrupt', 'parent-shutdown'] as const)(
    'does not retry and retains Review domains after an unsettled %s',
    async (terminationReason) => {
      vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
      const reviewPackage = managedPackageFixture();
      let invocationRoot = '';
      let calls = 0;
      const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
        calls += 1;
        invocationRoot = dirname(options.args[1]);
        temporaryRoots.push(invocationRoot);
        return managedResult('', {
          verdict: 'terminated',
          exitCode: null,
          terminationReason,
        });
      };

      await expect(
        runSafeReviewAxis({
          session: fakeSession,
          runner: 'codex',
          model: 'review-model',
          runnerVersion: 'codex-test',
          axis: 'engineering',
          reviewPackage,
          timeoutMs: 1000,
          managedProcess: managed,
        }),
      ).rejects.toThrow(/临时域已保留.*被外部终止/u);
      expect(calls).toBe(1);
      expect(reviewPackage.cleanup()).toMatchObject({ status: 'retained' });
      expect(existsSync(reviewPackage.root)).toBe(true);
      expect(existsSync(invocationRoot)).toBe(true);
      if (process.platform !== 'win32') {
        expect(lstatSync(reviewPackage.root).mode & 0o777).toBe(0o500);
        expect(lstatSync(invocationRoot).mode & 0o777).toBe(0o500);
        for (const name of ['review-runner-proxy.mjs', 'prompt.txt', 'proxy-config.json']) {
          expect(lstatSync(join(invocationRoot, name)).mode & 0o777).toBe(0o400);
        }
      }
    },
  );

  it('retains both Review domains when managed process startup throws directly', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const reviewPackage = managedPackageFixture();
    let invocationRoot = '';
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      calls += 1;
      invocationRoot = dirname(options.args[1]);
      temporaryRoots.push(invocationRoot);
      throw new Error('fixture managed startup failure');
    };

    await expect(
      runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      }),
    ).rejects.toThrow(/临时域已保留.*managed startup failure/u);
    expect(calls).toBe(1);
    expect(reviewPackage.cleanup()).toMatchObject({ status: 'retained' });
    expect(existsSync(reviewPackage.root)).toBe(true);
    expect(existsSync(invocationRoot)).toBe(true);
  });

  it('cleans both Review domains after a natural closeout whose workspace delta is rejected', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const workspaceFailure = await confirmedWorkspaceRejection('natural');
    const reviewPackage = managedPackageFixture();
    let invocationRoot = '';
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      invocationRoot = dirname(options.args[1]);
      temporaryRoots.push(invocationRoot);
      throw workspaceFailure;
    };

    await expect(
      runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      }),
    ).rejects.toThrow(/semantic delta was not accepted/u);
    expect(existsSync(invocationRoot)).toBe(false);
    expect(reviewPackage.cleanup()).toEqual({ status: 'removed' });
    expect(existsSync(reviewPackage.root)).toBe(false);
  });

  it('retains both Review domains after a timed-out closeout whose workspace delta is rejected', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const workspaceFailure = await confirmedWorkspaceRejection('timeout');
    const reviewPackage = managedPackageFixture();
    let invocationRoot = '';
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      invocationRoot = dirname(options.args[1]);
      temporaryRoots.push(invocationRoot);
      throw workspaceFailure;
    };

    await expect(
      runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      }),
    ).rejects.toThrow(/临时域已保留.*semantic delta was not accepted/u);
    expect(existsSync(invocationRoot)).toBe(true);
    expect(reviewPackage.cleanup()).toMatchObject({ status: 'retained' });
    expect(existsSync(reviewPackage.root)).toBe(true);
  });

  it('does not retry when the first Review event stream has a damaged shape', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const reviewPackage = managedPackageFixture();
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      calls += 1;
      if (calls === 1) return managedResult('not-jsonl\n');
      temporaryRoots.push(dirname(options.args[1]));
      return managedResult('', {
        verdict: 'process-tree-not-empty',
        processTreeNotEmpty: true,
      });
    };

    let failure: unknown;
    try {
      await runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      });
    } catch (error) {
      failure = error;
    }
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(RunnerPolicyViolation);
    expect((failure as RunnerPolicyViolation).attempts).toBe(1);
    expect((failure as Error).message).toContain('形状损坏×1');
    expect(reviewPackage.cleanup()).toEqual({ status: 'removed' });
  });

  it('does not retry when the invocation directory is polluted during a managed call', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const reviewPackage = packageFixture('{}');
    let invocationRoot = '';
    let calls = 0;
    const attackerControlledName = 'PROMPT_FRAGMENT_SECRET';
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      calls += 1;
      invocationRoot = dirname(options.args[1]);
      temporaryRoots.push(invocationRoot);
      chmodSync(invocationRoot, 0o755);
      writeFileSync(join(invocationRoot, attackerControlledName), 'pollution\n');
      return managedResult(
        codexAnswer({
          status: 'passed',
          summary: 'ok',
          requestDeepReview: false,
          unverifiableReason: null,
          findings: [],
        }),
      );
    };

    let failure: unknown;
    try {
      await runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RunnerPolicyViolation);
    expect((failure as Error).message).toMatch(/临时域已保留.*(?:根目录权限|固定目录树)发生变化/u);
    expect((failure as Error).message).not.toContain(attackerControlledName);
    expect(calls).toBe(1);
    expect(existsSync(invocationRoot)).toBe(true);
  });

  it('does not copy Runner output containing source or secrets into failure diagnostics', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const secret = 'SHOULD_NOT_APPEAR_IN_DIAGNOSTICS';
    let calls = 0;
    const managed: typeof runManagedWorkspaceProcess = async () => {
      calls += 1;
      return managedResult(secret, {
        exitCode: 9,
        stderr: Buffer.from(`prompt and source: ${secret}`),
      });
    };

    let failure: unknown;
    try {
      await runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage: packageFixture('{}'),
        timeoutMs: 1000,
        managedProcess: managed,
      });
    } catch (error) {
      failure = error;
    }
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(RunnerPolicyViolation);
    expect((failure as Error).message).toContain('形状损坏×1');
    expect((failure as Error).message).not.toContain(secret);
  });

  it.runIf(process.platform !== 'win32')(
    'binds the proxy and managed target to one native canonical review root',
    async () => {
      vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
      const original = packageFixture('{}');
      const alias = `${original.root}-alias`;
      symlinkSync(original.root, alias, 'dir');
      temporaryRoots.push(alias);
      const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
        const config = JSON.parse(readFileSync(options.args[1], 'utf8')) as { cwd: string };
        const canonical = realpathSync.native(original.root);
        expect(options.cwd).toBe(canonical);
        expect(config.cwd).toBe(canonical);
        return managedResult(
          codexAnswer({
            status: 'passed',
            summary: 'ok',
            requestDeepReview: false,
            unverifiableReason: null,
            findings: [],
          }),
        );
      };

      await expect(
        runSafeReviewAxis({
          session: fakeSession,
          runner: 'codex',
          model: 'review-model',
          runnerVersion: 'codex-test',
          axis: 'engineering',
          reviewPackage: { ...original, root: alias },
          timeoutMs: 1000,
          managedProcess: managed,
        }),
      ).resolves.toMatchObject({ output: { status: 'passed' } });
    },
  );

  it('keeps a large Codex prompt out of argv and preserves all bytes in the proxy input file', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const input = JSON.stringify({ diff: 'x'.repeat(128 * 1024) });
    const reviewPackage = packageFixture(input);
    const managed: typeof runManagedWorkspaceProcess = async (_session, options) => {
      expect(options).toMatchObject({
        kind: 'final-review',
        delegation: 'read-only-v1',
        executable: process.execPath,
      });
      expect(options.args).toHaveLength(2);
      const config = JSON.parse(readFileSync(options.args[1], 'utf8')) as {
        args: string[];
        promptPath: string;
        promptMode: string;
      };
      expect(config.promptMode).toBe('stdin');
      expect(config.args).not.toContain(expect.stringContaining('x'.repeat(1024)));
      const prompt = readFileSync(config.promptPath, 'utf8');
      expect(prompt).toContain(input);
      expect(Buffer.byteLength(prompt)).toBeGreaterThan(Buffer.byteLength(input));
      return managedResult(
        codexAnswer({
          status: 'passed',
          summary: 'ok',
          requestDeepReview: false,
          unverifiableReason: null,
          findings: [],
        }),
      );
    };

    await expect(
      runSafeReviewAxis({
        session: fakeSession,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      }),
    ).resolves.toMatchObject({
      attempts: 1,
      output: { status: 'passed', findings: [] },
    });
  });

  it('fails closed instead of truncating a Cursor prompt that cannot safely fit argv', async () => {
    vi.stubEnv('CODING_X_CURSOR_BIN', process.execPath);
    const managed = vi.fn<typeof runManagedWorkspaceProcess>();
    const reviewPackage = packageFixture(JSON.stringify({ diff: 'x'.repeat(20 * 1024) }));

    await expect(
      runSafeReviewAxis({
        session: fakeSession,
        runner: 'cursor',
        model: 'review-model',
        runnerVersion: 'cursor-test',
        axis: 'spec',
        reviewPackage,
        timeoutMs: 1000,
        managedProcess: managed,
      }),
    ).rejects.toThrow('固定参数上限');
    expect(managed).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'delivers a complete prompt through the real supervisor and fixed proxy',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'review-runner-managed-test-'));
      const runnerRoot = mkdtempSync(join(tmpdir(), 'review-runner-binary-test-'));
      temporaryRoots.push(workspace, runnerRoot);
      const runnerPath = join(runnerRoot, 'fake-codex.mjs');
      writeFileSync(
        runnerPath,
        [
          '#!/usr/bin/env node',
          'const chunks=[];',
          'process.stdin.on("data",chunk=>chunks.push(chunk));',
          'process.stdin.on("end",()=>{',
          '  const prompt=Buffer.concat(chunks);',
          '  if(prompt.length<65536) process.exit(9);',
          '  const answer={status:"passed",summary:"ok",requestDeepReview:false,',
          '    unverifiableReason:null,findings:[]};',
          '  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"fixture"})+"\\n");',
          '  process.stdout.write(JSON.stringify({type:"item.completed",item:{',
          '    type:"agent_message",text:JSON.stringify(answer)}})+"\\n");',
          '  process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");',
          '});',
        ].join('\n'),
      );
      chmodSync(runnerPath, 0o755);
      vi.stubEnv('CODING_X_CODEX_BIN', runnerPath);
      await bootstrapWorkspace({ workspacePath: workspace });
      const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
      const session = createWorkspaceSession(lease);
      const reviewPackage = managedPackageFixture(
        JSON.stringify({ diff: 'x'.repeat(128 * 1024) }),
      );
      try {
        await expect(
          runSafeReviewAxis({
            session,
            runner: 'codex',
            model: 'review-model',
            runnerVersion: 'codex-test',
            axis: 'engineering',
            reviewPackage,
            timeoutMs: 5000,
          }),
        ).resolves.toMatchObject({
          attempts: 1,
          output: { status: 'passed' },
        });
        expect(() => reviewPackage.assertUnchanged()).not.toThrow();
        expect(reviewPackage.cleanup()).toEqual({ status: 'removed' });
        expect(existsSync(reviewPackage.root)).toBe(false);
      } finally {
        reviewPackage.cleanup();
        await session.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'retains real Review domains when the supervised runner leaves a descendant',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'review-runner-residue-workspace-'));
      const runnerRoot = mkdtempSync(join(tmpdir(), 'review-runner-residue-binary-'));
      temporaryRoots.push(workspace, runnerRoot);
      const runnerPath = join(runnerRoot, 'fake-codex.mjs');
      writeFileSync(
        runnerPath,
        [
          '#!/usr/bin/env node',
          'import {spawn} from "node:child_process";',
          'process.stdin.resume();',
          'process.stdin.on("end",()=>{',
          '  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],',
          '    {stdio:"ignore"});',
          '  child.unref();',
          '  child.once("spawn",()=>{',
          '    const answer={status:"passed",summary:"ok",requestDeepReview:false,',
          '      unverifiableReason:null,findings:[]};',
          '    process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"fixture"})+"\\n");',
          '    process.stdout.write(JSON.stringify({type:"item.completed",item:{',
          '      type:"agent_message",text:JSON.stringify(answer)}})+"\\n");',
          '    process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");',
          '  });',
          '});',
        ].join('\n'),
      );
      chmodSync(runnerPath, 0o755);
      vi.stubEnv('CODING_X_CODEX_BIN', runnerPath);
      await bootstrapWorkspace({ workspacePath: workspace });
      const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
      const session = createWorkspaceSession(lease);
      const reviewPackage = managedPackageFixture();
      let failure: unknown;
      try {
        await runSafeReviewAxis({
          session,
          runner: 'codex',
          model: 'review-model',
          runnerVersion: 'codex-test',
          axis: 'engineering',
          reviewPackage,
          timeoutMs: 5000,
        });
      } catch (error) {
        failure = error;
      } finally {
        await session.close();
      }
      expect(failure).toBeInstanceOf(RunnerPolicyViolation);
      expect((failure as Error).message).toMatch(/临时域已保留.*后代进程/u);
      const invocationPath = (failure as Error).message.match(/临时域已保留 ([^：]+)：/u)?.[1];
      expect(invocationPath).toBeTruthy();
      if (invocationPath) temporaryRoots.push(invocationPath);
      expect(reviewPackage.cleanup()).toMatchObject({ status: 'retained' });
      expect(existsSync(reviewPackage.root)).toBe(true);
      expect(invocationPath && existsSync(invocationPath)).toBe(true);
    },
    30_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'retains real Review domains after a supervised user interrupt',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'review-runner-interrupt-workspace-'));
      const runnerRoot = mkdtempSync(join(tmpdir(), 'review-runner-interrupt-binary-'));
      temporaryRoots.push(workspace, runnerRoot);
      const runnerPath = join(runnerRoot, 'fake-codex.mjs');
      const startedPath = join(runnerRoot, 'runner-started');
      writeFileSync(
        runnerPath,
        [
          '#!/usr/bin/env node',
          'import {writeFileSync} from "node:fs";',
          `writeFileSync(${JSON.stringify(startedPath)},"started\\n");`,
          'process.stdin.resume();',
          'setInterval(()=>{},1000);',
        ].join('\n'),
      );
      chmodSync(runnerPath, 0o755);
      vi.stubEnv('CODING_X_CODEX_BIN', runnerPath);
      await bootstrapWorkspace({ workspacePath: workspace });
      const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
      const session = createWorkspaceSession(lease);
      const reviewPackage = managedPackageFixture();
      const controller = new AbortController();
      let failure: unknown;
      const operation = runSafeReviewAxis({
        session,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex-test',
        axis: 'engineering',
        reviewPackage,
        timeoutMs: 5000,
        termination: { signal: controller.signal, reason: 'user-interrupt' },
      });
      try {
        await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 5000 });
      } catch (barrierError) {
        controller.abort();
        await operation.catch(() => undefined);
        await session.close();
        throw barrierError;
      }
      controller.abort();
      try {
        await operation;
      } catch (error) {
        failure = error;
      } finally {
        controller.abort();
        await session.close();
      }
      expect(failure).toBeInstanceOf(RunnerPolicyViolation);
      expect((failure as Error).message).toMatch(/临时域已保留.*被外部终止/u);
      const invocationPath = (failure as Error).message.match(/临时域已保留 ([^：]+)：/u)?.[1];
      expect(invocationPath).toBeTruthy();
      if (invocationPath) temporaryRoots.push(invocationPath);
      expect(reviewPackage.cleanup()).toMatchObject({ status: 'retained' });
      expect(existsSync(reviewPackage.root)).toBe(true);
      expect(invocationPath && existsSync(invocationPath)).toBe(true);
    },
    30_000,
  );

  it('contains no production child-process bypass in the TypeScript runner', () => {
    const source = readFileSync(fileURLToPath(new URL('./runner.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('execFileSync');
    expect(source).not.toMatch(/\bspawn\s*\(/u);
  });
});

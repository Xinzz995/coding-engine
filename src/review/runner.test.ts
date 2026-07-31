import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession, type WorkspaceSession } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import type { ReviewPackage } from './package.js';
import {
  codexReviewPermissionOverrides,
  parseCodexReviewJsonl,
  parseModelReviewOutput,
  probeRunnerIsolation,
  readRunnerVersion,
  runSafeReviewAxis,
} from './runner.js';

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

const fakeSession = {} as WorkspaceSession;

function managedResult(stdout: string) {
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
    inputPath,
    schemaPath,
    manifestPath,
    input,
    inputBytes: Buffer.byteLength(input),
    digest: 'sha256:fixture',
    cleanup: () => undefined,
    assertUnchanged: () => undefined,
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
      expect(() => parseCodexReviewJsonl(stdout)).toThrow(`禁用工具事件：${type}`);
    },
  );

  it('rejects an unrecognized item type so future capabilities fail closed', () => {
    const stdout = JSON.stringify({
      type: 'item.started',
      item: { type: 'future_capability' },
    });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('禁用工具事件：future_capability');
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
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('未知顶层事件：future.event');
  });

  it('rejects an item event whose item payload is missing', () => {
    const stdout = JSON.stringify({ type: 'item.started' });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('item.started 缺少 item');
  });

  it('rejects a passive top-level event that unexpectedly carries a tool item', () => {
    const stdout = JSON.stringify({
      type: 'turn.completed',
      item: { type: 'command_execution', command: 'whoami' },
    });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('turn.completed 含非预期 item');
  });
});

describe('codexReviewPermissionOverrides', () => {
  it('defaults to deny and grants read-only access only to the exact review package root', () => {
    const cwd = '/tmp/review package';
    expect(codexReviewPermissionOverrides(cwd)).toEqual([
      '-c',
      'default_permissions="coding_x_review"',
      '-c',
      `permissions.coding_x_review.filesystem={ ":minimal" = "read", ${JSON.stringify(resolve(cwd))} = "read" }`,
      '-c',
      'permissions.coding_x_review.network.enabled=true',
    ]);
  });
});

describe('managed Final Review runner execution', () => {
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
        managedProcess: managed,
      }),
    ).resolves.toBe('codex-cli 1.2.3');
  });

  it('preserves workspace safety failures from Runner version supervision', async () => {
    vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
    const failure = new WorkspaceSafetyError('isolated', 'process tree not empty');
    const managed: typeof runManagedWorkspaceProcess = async () => {
      throw failure;
    };

    await expect(
      readRunnerVersion({
        session: fakeSession,
        runner: 'codex',
        managedProcess: managed,
      }),
    ).rejects.toBe(failure);
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
      expect(readFileSync(config.promptPath, 'utf8')).toContain('Runner 隔离反向测试');
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
      runnerVersion: 'codex-test',
      timeoutMs: 1000,
      managedProcess: managed,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

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
      const reviewPackage = packageFixture(JSON.stringify({ diff: 'x'.repeat(128 * 1024) }));
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
      } finally {
        await session.close();
      }
    },
    20_000,
  );

  it('contains no production child-process bypass in the TypeScript runner', () => {
    const source = readFileSync(fileURLToPath(new URL('./runner.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('execFileSync');
    expect(source).not.toMatch(/\bspawn\s*\(/u);
  });
});

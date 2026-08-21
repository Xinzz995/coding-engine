import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QualityContract } from '../quality/contract.js';
import { consumeReadyIssueRunAuthority } from '../engine/issue-run-authority.js';
import {
  ISSUE_RUN_BOOTSTRAP_COMMENT_MARKER,
  ISSUE_RUN_COMMENT_MARKER,
  issueRunId,
  parseReadyIssue,
  runReadyIssue,
  type IssueRunCommandInvocation,
} from './issue-run.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function issue() {
  return {
    number: 42,
    state: 'open',
    title: '实现可信入口',
    body: [
      '## 本次目标',
      '完成一个可恢复入口。',
      '## 明确的非目标',
      '不自动合并。',
      '## 执行合同',
      '```json',
      JSON.stringify({
        schemaVersion: 1,
        storyAcceptance: {
          evidenceSource: 'validator',
          network: 'disabled',
          criteria: ['重复运行不创建第二个 PR', '结果写回 Issue'],
        },
        localChecks: {
          evidenceSource: 'engine',
          network: 'current-host',
          mode: 'scoped',
          checkIds: [],
        },
        remoteDelivery: {
          evidenceSource: 'github',
          network: 'github-actions',
          mode: 'scoped',
          checkIds: ['dependency-audit'],
          ruleset: 'required',
        },
        runMetrics: {
          evidenceSource: 'engine-clock',
          metrics: ['ready-to-trusted', 'active', 'waiting', 'continuations'],
        },
      }),
      '```',
      '## 风险说明',
      '只允许 owner 启动。',
    ].join('\n\n'),
    labels: [{ name: 'ready-for-agent' }],
    html_url: 'https://example.test/issues/42',
  };
}

function issueRunPreflight() {
  return {
    platform: 'macos' as const,
    remoteAuthorityReader: () => [] as string[],
    managedWorkflowReader: () => [] as string[],
    qualityContractReader: () => ({
      status: 'ready' as const,
      path: '/fixture/.coding-x/quality.json',
      digest: `sha256:${'a'.repeat(64)}`,
      contract: issue207QualityContract(),
    }),
  };
}

function issue207QualityContract(): QualityContract {
  return {
    checks: {
      test: { notApplicable: 'fixture' },
      build: { notApplicable: 'fixture' },
      static: { notApplicable: 'fixture' },
      security: {
        checks: [
          {
            id: 'dependency-audit',
            module: 'root',
            command: {
              executable: 'npm',
              args: ['audit'],
              cwd: '.',
              platforms: ['linux'],
              timeoutMs: 60_000,
            },
          },
        ],
      },
    },
    github: {
      jobs: [
        {
          id: 'linux',
          platform: 'linux',
          toolchains: [],
          setup: [],
          checkIds: ['dependency-audit'],
        },
      ],
      requiredChecks: ['quality-gate'],
    },
  } as unknown as QualityContract;
}

function events() {
  return [
    [
      {
        event: 'labeled',
        label: { name: 'ready-for-agent' },
        created_at: '2026-08-15T00:00:00.000Z',
      },
    ],
  ];
}

describe('ready Issue contract', () => {
  it('requires the versioned responsibility contract instead of guessing checks from legacy criteria', () => {
    const legacy = issue();
    legacy.body = legacy.body.replace(
      /## 执行合同[\s\S]+?(?=\n\n## 风险说明)/u,
      '## 验收标准\n\n- 重复运行不创建第二个 PR',
    );
    expect(() => parseReadyIssue(legacy, events())).toThrow('执行合同');

    const structured = issue();
    structured.body = [
      '## 本次目标',
      '完成一个可恢复入口。',
      '## 明确的非目标',
      '不自动合并。',
      '## 执行合同',
      '```json',
      JSON.stringify({
        schemaVersion: 1,
        storyAcceptance: {
          evidenceSource: 'validator',
          network: 'disabled',
          criteria: ['重复运行不创建第二个 PR', '结果写回 Issue'],
        },
        localChecks: {
          evidenceSource: 'engine',
          network: 'current-host',
          mode: 'scoped',
          checkIds: [],
        },
        remoteDelivery: {
          evidenceSource: 'github',
          network: 'github-actions',
          mode: 'scoped',
          checkIds: [],
          ruleset: 'required',
        },
        runMetrics: {
          evidenceSource: 'engine-clock',
          metrics: ['ready-to-trusted', 'active', 'waiting', 'continuations'],
        },
      }),
      '```',
      '## 风险说明',
      '只允许 owner 启动。',
    ].join('\n\n');

    const parsed = parseReadyIssue(structured, events());
    expect(parsed.acceptanceCriteria).toEqual([
      '重复运行不创建第二个 PR',
      '结果写回 Issue',
    ]);
    expect(
      (parsed as unknown as { executionContract: { localChecks: { mode: string } } })
        .executionContract.localChecks.mode,
    ).toBe('scoped');

    const changed = structuredClone(structured);
    changed.body = changed.body.replace('结果写回 Issue', '结果原位写回 Issue');
    const changedParsed = parseReadyIssue(changed, events());
    expect(changedParsed.executionContractDigest).not.toBe(parsed.executionContractDigest);
    expect(issueRunId('Xinzz995/example', changedParsed)).not.toBe(
      issueRunId('Xinzz995/example', parsed),
    );

    const duplicate = issue();
    const duplicatedContract = duplicate.body
      .split('## 执行合同\n\n')[1]
      .split('\n\n## 风险说明')[0];
    duplicate.body += `\n\n## 执行合同\n\n${duplicatedContract}`;
    expect(() => parseReadyIssue(duplicate, events())).toThrow('重复章节');

    const nested = issue();
    nested.body = nested.body.replace(
      '完成一个可恢复入口。',
      '完成一个可恢复入口。\n\n### 不可遗漏的子目标\n\n保留这段具体要求。',
    );
    expect(parseReadyIssue(nested, events()).goal).toContain(
      '### 不可遗漏的子目标\n\n保留这段具体要求。',
    );
  });

  it('requires the current ready label event and all executable sections', () => {
    const parsed = parseReadyIssue(issue(), events());
    expect(parsed.acceptanceCriteria).toEqual(['重复运行不创建第二个 PR', '结果写回 Issue']);
    expect(issueRunId('Xinzz995/example', parsed)).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const missing = issue();
    missing.body = '## 本次目标\nonly';
    expect(() => parseReadyIssue(missing, events())).toThrow('执行合同');

    const hidden = issue();
    hidden.body = hidden.body.replace('完成一个可恢复入口。', '<!-- 只有模板说明 -->');
    expect(() => parseReadyIssue(hidden, events())).toThrow('缺少可执行内容');

    const malformed = issue();
    malformed.body = malformed.body.replace('完成一个可恢复入口。', '<!--<!-->伪内容-->');
    expect(() => parseReadyIssue(malformed, events())).toThrow('畸形 HTML 注释');

    expect(() =>
      parseReadyIssue(issue(), [
        [
          ...events()[0],
          {
            event: 'unlabeled',
            label: { name: 'ready-for-agent' },
            created_at: '2026-08-15T00:01:00.000Z',
          },
        ],
      ]),
    ).toThrow('无法确认当前');
  });

  it('rejects the #207 Linux-only local audit on macOS before a branch, commit, or Agent starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue-run-preflight-test-'));
    roots.push(root);
    const incompatible = issue();
    incompatible.body = incompatible.body.replace(
      '"mode":"scoped","checkIds":[]',
      '"mode":"scoped","checkIds":["dependency-audit"]',
    );
    let servedIssue = incompatible;
    const calls: IssueRunCommandInvocation[] = [];
    let engineCalls = 0;
    const executor = (invocation: IssueRunCommandInvocation): string => {
      calls.push(invocation);
      const joined = invocation.args.join(' ');
      if (invocation.command === 'git') {
        if (invocation.args[0] === 'status') return '';
        if (joined === 'rev-parse HEAD') return 'a'.repeat(40);
      }
      if (joined.startsWith('repo view')) {
        return JSON.stringify({
          nameWithOwner: 'Xinzz995/example',
          defaultBranchRef: { name: 'main' },
        });
      }
      if (joined === 'api user') return JSON.stringify({ login: 'Xinzz995' });
      if (joined === 'api repos/Xinzz995/example/issues/42') return JSON.stringify(servedIssue);
      if (joined.includes('/events?')) return JSON.stringify(events());
      if (joined.includes('/comments?')) return JSON.stringify([[]]);
      if (invocation.args.includes('POST')) {
        return JSON.stringify({ id: 99, html_url: 'https://example.test/comment/99' });
      }
      if (invocation.args.includes('PATCH')) return '{}';
      throw new Error(`unexpected command: ${invocation.command} ${joined}`);
    };

    await expect(
      runReadyIssue({
        root,
        workspaceBase: '.workspace',
        issueNumber: 42,
        executor,
        platform: 'macos',
        qualityContractReader: () => ({
          status: 'ready',
          path: '/fixture/.coding-x/quality.json',
          digest: `sha256:${'a'.repeat(64)}`,
          contract: issue207QualityContract(),
        }),
        managedWorkflowReader: () => [],
        runEngine: async () => {
          engineCalls += 1;
          return { exitCode: 0, message: 'must not run' };
        },
      }),
    ).rejects.toThrow('dependency-audit 不支持当前平台 macos');
    expect(engineCalls).toBe(0);
    expect(calls.some((call) => ['switch', 'commit', 'push'].includes(call.args[0] ?? ''))).toBe(
      false,
    );

    const callsBeforeAuthorityCheck = calls.length;
    servedIssue = issue();
    await expect(
      runReadyIssue({
        root,
        workspaceBase: '.workspace',
        issueNumber: 42,
        executor,
        platform: 'macos',
        qualityContractReader: () => ({
          status: 'ready',
          path: '/fixture/.coding-x/quality.json',
          digest: `sha256:${'a'.repeat(64)}`,
          contract: issue207QualityContract(),
        }),
        remoteAuthorityReader: () => ['没有 coding-x 管理的默认分支 Ruleset'],
        managedWorkflowReader: () => [],
        runEngine: async () => {
          engineCalls += 1;
          return { exitCode: 0, message: 'must not run' };
        },
      }),
    ).rejects.toThrow('没有 coding-x 管理的默认分支 Ruleset');
    expect(engineCalls).toBe(0);
    expect(
      calls
        .slice(callsBeforeAuthorityCheck)
        .some((call) => ['switch', 'commit', 'push'].includes(call.args[0] ?? '')),
    ).toBe(false);

    const callsBeforeRunnerCheck = calls.length;
    await expect(
      runReadyIssue({
        ...issueRunPreflight(),
        runner: 'claude',
        root,
        workspaceBase: '.workspace',
        issueNumber: 42,
        executor,
        runEngine: async () => {
          engineCalls += 1;
          return { exitCode: 0, message: 'must not run' };
        },
      }),
    ).rejects.toThrow('当前只能使用 codex');
    expect(engineCalls).toBe(0);
    expect(
      calls
        .slice(callsBeforeRunnerCheck)
        .some((call) => ['switch', 'commit', 'push'].includes(call.args[0] ?? '')),
    ).toBe(false);
  });

  it('continues one branch and one PR, then records ready-to-trusted total time', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue-run-test-'));
    roots.push(root);
    let branch = 'main';
    let head = 'a'.repeat(40);
    let remoteHead: string | null = null;
    let prCreated = false;
    let draft = true;
    let prState: 'OPEN' | 'CLOSED' = 'OPEN';
    let commentBody: string | null = null;
    let createPrCalls = 0;
    let failCreatePr = true;
    let failPush = false;
    let currentIssue = issue();
    let prTitle = currentIssue.title;
    let prBody = '';
    let mergeBaseOverride: string | null = null;
    const calls: IssueRunCommandInvocation[] = [];
    const executor = (invocation: IssueRunCommandInvocation): string => {
      calls.push(invocation);
      const args = invocation.args;
      const joined = args.join(' ');
      if (invocation.command === 'git') {
        if (args[0] === 'status') return '';
        if (joined === 'branch --show-current') return branch;
        if (joined === 'branch --list codex/issue-42') {
          return branch === 'codex/issue-42' ? '  codex/issue-42' : '';
        }
        if (args[0] === 'ls-remote') {
          return remoteHead ? `${remoteHead}\trefs/heads/codex/issue-42` : '';
        }
        if (args[0] === 'fetch') return '';
        if (args[0] === 'merge-base') return mergeBaseOverride ?? remoteHead ?? head;
        if (joined === 'rev-parse HEAD') return head;
        if (joined === 'rev-parse refs/remotes/origin/main') return 'a'.repeat(40);
        if (joined === 'switch -c codex/issue-42') {
          branch = 'codex/issue-42';
          return '';
        }
        if (args[0] === 'switch') {
          branch = String(args.at(-1));
          return '';
        }
        if (args[0] === 'add') return '';
        if (args[0] === 'ls-files') return 'docs/prds/prd-issue-42.md';
        if (args[0] === 'commit') {
          head = 'b'.repeat(40);
          return '[codex/issue-42 fixture]';
        }
        if (args[0] === 'push') {
          if (failPush) throw new Error('simulated push failure');
          remoteHead = head;
          return '';
        }
      }
      if (joined.startsWith('repo view')) {
        return JSON.stringify({
          nameWithOwner: 'Xinzz995/example',
          defaultBranchRef: { name: 'main' },
        });
      }
      if (joined === 'api user') return JSON.stringify({ login: 'Xinzz995' });
      if (joined === 'api repos/Xinzz995/example/issues/42') return JSON.stringify(currentIssue);
      if (joined.includes('/events?')) return JSON.stringify(events());
      if (joined.startsWith('pr list')) {
        return JSON.stringify(
          prCreated
            ? [
                {
                  number: 7,
                  state: prState,
                  isDraft: draft,
                  headRefOid: remoteHead,
                  baseRefName: 'main',
                  url: 'https://example.test/pr/7',
                  title: prTitle,
                  body: prBody,
                },
              ]
            : [],
        );
      }
      if (joined.startsWith('pr create')) {
        createPrCalls += 1;
        if (failCreatePr) throw new Error('simulated PR creation failure');
        prTitle = String(args[args.indexOf('--title') + 1]);
        prBody = String(args[args.indexOf('--body') + 1]);
        prCreated = true;
        return 'https://example.test/pr/7';
      }
      if (joined.startsWith('pr ready')) {
        draft = false;
        return '';
      }
      if (joined.includes('/comments?')) {
        return JSON.stringify(
          commentBody === null
            ? [[]]
            : [
                [
                  {
                    id: 99,
                    body: commentBody,
                    html_url: 'https://example.test/comment/99',
                    user: { login: 'Xinzz995' },
                    author_association: 'OWNER',
                  },
                ],
              ],
        );
      }
      if (args.includes('POST')) {
        commentBody = String(args.find((arg) => arg.startsWith('body='))).slice(5);
        return JSON.stringify({ id: 99, html_url: 'https://example.test/comment/99' });
      }
      if (args.includes('PATCH')) {
        commentBody = String(args.find((arg) => arg.startsWith('body='))).slice(5);
        return '{}';
      }
      throw new Error(`unexpected command: ${invocation.command} ${joined}`);
    };
    const times = [
      new Date('2026-08-15T00:00:10.000Z'),
      new Date('2026-08-15T00:00:20.000Z'),
      new Date('2026-08-15T00:01:00.000Z'),
      new Date('2026-08-15T00:03:00.000Z'),
      new Date('2026-08-15T00:10:00.000Z'),
      new Date('2026-08-15T00:11:00.000Z'),
      new Date('2026-08-15T00:12:00.000Z'),
      new Date('2026-08-15T00:13:00.000Z'),
      new Date('2026-08-15T00:14:00.000Z'),
      new Date('2026-08-15T00:15:00.000Z'),
      new Date('2026-08-15T00:16:00.000Z'),
      new Date('2026-08-15T00:17:00.000Z'),
      new Date('2026-08-15T00:18:00.000Z'),
      new Date('2026-08-15T00:19:00.000Z'),
      new Date('2026-08-15T00:20:00.000Z'),
      new Date('2026-08-15T00:21:00.000Z'),
      new Date('2026-08-15T00:22:00.000Z'),
      new Date('2026-08-15T00:23:00.000Z'),
      new Date('2026-08-15T00:24:00.000Z'),
      new Date('2026-08-15T00:25:00.000Z'),
      new Date('2026-08-15T00:26:00.000Z'),
      new Date('2026-08-15T00:27:00.000Z'),
    ];
    let remoteAuthorityReads = 0;
    const preflight = {
      ...issueRunPreflight(),
      remoteAuthorityReader: () => {
        remoteAuthorityReads += 1;
        return [] as string[];
      },
    };
    await expect(
      runReadyIssue({
        ...preflight,
        root,
        workspaceBase: '.workspace',
        issueNumber: 42,
        executor,
        now: () => times.shift()!,
        initializeWorkspace: async () => undefined,
        runEngine: async () => {
          throw new Error('engine must not run before PR exists');
        },
      }),
    ).rejects.toThrow('simulated PR creation failure');
    expect(commentBody).toContain(ISSUE_RUN_BOOTSTRAP_COMMENT_MARKER);
    expect(commentBody).toContain('Issue 入口准备失败');

    failCreatePr = false;
    const first = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async ({ authority }) => {
        expect(consumeReadyIssueRunAuthority(authority)).toMatchObject({
          repository: 'Xinzz995/example',
          issueNumber: 42,
          branch: 'codex/issue-42',
          pullRequest: 7,
        });
        head = 'c'.repeat(40);
        return { exitCode: 6, message: '等待远端' };
      },
    });
    expect(first.phase).toBe('waiting-remote');
    expect(remoteAuthorityReads).toBe(3);
    expect(createPrCalls).toBe(2);
    expect(commentBody).toContain(ISSUE_RUN_COMMENT_MARKER);
    const sourcePrd = readFileSync(join(root, 'docs/prds/prd-issue-42.md'), 'utf8');
    expect(sourcePrd).toContain('Issue-Execution-Contract-Digest: sha256:');
    expect(sourcePrd).toContain('Issue-Remote-Check-Mode: scoped');
    expect(sourcePrd).toContain('Issue-Remote-Check-IDs: dependency-audit');
    expect(sourcePrd).toContain('#### Execution Contract');

    let refreshCalls = 0;
    const second = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      refreshEngine: async () => {
        refreshCalls += 1;
        if (refreshCalls === 2) return null;
        return {
          exitCode: 0,
          message: 'refreshed ready',
          evidence: {
            reviewBindingDigest: `sha256:${'f'.repeat(64)}`,
            reusedFinalReview: true,
            remoteRefreshDurationMs: 20,
          },
        };
      },
      runEngine: async () => {
        throw new Error('full engine must not run after a reusable Review refresh');
      },
    });
    expect(second.phase).toBe('waiting-remote');
    expect(second.state).toMatchObject({
      continuations: 3,
      activeMs: 190_000,
      evidence: { reusedFinalReview: true, remoteRefreshDurationMs: 20 },
    });
    expect(refreshCalls).toBe(2);
    expect(draft).toBe(true);

    refreshCalls = 0;
    const third = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      refreshEngine: async () => {
        refreshCalls += 1;
        return {
          exitCode: 0,
          message: 'refreshed ready',
          evidence: {
            reviewBindingDigest: `sha256:${'f'.repeat(64)}`,
            reusedFinalReview: true,
            remoteRefreshDurationMs: refreshCalls === 1 ? 20 : 22,
          },
        };
      },
      runEngine: async () => {
        throw new Error('full engine must not run after a reusable Review refresh');
      },
    });
    expect(third.phase).toBe('trusted');
    expect(third.state).toMatchObject({
      continuations: 4,
      activeMs: 250_000,
      readyToTrustedMs: 780_000,
      waitingMs: 530_000,
      evidence: { reusedFinalReview: true, remoteRefreshDurationMs: 42 },
    });
    expect(refreshCalls).toBe(2);
    expect(createPrCalls).toBe(2);
    expect(draft).toBe(false);
    expect(calls.some((call) => call.args[0] === 'merge')).toBe(false);

    failPush = true;
    const failedCloseout = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async () => {
        head = 'd'.repeat(40);
        return { exitCode: 6, message: '等待远端' };
      },
    });
    expect(failedCloseout).toMatchObject({ exitCode: 2, phase: 'failed' });
    expect(failedCloseout.state.message).toContain('simulated push failure');
    expect(commentBody).toContain('Issue 运行收口失败');
    expect(createPrCalls).toBe(2);

    failPush = false;
    const failedPreparation = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => {
        throw new Error('simulated workspace failure');
      },
      runEngine: async () => {
        throw new Error('engine must not run');
      },
    });
    expect(failedPreparation).toMatchObject({ exitCode: 2, phase: 'failed' });
    expect(failedPreparation.state.message).toContain('Issue 运行准备失败');
    expect(failedPreparation.state.message).toContain('simulated workspace failure');

    remoteHead = head;
    const closedDuringEngine = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async () => {
        prState = 'CLOSED';
        return { exitCode: 0, message: 'stale ready' };
      },
    });
    expect(closedDuringEngine).toMatchObject({ exitCode: 2, phase: 'failed' });
    expect(closedDuringEngine.state.message).toContain('PR 已关闭');

    prState = 'OPEN';
    currentIssue = issue();
    const changedDuringEngine = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async () => {
        currentIssue.body = currentIssue.body.replace('结果写回 Issue', '结果改写到别处');
        return { exitCode: 0, message: 'stale Issue identity' };
      },
    });
    expect(changedDuringEngine).toMatchObject({ exitCode: 2, phase: 'failed' });
    expect(changedDuringEngine.state.message).toContain('Issue 内容或标签事件已变化');

    currentIssue = issue();
    remoteHead = 'e'.repeat(40);
    mergeBaseOverride = head;
    let staleBranchEngineCalls = 0;
    const staleBranch = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async () => {
        staleBranchEngineCalls += 1;
        return { exitCode: 0, message: 'must not run from stale branch' };
      },
    });
    expect(staleBranch).toMatchObject({ exitCode: 2, phase: 'failed' });
    expect(staleBranch.state.message).toContain('本地 Issue 分支落后于或分叉于 PR 最新提交');
    expect(staleBranchEngineCalls).toBe(0);
    remoteHead = head;
    mergeBaseOverride = null;

    const sourceChangedDuringEngine = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async () => {
        const sourcePath = join(root, 'docs/prds/prd-issue-42.md');
        writeFileSync(
          sourcePath,
          readFileSync(sourcePath, 'utf8').replace('完成一个可恢复入口。', '弱化后的目标。'),
        );
        return { exitCode: 0, message: 'stale source' };
      },
    });
    expect(sourceChangedDuringEngine).toMatchObject({ exitCode: 2, phase: 'failed' });
    expect(sourceChangedDuringEngine.state.message).toContain('源 PRD 正文已偏离');

    const sourcePath = join(root, 'docs/prds/prd-issue-42.md');
    writeFileSync(sourcePath, sourcePrd);
    const prChangedDuringEngine = await runReadyIssue({
      ...preflight,
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async () => {
        prBody = prBody.replace('完成一个可恢复入口。', '弱化后的 PR 目标。');
        return { exitCode: 0, message: 'stale PR intent' };
      },
    });
    expect(prChangedDuringEngine).toMatchObject({ exitCode: 2, phase: 'failed' });
    expect(prChangedDuringEngine.state.message).toContain('PR 的“本次目标”已偏离');
  });
});

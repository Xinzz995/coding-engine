import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
      '## 验收标准',
      '- [ ] 重复运行不创建第二个 PR',
      '- [ ] 结果写回 Issue',
      '## 风险说明',
      '只允许 owner 启动。',
    ].join('\n\n'),
    labels: [{ name: 'ready-for-agent' }],
    html_url: 'https://example.test/issues/42',
  };
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
  it('requires the current ready label event and all executable sections', () => {
    const parsed = parseReadyIssue(issue(), events());
    expect(parsed.acceptanceCriteria).toEqual(['重复运行不创建第二个 PR', '结果写回 Issue']);
    expect(issueRunId('Xinzz995/example', parsed)).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const missing = issue();
    missing.body = '## 本次目标\nonly';
    expect(() => parseReadyIssue(missing, events())).toThrow('缺少可执行内容');

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
      if (joined === 'api repos/Xinzz995/example/issues/42') return JSON.stringify(issue());
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
                },
              ]
            : [],
        );
      }
      if (joined.startsWith('pr create')) {
        createPrCalls += 1;
        if (failCreatePr) throw new Error('simulated PR creation failure');
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
    ];
    await expect(
      runReadyIssue({
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
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async () => {
        head = 'c'.repeat(40);
        return { exitCode: 6, message: '等待远端' };
      },
    });
    expect(first.phase).toBe('waiting-remote');
    expect(createPrCalls).toBe(2);
    expect(commentBody).toContain(ISSUE_RUN_COMMENT_MARKER);

    const second = await runReadyIssue({
      root,
      workspaceBase: '.workspace',
      issueNumber: 42,
      executor,
      now: () => times.shift()!,
      initializeWorkspace: async () => undefined,
      runEngine: async () => ({
        exitCode: 0,
        message: 'ready',
        evidence: { reviewBindingDigest: `sha256:${'f'.repeat(64)}` },
      }),
    });
    expect(second.phase).toBe('trusted');
    expect(second.state).toMatchObject({
      continuations: 3,
      activeMs: 190_000,
      readyToTrustedMs: 660_000,
      waitingMs: 470_000,
    });
    expect(createPrCalls).toBe(2);
    expect(draft).toBe(false);
    expect(calls.some((call) => call.args[0] === 'merge')).toBe(false);

    failPush = true;
    const failedCloseout = await runReadyIssue({
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
  });
});

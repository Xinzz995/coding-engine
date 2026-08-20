import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseQualityContract, type QualityContract } from '../quality/contract.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import { createIdentityProbe } from '../workspace-safety/identity.js';
import { createWorkspaceSession, type WorkspaceSession } from '../workspace-safety/session.js';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-safety/workspace-authority-test-seam.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-safety/workspace-authority-test-seam.js';
import {
  evaluateReviewPreflightSnapshot,
  parseReviewPreflightSnapshotResult,
  runReviewPreflightSnapshot,
  type ReviewPreflightSnapshotResult,
} from './preflight-snapshot.js';
import {
  revalidateReviewContextFromPreflight,
  runManagedStatusPreflightControlled,
} from './managed-status.js';
import { runUnmanagedReviewPreflight } from './unmanaged-preflight.js';

const roots: string[] = [];
const SHA = (character: string): string => character.repeat(40);
const DIGEST = (character: string): string => `sha256:${character.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function contract(): QualityContract {
  const parsed = parseQualityContract(
    JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', '.coding-x', 'quality.json'), 'utf8'),
    ),
  );
  if (parsed.status !== 'ready') throw new Error('fixture quality contract is invalid');
  return parsed.contract;
}

function snapshotFixture(): ReviewPreflightSnapshotResult {
  const quality = contract();
  return {
    schemaVersion: 1,
    requestDigest: DIGEST('a'),
    childProcessCount: 20,
    branch: 'feature/snapshot',
    repositoryJson: JSON.stringify({
      nameWithOwner: quality.repository.fullName,
      defaultBranchRef: { name: quality.repository.defaultBranch },
      isPrivate: false,
    }),
    pullRequestsJson: JSON.stringify([
      {
        number: 1,
        state: 'open',
        head: { sha: SHA('b'), ref: 'feature/snapshot' },
        base: { sha: SHA('a'), ref: quality.repository.defaultBranch },
        html_url: 'https://github.com/Xinzz995/coding-engine/pull/1',
        title: 'fix: snapshot',
        body: [
          '## 本次目标',
          '目标',
          '## 明确的非目标',
          '非目标',
          '## Spec 与验收标准来源',
          'PR',
          '## 验证方式',
          '测试',
          '## 风险说明',
          '风险',
        ].join('\n\n'),
        labels: [],
      },
    ]),
    baseSha: SHA('a'),
    headSha: SHA('b'),
    baseIsAncestor: true,
    baseContractBase64: Buffer.from(JSON.stringify(quality)).toString('base64'),
    statusBase64: '',
    changedFiles: ['src/example.ts'],
    diffBase64: Buffer.from('diff --git a/src/example.ts b/src/example.ts\n').toString('base64'),
    files: [
      {
        path: 'src/example.ts',
        baseMode: '100644',
        headMode: '100644',
        baseBase64: Buffer.from('export const value = 1;\n').toString('base64'),
        headBase64: Buffer.from('export const value = 2;\n').toString('base64'),
      },
    ],
    headPaths: ['src/example.ts'],
    specs: [],
    engineeringStandards: quality.sources.engineeringStandards.map((path) => ({
      path,
      contentBase64: Buffer.from(`${path}\n`).toString('base64'),
    })),
    historyBase64: Buffer.from(`${SHA('b')}\tfix: snapshot\n`).toString('base64'),
  };
}

function fakeGh(path: string, options: { baseSha: string; headSha: string; body: string }): string {
  const repository = JSON.stringify({
    nameWithOwner: 'Xinzz995/coding-engine',
    defaultBranchRef: { name: 'main' },
    isPrivate: false,
  });
  const pullRequests = JSON.stringify([
    {
      number: 292,
      state: 'open',
      head: { sha: options.headSha, ref: 'feature/snapshot' },
      base: { sha: options.baseSha, ref: 'main' },
      html_url: 'https://github.com/Xinzz995/coding-engine/pull/292',
      title: 'perf: snapshot',
      body: options.body,
      labels: [{ name: 'quality-policy-approved' }],
    },
  ]);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'view') process.stdout.write(${JSON.stringify(repository)});
else if (args[0] === 'api' && args.at(-1).includes('/pulls?')) process.stdout.write(${JSON.stringify(pullRequests)});
else process.exit(9);
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return realpathSync(path);
}

describe('managed Review preflight snapshot', () => {
  it('uses the snapshot once and falls back only while the session remains open', async () => {
    const currentContract = contract();
    const options = {
      session: { state: 'open' } as WorkspaceSession,
      root: '/project',
      workspace: '/workspace',
      currentContract,
      observation: {} as never,
    };
    const preflightSnapshot = vi.fn(async () => ({
      status: 'config-error' as const,
      message: 'snapshot-result',
    }));
    const legacyPreflight = vi.fn(async () => ({
      status: 'config-error' as const,
      message: 'legacy-result',
    }));

    await expect(
      runManagedStatusPreflightControlled(options, { preflightSnapshot, legacyPreflight }),
    ).resolves.toMatchObject({ message: 'snapshot-result' });
    expect(preflightSnapshot).toHaveBeenCalledOnce();
    expect(legacyPreflight).not.toHaveBeenCalled();

    preflightSnapshot.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await expect(
      runManagedStatusPreflightControlled(options, { preflightSnapshot, legacyPreflight }),
    ).resolves.toMatchObject({ message: 'legacy-result' });
    expect(legacyPreflight).toHaveBeenCalledOnce();

    preflightSnapshot.mockRejectedValueOnce(new Error('isolated snapshot'));
    await expect(
      runManagedStatusPreflightControlled(
        { ...options, session: { state: 'isolated' } as WorkspaceSession },
        { preflightSnapshot, legacyPreflight },
      ),
    ).rejects.toThrow(/isolated snapshot/u);
    expect(legacyPreflight).toHaveBeenCalledOnce();
  });

  it('retries a transient GitHub read inside the snapshot before exposing failure', async () => {
    const project = temporary('coding-x-preflight-retry-project-');
    const workspace = temporary('coding-x-preflight-retry-workspace-');
    const result = (detail: string) => ({
      verdict: 'root-failed' as const,
      exitCode: 1,
      signal: null,
      timedOut: false,
      processTreeNotEmpty: false,
      terminationReason: null,
      durationMs: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(detail),
      leftover: false,
    });
    const managedProcess = vi
      .fn()
      .mockResolvedValueOnce(result('github-repository: unexpected EOF'))
      .mockResolvedValueOnce(result('github-repository: authentication failed'));

    await expect(
      runReviewPreflightSnapshot({
        session: {} as WorkspaceSession,
        root: project,
        workspace,
        currentContract: contract(),
        executablesForTests: { git: '/usr/bin/git', gh: '/usr/bin/gh' },
        managedProcess,
      }),
    ).rejects.toThrow(/authentication failed/u);
    expect(managedProcess).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed or request-mismatched snapshot output', () => {
    expect(() => parseReviewPreflightSnapshotResult(Buffer.from('{}'), DIGEST('a'))).toThrow(
      /未知或缺失字段/u,
    );
    const fixture = snapshotFixture();
    expect(() =>
      parseReviewPreflightSnapshotResult(Buffer.from(JSON.stringify(fixture)), DIGEST('f')),
    ).toThrow(/request 摘要/u);
  });

  it('fails closed when the returned file or standards path set diverges', () => {
    const fixture = snapshotFixture();
    const options = {
      root: '/project',
      workspace: '/workspace',
      currentContract: contract(),
    };
    expect(
      evaluateReviewPreflightSnapshot(
        { ...fixture, files: [{ ...fixture.files[0], path: 'src/other.ts' }] },
        options,
      ),
    ).toMatchObject({ status: 'unverifiable', message: expect.stringContaining('逐文件集合') });
    expect(
      evaluateReviewPreflightSnapshot(
        { ...fixture, engineeringStandards: fixture.engineeringStandards.slice(1) },
        options,
      ),
    ).toMatchObject({ status: 'unverifiable', message: expect.stringContaining('工程规范路径') });
  });

  it('preserves binary, LFS, submodule, and dirty-worktree rejection semantics', () => {
    const fixture = snapshotFixture();
    const options = {
      root: '/project',
      workspace: '/workspace',
      currentContract: contract(),
    };
    expect(
      evaluateReviewPreflightSnapshot(
        {
          ...fixture,
          diffBase64: Buffer.from('GIT binary patch\n').toString('base64'),
        },
        options,
      ),
    ).toMatchObject({ status: 'unverifiable', message: expect.stringContaining('二进制') });
    expect(
      evaluateReviewPreflightSnapshot(
        {
          ...fixture,
          files: [
            {
              ...fixture.files[0],
              headBase64: Buffer.from(
                'version https://git-lfs.github.com/spec/v1\noid sha256:abc\n',
              ).toString('base64'),
            },
          ],
        },
        options,
      ),
    ).toMatchObject({ status: 'unverifiable', message: expect.stringContaining('Git LFS') });
    expect(
      evaluateReviewPreflightSnapshot(
        {
          ...fixture,
          files: [
            {
              ...fixture.files[0],
              headMode: '160000',
              headBase64: null,
            },
          ],
        },
        options,
      ),
    ).toMatchObject({ status: 'unverifiable', message: expect.stringContaining('子模块') });
    expect(
      evaluateReviewPreflightSnapshot(
        {
          ...fixture,
          statusBase64: Buffer.from('?? unexpected.txt\0').toString('base64'),
        },
        options,
      ),
    ).toMatchObject({ status: 'config-error', message: expect.stringContaining('未允许改动') });
  });

  it('uses a fresh complete snapshot to reject PR, label, head, and unavailable revalidation', () => {
    const fixture = snapshotFixture();
    const options = {
      root: '/project',
      workspace: '/workspace',
      currentContract: contract(),
    };
    const initial = evaluateReviewPreflightSnapshot(fixture, options);
    if (initial.status !== 'ready') throw new Error(initial.message);
    expect(revalidateReviewContextFromPreflight(initial.context, initial)).toEqual({ ok: true });
    expect(
      revalidateReviewContextFromPreflight(initial.context, {
        status: 'ready',
        context: {
          ...initial.context,
          pullRequest: { ...initial.context.pullRequest, labels: ['changed'] },
        },
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('标签') });
    expect(
      revalidateReviewContextFromPreflight(initial.context, {
        status: 'ready',
        context: { ...initial.context, headSha: SHA('c') },
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('HEAD') });
    expect(
      revalidateReviewContextFromPreflight(initial.context, {
        status: 'remote-not-ready',
        message: 'PR closed',
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('PR closed') });
  });

  it.runIf(process.platform !== 'win32')(
    'collects a real complete context through exactly one managed outer operation',
    async () => {
      const project = temporary('coding-x-preflight-project-');
      const bare = temporary('coding-x-preflight-origin-');
      const safety = temporary('coding-x-preflight-safety-');
      const executableRoot = temporary('coding-x-preflight-bin-');
      const quality = contract();
      git(project, ['init', '-b', 'main']);
      git(project, ['config', 'user.email', 'fixture@example.com']);
      git(project, ['config', 'user.name', 'Fixture']);
      cpSync(
        join(import.meta.dirname, '..', '..', '.coding-x', 'quality.json'),
        join(project, '.coding-x', 'quality.json'),
        { recursive: true },
      );
      for (const path of quality.sources.engineeringStandards)
        write(join(project, path), `${path}\n`);
      write(join(project, 'src', 'example.ts'), 'export const value = 1;\n');
      git(project, ['add', '.']);
      git(project, ['commit', '-m', 'base']);
      git(bare, ['init', '--bare']);
      git(project, ['remote', 'add', 'origin', bare]);
      git(project, ['push', '-u', 'origin', 'main']);
      const baseSha = git(project, ['rev-parse', 'HEAD']);
      git(project, ['switch', '-c', 'feature/snapshot']);
      write(join(project, 'src', 'example.ts'), 'export const value = 2;\n');
      write(join(project, 'docs', 'specs', 'snapshot.md'), '# Snapshot\n');
      git(project, ['add', '.']);
      git(project, ['commit', '-m', 'change']);
      git(project, ['push', '-u', 'origin', 'feature/snapshot']);
      const headSha = git(project, ['rev-parse', 'HEAD']);
      const body = [
        '## 本次目标',
        '批量快照',
        '## 明确的非目标',
        '不缓存',
        '## Spec 与验收标准来源',
        'docs/specs/snapshot.md',
        '## 验证方式',
        '测试',
        '## 风险说明',
        '失败关闭',
      ].join('\n\n');
      const gh = fakeGh(join(executableRoot, 'gh-fixture'), { baseSha, headSha, body });
      const gitExecutable = realpathSync(
        execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
      );
      const identity = createIdentityProbe().current();
      await bootstrapWorkspace({
        workspacePath: safety,
        identity,
        ownerId: '00000000-0000-4000-8000-000000000001',
      });
      const lease = await acquireWorkspaceLease({
        workspacePath: safety,
        identity,
        ownerId: '00000000-0000-4000-8000-000000000010',
        command: 'report',
      });
      const session = createWorkspaceSession(lease);
      let calls = 0;
      const result = await runReviewPreflightSnapshot({
        session,
        root: project,
        workspace: safety,
        currentContract: quality,
        executablesForTests: { git: gitExecutable, gh },
        managedProcess: async (...args) => {
          calls += 1;
          return await runManagedWorkspaceProcess(...args);
        },
      });

      expect(calls).toBe(1);
      const expected = runUnmanagedReviewPreflight({
        root: project,
        workspace: safety,
        currentContract: quality,
        client: {
          discoverRepository: () => ({
            fullName: quality.repository.fullName,
            defaultBranch: quality.repository.defaultBranch,
            isPrivate: false,
          }),
          findOpenPullRequest: () => ({
            number: 292,
            headSha,
            baseSha,
            baseBranch: 'main',
            url: 'https://github.com/Xinzz995/coding-engine/pull/292',
            title: 'perf: snapshot',
            body,
            labels: ['quality-policy-approved'],
          }),
        } as unknown as GitHubQualityClient,
      });
      expect(result).toEqual(expected);
      expect(result).toMatchObject({
        status: 'ready',
        context: {
          branch: 'feature/snapshot',
          baseSha,
          headSha,
          changedFiles: ['docs/specs/snapshot.md', 'src/example.ts'],
          pullRequest: { number: 292, labels: ['quality-policy-approved'] },
          specs: [{ path: 'docs/specs/snapshot.md', content: '# Snapshot\n' }],
        },
      });
      await session.close();
    },
    30_000,
  );
});

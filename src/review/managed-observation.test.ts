import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession } from '../workspace-safety/session.js';
import {
  createManagedReviewObservation,
  resolveReviewInfrastructureExecutable,
} from './managed-observation.js';

const roots: string[] = [];

async function fixture(command: 'run' | 'review-decision') {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-review-observation-'));
  roots.push(root);
  const workspace = join(root, '.workspace');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  await bootstrapWorkspace({ workspacePath: workspace });
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, command });
  const session = createWorkspaceSession(lease);
  return { root, workspace, bin, session };
}

function wrapper(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function countedScript(counter: string, body: string): string {
  const path = JSON.stringify(counter);
  return [
    'count=0',
    `if [ -f ${path} ]; then IFS= read -r count < ${path}; fi`,
    'count=$((count + 1))',
    `printf '%s\\n' "$count" > ${path}`,
    body,
  ].join('\n');
}

function trustedBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'coding-x-review-observation-host-'));
  roots.push(bin);
  wrapper(join(bin, 'git'), 'exit 0');
  wrapper(join(bin, 'gh'), 'exit 0');
  return bin;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')(
  'managed Review observations',
  () => {
    it('never selects a project-owned git wrapper from npx-style PATH', async () => {
      const ctx = await fixture('run');
      const marker = join(ctx.workspace, 'git-wrapper-wrote.txt');
      wrapper(
        join(ctx.bin, 'git'),
        [
          `printf 'changed' > ${JSON.stringify(marker)}`,
          "printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'",
        ].join('\n'),
      );
      const previousPath = process.env.PATH;
      process.env.PATH = `${ctx.bin}${delimiter}${previousPath ?? ''}`;
      try {
        const executable = resolveReviewInfrastructureExecutable('git', ctx.root);
        expect(executable).not.toBe(join(ctx.bin, 'git'));
      } finally {
        process.env.PATH = previousPath;
      }
      expect(existsSync(marker)).toBe(false);
      expect(ctx.session.state).toBe('open');
      await ctx.session.close();
    }, 20_000);

    it('fails closed when a project-owned gh wrapper is the only candidate', async () => {
      const ctx = await fixture('review-decision');
      const marker = join(ctx.workspace, 'gh-wrapper-wrote.txt');
      wrapper(
        join(ctx.bin, 'gh'),
        [
          `printf 'changed' > ${JSON.stringify(marker)}`,
          'printf \'%s\\n\' \'{"nameWithOwner":"owner/repo","defaultBranchRef":{"name":"main"},"isPrivate":false}\'',
        ].join('\n'),
      );
      const previousPath = process.env.PATH;
      process.env.PATH = ctx.bin;
      try {
        expect(() => resolveReviewInfrastructureExecutable('gh', ctx.root)).toThrow(
          '项目目录之外的可信 gh',
        );
      } finally {
        process.env.PATH = previousPath;
      }
      expect(existsSync(marker)).toBe(false);
      expect(ctx.session.state).toBe('open');
      await ctx.session.close();
    }, 20_000);

    it('retries a naturally failed gh read through the real managed coordinator', async () => {
      const ctx = await fixture('run');
      const bin = trustedBin();
      const counter = join(bin, 'gh-retry.count');
      wrapper(
        join(bin, 'gh'),
        countedScript(
          counter,
          [
            'if [ "$count" -eq 1 ]; then',
            "  printf '%s\\n' 'Post \"https://api.github.com/graphql\": EOF' >&2",
            '  exit 1',
            'fi',
            'printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","defaultBranchRef":{"name":"main"},"isPrivate":false}\'',
          ].join('\n'),
        ),
      );
      const previousPath = process.env.PATH;
      process.env.PATH = bin;
      try {
        const observation = createManagedReviewObservation({
          session: ctx.session,
          root: ctx.root,
        });
        await expect(observation.github.discoverRepository(ctx.root)).resolves.toEqual({
          fullName: 'owner/repository',
          defaultBranch: 'main',
          isPrivate: false,
        });
      } finally {
        process.env.PATH = previousPath;
        await ctx.session.close();
      }
      expect(readFileSync(counter, 'utf8').trim()).toBe('2');
    }, 20_000);

    it('does not retry a failed git read', async () => {
      const ctx = await fixture('run');
      const bin = trustedBin();
      const counter = join(bin, 'git-failure.count');
      wrapper(
        join(bin, 'git'),
        countedScript(counter, "printf '%s\\n' 'fatal: temporary failure' >&2\nexit 1"),
      );
      const previousPath = process.env.PATH;
      process.env.PATH = bin;
      try {
        const observation = createManagedReviewObservation({
          session: ctx.session,
          root: ctx.root,
        });
        await expect(observation.git(['status'])).rejects.toThrow('git 只读观察失败');
      } finally {
        process.env.PATH = previousPath;
        await ctx.session.close();
      }
      expect(readFileSync(counter, 'utf8').trim()).toBe('1');
    }, 20_000);

    it('does not retry a permanent gh failure', async () => {
      const ctx = await fixture('run');
      const bin = trustedBin();
      const counter = join(bin, 'gh-permanent.count');
      wrapper(
        join(bin, 'gh'),
        countedScript(counter, "printf '%s\\n' 'gh: HTTP 401: Bad credentials' >&2\nexit 1"),
      );
      const previousPath = process.env.PATH;
      process.env.PATH = bin;
      try {
        const observation = createManagedReviewObservation({
          session: ctx.session,
          root: ctx.root,
        });
        await expect(observation.github.discoverRepository(ctx.root)).rejects.toMatchObject({
          kind: 'unauthenticated',
          attempts: 1,
        });
      } finally {
        process.env.PATH = previousPath;
        await ctx.session.close();
      }
      expect(readFileSync(counter, 'utf8').trim()).toBe('1');
    }, 20_000);

    it('does not retry invalid GitHub JSON', async () => {
      const ctx = await fixture('run');
      const bin = trustedBin();
      const counter = join(bin, 'gh-invalid-json.count');
      wrapper(join(bin, 'gh'), countedScript(counter, "printf '%s\\n' '{broken'"));
      const previousPath = process.env.PATH;
      process.env.PATH = bin;
      try {
        const observation = createManagedReviewObservation({
          session: ctx.session,
          root: ctx.root,
        });
        await expect(observation.github.discoverRepository(ctx.root)).rejects.toThrow(
          'GitHub 返回无法解析的 JSON',
        );
      } finally {
        process.env.PATH = previousPath;
        await ctx.session.close();
      }
      expect(readFileSync(counter, 'utf8').trim()).toBe('1');
    }, 20_000);

    it('uses the same stable history proof when managed Ruleset details omit bypass actors', async () => {
      const ctx = await fixture('run');
      const bin = trustedBin();
      const calls = join(bin, 'gh-ruleset.calls');
      const detail = {
        id: 7,
        name: 'test ruleset',
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [{ type: 'deletion' }],
        updated_at: '2026-08-17T00:00:00.000Z',
      };
      const history = [{ version_id: 99, updated_at: '2026-08-17T00:00:00.100Z' }];
      const version = {
        version_id: 99,
        updated_at: history[0].updated_at,
        state: { ...detail, updated_at: null, bypass_actors: [] },
      };
      const emit = (value: unknown) =>
        `printf '%s\\n' ${JSON.stringify(JSON.stringify(value))}`;
      wrapper(
        join(bin, 'gh'),
        [
          `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
          'case "$*" in',
          `  *"rulesets?includes_parents=false&per_page=100"*) ${emit([{ id: 7 }])} ;;`,
          `  *"rulesets/7/history?per_page=1"*) ${emit(history)} ;;`,
          `  *"rulesets/7/history/99"*) ${emit(version)} ;;`,
          `  *"rulesets/7"*) ${emit(detail)} ;;`,
          "  *) printf '%s\\n' 'unexpected gh invocation' >&2; exit 9 ;;",
          'esac',
        ].join('\n'),
      );
      const previousPath = process.env.PATH;
      process.env.PATH = bin;
      try {
        const observation = createManagedReviewObservation({
          session: ctx.session,
          root: ctx.root,
        });
        await expect(observation.github.listRulesets('owner/repository')).resolves.toEqual([
          expect.objectContaining({ id: 7, bypass_actors: [], rules: [{ type: 'deletion' }] }),
        ]);
      } finally {
        process.env.PATH = previousPath;
        await ctx.session.close();
      }
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(6);
    }, 30_000);
  },
);

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession } from '../workspace-safety/session.js';
import { createManagedReviewObservation } from './managed-observation.js';

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

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')(
  'managed Review observations',
  () => {
    it('quarantines a PATH git wrapper that writes workspace and then reports success', async () => {
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
        const observation = createManagedReviewObservation({
          session: ctx.session,
          root: ctx.root,
        });
        await expect(observation.git(['rev-parse', 'HEAD'])).rejects.toMatchObject({
          code: 'isolated',
        });
      } finally {
        process.env.PATH = previousPath;
      }
      expect(existsSync(marker)).toBe(true);
      expect(ctx.session.state).toBe('isolated');
      await expect(ctx.session.close()).rejects.toMatchObject({ code: 'isolated' });
    }, 20_000);

    it('quarantines a PATH gh wrapper that writes workspace before returning valid JSON', async () => {
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
      process.env.PATH = `${ctx.bin}${delimiter}${previousPath ?? ''}`;
      try {
        const observation = createManagedReviewObservation({
          session: ctx.session,
          root: ctx.root,
        });
        await expect(observation.github.discoverRepository(ctx.root)).rejects.toMatchObject({
          code: 'isolated',
        });
      } finally {
        process.env.PATH = previousPath;
      }
      expect(existsSync(marker)).toBe(true);
      expect(ctx.session.state).toBe('isolated');
      await expect(ctx.session.close()).rejects.toMatchObject({ code: 'isolated' });
    }, 20_000);
  },
);

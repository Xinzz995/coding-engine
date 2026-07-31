import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceSafetyError } from './types.js';

vi.mock('./identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./identity.js')>();
  return {
    ...actual,
    createIdentityProbe: () => ({
      current: () => {
        throw new WorkspaceSafetyError('unsupported', 'fixture identity unavailable');
      },
      probe: () => 'unknown' as const,
    }),
  };
});

import { inspectSameHostRebootRecovery } from './reboot-recovery.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('uses the real identity dependency before reading or writing workspace state', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-reboot-identity-unavailable-'));
  roots.push(workspace);
  writeFileSync(join(workspace, 'sentinel'), 'unchanged');
  const beforeNames = readdirSync(workspace);
  const beforeBytes = readFileSync(join(workspace, 'sentinel'));

  await expect(inspectSameHostRebootRecovery({ workspacePath: workspace })).rejects.toMatchObject({
    code: 'unsupported',
    message: 'fixture identity unavailable',
  });
  expect(readdirSync(workspace)).toEqual(beforeNames);
  expect(readFileSync(join(workspace, 'sentinel'))).toEqual(beforeBytes);
});

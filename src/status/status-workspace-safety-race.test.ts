import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession } from '../workspace-safety/session.js';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { inspectWorkspaceSafetyStatus } from '../workspace-safety/status.js';
import {
  collectStatus,
  collectStatusWithWorkspaceSafetyControlled,
  renderStatusReport,
} from './status.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-status-race-'));
  roots.push(workspace);
  return workspace;
}

function state(notes: string, retryCount: number): string {
  return JSON.stringify({
    'US-001': {
      passes: false,
      validated: false,
      notes,
      retryCount,
      blocked: false,
      escalated: false,
    },
  });
}

async function writeWithFormalSession(
  workspace: string,
  writes: Readonly<Record<string, string>>,
): Promise<void> {
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
  const session = createWorkspaceSession(lease);
  for (const [path, bytes] of Object.entries(writes)) {
    await session.writer.writeFile(path, bytes);
  }
  await session.close();
}

async function readyWorkspace(): Promise<string> {
  const workspace = temporaryWorkspace();
  await bootstrapWorkspace({ workspacePath: workspace });
  await writeWithFormalSession(workspace, {
    'prd.json': JSON.stringify({
      project: 'status-race',
      branchName: 'feature/status-race',
      description: 'status race fixture',
      userStories: [
        {
          id: 'US-001',
          title: 'status race',
          description: 'status race',
          acceptanceCriteria: ['status is stable'],
          priority: 1,
        },
      ],
    }),
    'state.json': state('before', 0),
  });
  return workspace;
}

describe('collectStatusWithWorkspaceSafety consistency window', () => {
  it('retries the complete business read when a writer starts and finishes during it', async () => {
    const workspace = await readyWorkspace();
    const initial = await inspectWorkspaceSafetyStatus(workspace);
    let collections = 0;

    const result = await collectStatusWithWorkspaceSafetyControlled({
      inspect: async () => await inspectWorkspaceSafetyStatus(workspace),
      collect: async () => {
        collections += 1;
        if (collections === 1) {
          await writeWithFormalSession(workspace, { 'state.json': state('after', 1) });
        }
        return collectStatus(workspace);
      },
    });

    expect(collections).toBe(2);
    expect(result.workspaceSafety.status).toBe('ready');
    expect(result.workspaceSafety.safetyFingerprint).not.toBe(initial.safetyFingerprint);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.stories[0]).toMatchObject({ notes: 'after', retryCount: 1 });
    expect(renderStatusReport(result).exitCode).not.toBe(2);
  });

  it('fails closed after one retry when each business read overlaps a completed writer', async () => {
    const workspace = await readyWorkspace();
    let collections = 0;

    const result = await collectStatusWithWorkspaceSafetyControlled({
      inspect: async () => await inspectWorkspaceSafetyStatus(workspace),
      collect: async () => {
        collections += 1;
        await writeWithFormalSession(workspace, {
          'state.json': state(`attempt-${collections}`, collections),
        });
        return collectStatus(workspace);
      },
    });

    expect(collections).toBe(2);
    expect(result.workspaceSafety).toMatchObject({
      status: 'invalid',
      observedClassification: 'invalid',
      reason: 'unstable-probe',
    });
    expect(result.workspaceSafety.diagnostic).toContain('did not stabilize after one retry');
    expect(renderStatusReport(result).exitCode).toBe(2);
  });
});

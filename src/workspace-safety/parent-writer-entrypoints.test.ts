import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendEvidenceWithWriter, readEvidence, type EvidenceRecord } from '../engine/evidence.js';
import { type Prd } from '../engine/prd.js';
import { ensureStateFileWithWriter } from '../engine/state.js';
import { clearValidationResultWithWriter } from '../engine/validation-protocol.js';
import { writeReportWithWriter } from '../report/report.js';
import { bootstrapWorkspace } from './bootstrap.js';
import { acquireWorkspaceLease } from './lease.js';
import { createWorkspaceSession, type WorkspaceSession } from './session.js';

const roots: string[] = [];
const sessions: WorkspaceSession[] = [];

const prd: Prd = {
  project: 'writer-entrypoints',
  branchName: 'codex/writer-entrypoints',
  description: 'parent writer entrypoints',
  userStories: [
    {
      id: 'US-001',
      title: '受控写入',
      description: '所有父进程业务写入必须经过 WorkspaceWriter',
      acceptanceCriteria: ['固定相对路径'],
      priority: 1,
    },
  ],
};

const evidence: EvidenceRecord = {
  type: 'gate-run',
  source: 'engine',
  at: '2026-07-31T10:00:00.000Z',
  iteration: 1,
  storyId: 'US-001',
  ok: true,
  total: 1,
  ran: 1,
  ms: 10,
};

async function openFixture(): Promise<{ workspace: string; session: WorkspaceSession }> {
  const workspace = mkdtempSync(join(tmpdir(), 'parent-writer-entrypoints-'));
  roots.push(workspace);
  await bootstrapWorkspace({ workspacePath: workspace });
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
  const session = createWorkspaceSession(lease);
  sessions.push(session);
  return { workspace, session };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    if (session.state === 'open') await session.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('parent WorkspaceWriter entrypoints', () => {
  it('writes state, evidence, validation cleanup and report only at their fixed paths', async () => {
    const { workspace, session } = await openFixture();

    const state = await ensureStateFileWithWriter(session.writer, prd);
    expect(state['US-001'].passes).toBe(false);
    expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))).toEqual(state);

    await appendEvidenceWithWriter(session.writer, evidence);
    await appendEvidenceWithWriter(session.writer, evidence);
    expect(readEvidence(workspace).records).toEqual([evidence, evidence]);

    await session.writer.writeFile('validation-result.json', '{"stale":true}');
    await clearValidationResultWithWriter(session.writer);
    await clearValidationResultWithWriter(session.writer);
    expect(existsSync(join(workspace, 'validation-result.json'))).toBe(false);

    await session.writer.writeFile('prd.json', JSON.stringify(prd));
    const report = await writeReportWithWriter(
      session.writer,
      new Date('2026-07-31T10:30:00.000Z'),
    );
    expect(report).toEqual({
      status: 'written',
      path: join(session.writer.workspacePath, 'report.html'),
      stateCorrupted: false,
    });
    expect(readFileSync(join(workspace, 'report.html'), 'utf8')).toContain('US-001');
  });

  it('preserves read-only outcomes and propagates every writer rejection', async () => {
    const { workspace, session } = await openFixture();
    await session.writer.writeFile('validation-result.json', '{"stale":true}');
    await session.writer.writeFile('prd.json', JSON.stringify(prd));
    await session.close();

    await expect(ensureStateFileWithWriter(session.writer, prd)).rejects.toMatchObject({
      code: 'closed',
    });
    await expect(appendEvidenceWithWriter(session.writer, evidence)).rejects.toMatchObject({
      code: 'closed',
    });
    await expect(clearValidationResultWithWriter(session.writer)).rejects.toMatchObject({
      code: 'closed',
    });
    await expect(
      writeReportWithWriter(session.writer, new Date('2026-07-31T10:30:00.000Z')),
    ).rejects.toMatchObject({ code: 'closed' });

    expect(existsSync(join(workspace, 'state.json'))).toBe(false);
    expect(existsSync(join(workspace, 'evidence.jsonl'))).toBe(false);
    expect(existsSync(join(workspace, 'validation-result.json'))).toBe(true);
    expect(existsSync(join(workspace, 'report.html'))).toBe(false);
  });

  it('does not ask the writer to create a report when the PRD is missing or invalid', async () => {
    const missing = await openFixture();
    await missing.session.close();

    await expect(writeReportWithWriter(missing.session.writer, new Date())).resolves.toEqual({
      status: 'missing',
      workspace: missing.session.writer.workspacePath,
    });

    const invalid = await openFixture();
    await invalid.session.writer.writeFile('prd.json', '{ broken');
    await invalid.session.close();
    await expect(writeReportWithWriter(invalid.session.writer, new Date())).resolves.toEqual({
      status: 'unparsable',
      workspace: invalid.session.writer.workspacePath,
    });
    expect(existsSync(join(missing.workspace, 'report.html'))).toBe(false);
    expect(existsSync(join(invalid.workspace, 'report.html'))).toBe(false);
  });

  it('keeps an existing corrupted state untouched without requiring a new write', async () => {
    const { workspace, session } = await openFixture();
    await session.writer.writeFile('state.json', '{ broken');
    await session.close();

    await expect(ensureStateFileWithWriter(session.writer, prd)).resolves.toEqual({
      'US-001': {
        passes: false,
        validated: false,
        storyBaseGitHead: null,
        validationReceipt: null,
        validatorUnverifiable: null,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    });
    expect(readFileSync(join(workspace, 'state.json'), 'utf8')).toBe('{ broken');
  });
});

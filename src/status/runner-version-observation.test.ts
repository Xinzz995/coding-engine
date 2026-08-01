import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../review/common.js';
import { observeStatusRunnerVersionControlled } from './runner-version-observation.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeReadyReview(workspace: string): void {
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: ['src/demo.ts'],
    changedModules: ['root'],
  };
  const riskDigest = digest(risk);
  writeFileSync(
    join(workspace, 'final-review.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: 'passed',
      deliveryStatus: 'ready',
      binding: {
        prNumber: 1,
        targetBranch: 'main',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        prTitleDigest: 'title',
        prBodyDigest: 'body',
        specDigest: 'spec',
        engineeringStandardsDigest: 'standards',
        qualityContractDigest: 'contract',
        codingXVersion: '0.34.0',
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex 1.2.3',
        reviewRulesVersion: '1.0.0',
        reviewRulesDigest: 'rules',
        riskDigest,
      },
      risk: { ...risk, digest: riskDigest },
      axes: [
        {
          axis: 'spec',
          status: 'passed',
          summary: 'ok',
          findings: [],
          requestDeepReview: false,
          durationMs: 1,
          attempts: 1,
        },
        {
          axis: 'engineering',
          status: 'passed',
          summary: 'ok',
          findings: [],
          requestDeepReview: false,
          durationMs: 1,
          attempts: 1,
        },
      ],
      remote: {
        status: 'ready',
        checks: [],
        rulesetErrors: [],
        checkedAt: '2026-07-31T00:00:00.000Z',
      },
      round: 1,
      shadow: false,
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:01:00.000Z',
    }),
  );
}

function readyReviewWorkspace(): { projectRoot: string; workspace: string } {
  const projectRoot = temporaryDirectory('coding-x-status-runner-project-');
  const workspace = join(projectRoot, '.workspace');
  mkdirSync(workspace);
  writeReadyReview(workspace);
  return { projectRoot, workspace };
}

describe('status Runner version transient safety domain', () => {
  it('supervises the observation outside the project and removes the safely closed domain', async () => {
    const { projectRoot, workspace } = readyReviewWorkspace();
    let safetyPath = '';
    let observedSessionState = '';
    const observe = vi.fn(async (options) => {
      safetyPath = options.session.writer.workspacePath;
      observedSessionState = options.session.state;
      const relation = relative(projectRoot, safetyPath);
      expect(relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))).toBe(false);
      return { status: 'ready' as const, runner: 'codex' as const, version: 'codex 1.2.3' };
    });

    await expect(
      observeStatusRunnerVersionControlled({ workspace, projectRoot }, { observe }),
    ).resolves.toEqual({ status: 'ready', runner: 'codex', version: 'codex 1.2.3' });

    expect(observe).toHaveBeenCalledOnce();
    expect(observedSessionState).toBe('open');
    expect(safetyPath).not.toBe('');
    expect(existsSync(safetyPath)).toBe(false);
  });

  it('closes and removes the transient domain when observation throws', async () => {
    const { projectRoot, workspace } = readyReviewWorkspace();
    let safetyPath = '';

    const result = await observeStatusRunnerVersionControlled(
      { workspace, projectRoot },
      {
        observe: async (options) => {
          safetyPath = options.session.writer.workspacePath;
          throw new Error('fixture observation failure');
        },
      },
    );

    expect(result).toMatchObject({ status: 'unverifiable', runner: 'codex' });
    if (result.status !== 'unverifiable') throw new Error('expected unverifiable');
    expect(result.message).toContain('fixture observation failure');
    expect(existsSync(safetyPath)).toBe(false);
  });

  it('does not delete an isolated transient domain whose closeout is unproven', async () => {
    const { projectRoot, workspace } = readyReviewWorkspace();
    let safetyPath = '';

    const result = await observeStatusRunnerVersionControlled(
      { workspace, projectRoot },
      {
        observe: async (options) => {
          safetyPath = options.session.writer.workspacePath;
          roots.push(safetyPath);
          options.session.retainLeaseForIsolation();
          return {
            status: 'unverifiable' as const,
            runner: 'codex' as const,
            message: 'fixture isolated observation',
          };
        },
      },
    );

    expect(result).toMatchObject({ status: 'unverifiable', runner: 'codex' });
    if (result.status !== 'unverifiable') throw new Error('expected unverifiable');
    expect(result.message).toContain('fixture isolated observation');
    expect(result.message).toContain('isolated');
    expect(result.message).toContain(basename(safetyPath));
    expect(existsSync(safetyPath)).toBe(true);
  });

  it('retains the transient domain when session close throws', async () => {
    const { projectRoot, workspace } = readyReviewWorkspace();
    let safetyPath = '';

    const result = await observeStatusRunnerVersionControlled(
      { workspace, projectRoot },
      {
        observe: async (options) => {
          safetyPath = options.session.writer.workspacePath;
          roots.push(safetyPath);
          vi.spyOn(options.session, 'close').mockRejectedValue(
            new Error('fixture session close failure'),
          );
          return { status: 'ready' as const, runner: 'codex' as const, version: 'codex 1.2.3' };
        },
      },
    );

    expect(result).toMatchObject({ status: 'unverifiable', runner: 'codex' });
    if (result.status !== 'unverifiable') throw new Error('expected unverifiable');
    expect(result.message).toContain('session 无法安全关闭');
    expect(result.message).toContain('fixture session close failure');
    expect(existsSync(safetyPath)).toBe(true);
  });

  it('retains both identities and never deletes a replacement safety root', async () => {
    const { projectRoot, workspace } = readyReviewWorkspace();
    let safetyPath = '';
    let originalPath = '';

    const result = await observeStatusRunnerVersionControlled(
      { workspace, projectRoot },
      {
        observe: async (options) => {
          safetyPath = options.session.writer.workspacePath;
          originalPath = `${safetyPath}-original`;
          renameSync(safetyPath, originalPath);
          roots.push(safetyPath, originalPath);
          mkdirSync(safetyPath);
          writeFileSync(join(safetyPath, 'sentinel.txt'), 'replacement\n');
          return { status: 'ready' as const, runner: 'codex' as const, version: 'codex 1.2.3' };
        },
      },
    );

    expect(result).toMatchObject({ status: 'unverifiable', runner: 'codex' });
    if (result.status !== 'unverifiable') throw new Error('expected unverifiable');
    expect(result.message).toContain('已保留');
    expect(readFileSync(join(safetyPath, 'sentinel.txt'), 'utf8')).toBe('replacement\n');
    expect(existsSync(originalPath)).toBe(true);
  });
});

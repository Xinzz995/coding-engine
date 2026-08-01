import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPackage } from '../review/package.js';
import { runSafeReviewAxis } from '../review/runner.js';
import { ReviewTemporaryDirectory } from '../review/temporary-directory.js';
import { bootstrapWorkspace } from './bootstrap.js';
import { runManagedWorkspaceProcess } from './coordinator.js';
import { acquireWorkspaceLease } from './lease.js';
import { createWorkspaceSession } from './session.js';
import { inspectWindowsPathAttributes } from './windows-path-attributes.js';

const roots: string[] = [];
const WINDOWS_REVIEW_TEMPORARY_TEST_TIMEOUT_MS = 120_000;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `coding-x-review-${label}-Unicode 空格-`));
  roots.push(root);
  return root;
}

function managedReviewPackage(onPhase: (phase: string) => void = () => undefined): ReviewPackage {
  const temporary = ReviewTemporaryDirectory.create({
    prefix: 'coding-x-review-windows-managed-',
    projectRoot: process.cwd(),
  });
  roots.push(temporary.root);
  const input = '{}\n';
  const schema = '{}\n';
  const manifest = '{}\n';
  const runner = [
    'const fs=require("node:fs");',
    'const prompt=fs.readFileSync(0);',
    'if(prompt.length===0) process.exit(9);',
    'const answer={status:"passed",summary:"ok",requestDeepReview:false,',
    '  unverifiableReason:null,findings:[]};',
    'const output=[',
    '  JSON.stringify({type:"thread.started",thread_id:"fixture"}),',
    '  JSON.stringify({type:"item.completed",item:{',
    '    type:"agent_message",text:JSON.stringify(answer)}}),',
    '  JSON.stringify({type:"turn.completed"}),',
    '].join("\\n")+"\\n";',
    'fs.writeSync(1,output);',
  ].join('\n');
  const inputPath = join(temporary.root, 'review-input.json');
  const schemaPath = join(temporary.root, 'response-schema.json');
  const manifestPath = join(temporary.root, 'manifest.json');
  const runnerPath = join(temporary.root, 'exec');
  writeFileSync(inputPath, input, { mode: 0o400 });
  writeFileSync(schemaPath, schema, { mode: 0o400 });
  writeFileSync(manifestPath, manifest, { mode: 0o400 });
  writeFileSync(runnerPath, runner, { mode: 0o400 });
  chmodSync(temporary.root, 0o500);
  temporary.sealExactTree({
    files: [
      { path: 'review-input.json', bytes: Buffer.from(input), maximumBytes: 64 },
      { path: 'response-schema.json', bytes: Buffer.from(schema), maximumBytes: 64 },
      { path: 'manifest.json', bytes: Buffer.from(manifest), maximumBytes: 64 },
      { path: 'exec', bytes: Buffer.from(runner), maximumBytes: 4096 },
    ],
  });
  return {
    root: temporary.root,
    projectRoot: process.cwd(),
    inputPath,
    schemaPath,
    schema,
    manifestPath,
    input,
    inputBytes: Buffer.byteLength(input),
    digest: 'sha256:windows-native-fixture',
    cleanup: () => {
      onPhase('package-cleanup-start');
      const result = temporary.cleanup();
      onPhase(`package-cleanup-${result.status}`);
      return result;
    },
    assertUnchanged: () => temporary.assertUnchanged(),
    prepareManagedUse: () => {
      onPhase('package-prepare-start');
      temporary.prepareManagedUse();
      onPhase('package-prepare-complete');
    },
    beginManagedUse: () => {
      onPhase('package-begin-start');
      temporary.beginManagedUse();
      onPhase('package-begin-complete');
    },
    confirmManagedUseSettled: () => {
      onPhase('package-confirm-start');
      temporary.confirmManagedUseSettled();
      onPhase('package-confirm-complete');
    },
  };
}

function compactWithWof(path: string): void {
  const systemRoot = Object.entries(process.env).find(
    ([name]) => name.toLowerCase() === 'systemroot',
  )?.[1];
  if (!systemRoot) throw new Error('SystemRoot is unavailable');
  const result = spawnSync(
    win32.join(systemRoot, 'System32', 'compact.exe'),
    ['/C', '/EXE:LZX', '/F', win32.basename(path)],
    {
      cwd: win32.dirname(path),
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: WINDOWS_REVIEW_TEMPORARY_TEST_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const [record] = inspectWindowsPathAttributes([path]);
  expect(record).toMatchObject({
    status: 'found',
    externalBacking: { status: 'external', provider: 'file', algorithm: 'lzx' },
  });
}

function expectWindowsRenameDenied(source: string, destination: string): void {
  let caught: unknown;
  try {
    renameSync(source, destination);
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: expect.stringMatching(/^(?:EACCES|EPERM)$/u) });
  expect(existsSync(source)).toBe(true);
  expect(existsSync(destination)).toBe(false);
}

describe.skipIf(process.platform !== 'win32')(
  'Windows Reviewer temporary-domain native proof',
  () => {
    it('moves and removes one unchanged fixed domain through production Windows checks', () => {
      const parent = temporaryRoot('successful-cleanup-parent');
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-windows-success-',
        projectRoot: process.cwd(),
        temporaryParent: parent,
      });
      const root = temporary.root;
      writeFileSync(join(root, 'review-input.json'), 'input\n', { mode: 0o400 });
      temporary.sealExactTree({
        files: [
          {
            path: 'review-input.json',
            bytes: Buffer.from('input\n'),
            maximumBytes: 64,
          },
        ],
      });

      expect(temporary.cleanup()).toEqual({ status: 'removed' });
      expect(temporary.cleanup()).toEqual({ status: 'removed' });
      expect(existsSync(root)).toBe(false);
    });

    it(
      'runs a real managed Review package through the Windows supervisor and fixed proxy',
      async () => {
        const startedAt = Date.now();
        const mark = (phase: string): void => {
          process.stdout.write(`[windows-review-phase] ${Date.now() - startedAt}ms ${phase}\n`);
        };
        const workspace = temporaryRoot('managed-workspace');
        mark('workspace-created');
        await bootstrapWorkspace({ workspacePath: workspace });
        mark('workspace-bootstrapped');
        const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
        mark('lease-acquired');
        const session = createWorkspaceSession(lease);
        const reviewPackage = managedReviewPackage(mark);
        mark('package-created');
        vi.stubEnv('CODING_X_CODEX_BIN', process.execPath);
        try {
          await expect(
            runSafeReviewAxis({
              session,
              runner: 'codex',
              model: 'review-model',
              runnerVersion: 'codex-test',
              axis: 'engineering',
              reviewPackage,
              timeoutMs: 10_000,
              managedProcess: async (managedSession, options) => {
                mark('managed-process-start');
                try {
                  const result = await runManagedWorkspaceProcess(managedSession, {
                    ...options,
                    supervisorTimeouts: {
                      ...options.supervisorTimeouts,
                      handshakeMs: 5000,
                    },
                  });
                  mark(`managed-process-${result.verdict}`);
                  process.stdout.write(
                    `[windows-review-managed-result] ${JSON.stringify({
                      verdict: result.verdict,
                      exitCode: result.exitCode,
                      timedOut: result.timedOut,
                      processTreeNotEmpty: result.processTreeNotEmpty,
                      terminationReason: result.terminationReason,
                      stdoutBase64: result.stdout.subarray(0, 4096).toString('base64'),
                      stderrBase64: result.stderr.subarray(0, 4096).toString('base64'),
                    })}\n`,
                  );
                  return result;
                } catch (error) {
                  mark(`managed-process-error-${error instanceof Error ? error.name : 'unknown'}`);
                  throw error;
                }
              },
            }),
          ).resolves.toMatchObject({
            attempts: 1,
            output: { status: 'passed' },
          });
          mark('review-complete');
          expect(() => reviewPackage.assertUnchanged()).not.toThrow();
          mark('package-asserted');
          expect(reviewPackage.cleanup()).toEqual({ status: 'removed' });
          expect(existsSync(reviewPackage.root)).toBe(false);
        } finally {
          reviewPackage.cleanup();
          mark('session-close-start');
          await session.close();
          mark('session-close-complete');
        }
      },
      WINDOWS_REVIEW_TEMPORARY_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a Node-readable WOF leaf before accepting fixed review bytes',
      () => {
        const parent = temporaryRoot('wof-parent');
        const temporary = ReviewTemporaryDirectory.create({
          prefix: 'coding-x-review-windows-wof-',
          projectRoot: process.cwd(),
          temporaryParent: parent,
        });
        const input = join(temporary.root, 'review-input.json');
        const bytes = Buffer.alloc(1024 * 1024, 0x61);
        writeFileSync(input, bytes);
        compactWithWof(input);
        const inputHandle = openSync(input, 'r');
        try {
          expect(fstatSync(inputHandle).isFile()).toBe(true);
          expect(readFileSync(inputHandle).byteLength).toBe(bytes.byteLength);
        } finally {
          closeSync(inputHandle);
        }

        expect(() =>
          temporary.sealExactTree({
            files: [{ path: 'review-input.json', bytes, maximumBytes: bytes.byteLength }],
          }),
        ).toThrow(/Windows path attribute|external backing/u);
        expect(lstatSync(input).isSymbolicLink()).toBe(false);
        expect(temporary.retain('native WOF fixture')).toMatchObject({
          status: 'retained',
          protection: { status: 'unverifiable', reason: 'platform-unsupported' },
        });
      },
      WINDOWS_REVIEW_TEMPORARY_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a nested WOF leaf before accepting an exact review tree',
      () => {
        const parent = temporaryRoot('nested-wof-parent');
        const temporary = ReviewTemporaryDirectory.create({
          prefix: 'coding-x-review-windows-nested-wof-',
          projectRoot: process.cwd(),
          temporaryParent: parent,
        });
        const packageRoot = join(temporary.root, 'package');
        const input = join(packageRoot, 'review-input.json');
        const bytes = Buffer.alloc(1024 * 1024, 0x62);
        mkdirSync(packageRoot);
        writeFileSync(input, bytes);
        compactWithWof(input);

        expect(() =>
          temporary.sealExactTree({
            directories: ['package'],
            files: [
              {
                path: 'package/review-input.json',
                bytes,
                maximumBytes: bytes.byteLength,
              },
            ],
          }),
        ).toThrow(/Windows path attribute|external backing/u);
        expect(temporary.retain('native nested WOF fixture')).toMatchObject({
          status: 'retained',
          protection: { status: 'unverifiable', reason: 'platform-unsupported' },
        });
      },
      WINDOWS_REVIEW_TEMPORARY_TEST_TIMEOUT_MS,
    );

    it(
      'retains a safe review tree when a managed output gains WOF backing',
      () => {
        const parent = temporaryRoot('safe-wof-parent');
        const temporary = ReviewTemporaryDirectory.create({
          prefix: 'coding-x-review-windows-safe-wof-',
          projectRoot: process.cwd(),
          temporaryParent: parent,
        });
        temporary.sealSafeTree();
        const output = join(temporary.root, 'runner-output.json');
        writeFileSync(output, Buffer.alloc(1024 * 1024, 0x63));
        compactWithWof(output);

        expect(() => temporary.assertUnchanged()).toThrow('Reviewer 临时域身份核对失败');
        expect(temporary.cleanup()).toMatchObject({
          status: 'retained',
          location: { status: 'verified', path: temporary.root },
          protection: { status: 'unverifiable', reason: 'platform-unsupported' },
        });
      },
      WINDOWS_REVIEW_TEMPORARY_TEST_TIMEOUT_MS,
    );

    it('rejects a junction ancestor without reading or deleting its outside target', () => {
      const parent = temporaryRoot('junction-leaf-parent');
      const outside = temporaryRoot('junction-leaf-target');
      const outsideInput = join(outside, 'review-input.json');
      writeFileSync(outsideInput, 'outside-canary\n');
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-windows-junction-',
        projectRoot: process.cwd(),
        temporaryParent: parent,
      });
      symlinkSync(outside, join(temporary.root, 'package'), 'junction');
      expect(lstatSync(join(temporary.root, 'package')).isSymbolicLink()).toBe(true);

      expect(() =>
        temporary.sealExactTree({
          directories: ['package'],
          files: [
            {
              path: 'package/review-input.json',
              bytes: Buffer.from('outside-canary\n'),
              maximumBytes: 64,
            },
          ],
        }),
      ).toThrow(/Windows path attribute|reparse/u);
      expect(temporary.retain('native junction fixture')).toMatchObject({
        status: 'retained',
        protection: { status: 'unverifiable', reason: 'platform-unsupported' },
      });
      expect(readFileSync(outsideInput, 'utf8')).toBe('outside-canary\n');
    });

    it('keeps a fixed-file exact root pinned against rename until verified cleanup', () => {
      const parent = temporaryRoot('root-replacement-parent');
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-windows-root-',
        projectRoot: process.cwd(),
        temporaryParent: parent,
      });
      writeFileSync(join(temporary.root, 'input.json'), 'input\n');
      temporary.sealExactTree({
        files: [{ path: 'input.json', bytes: Buffer.from('input\n'), maximumBytes: 64 }],
      });
      const original = `${temporary.root}-original`;

      expectWindowsRenameDenied(temporary.root, original);
      expect(temporary.cleanup()).toEqual({ status: 'removed' });
      expect(existsSync(temporary.root)).toBe(false);
    });

    it('keeps a fixed-file exact parent pinned against rename until verified cleanup', () => {
      const container = temporaryRoot('parent-replacement-container');
      const parent = join(container, 'temporary-parent');
      mkdirSync(parent);
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-windows-parent-',
        projectRoot: process.cwd(),
        temporaryParent: parent,
      });
      writeFileSync(join(temporary.root, 'input.json'), 'input\n');
      temporary.sealExactTree({
        files: [{ path: 'input.json', bytes: Buffer.from('input\n'), maximumBytes: 64 }],
      });
      const originalParent = `${parent}-original`;

      expectWindowsRenameDenied(parent, originalParent);
      expect(temporary.cleanup()).toEqual({ status: 'removed' });
      expect(existsSync(temporary.root)).toBe(false);
    });

    it('retains an empty exact domain after its root is replaced by a junction', () => {
      const parent = temporaryRoot('empty-root-replacement-parent');
      const outside = temporaryRoot('empty-root-replacement-target');
      const canary = join(outside, 'sentinel.txt');
      writeFileSync(canary, 'outside-canary\n');
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-windows-empty-root-',
        projectRoot: process.cwd(),
        temporaryParent: parent,
      });
      temporary.sealExactTree({ files: [] });
      const original = `${temporary.root}-original`;
      renameSync(temporary.root, original);
      symlinkSync(outside, temporary.root, 'junction');
      expect(lstatSync(temporary.root).isSymbolicLink()).toBe(true);

      expect(temporary.cleanup()).toMatchObject({
        status: 'unverifiable',
        location: { status: 'unverifiable', candidates: [temporary.root] },
        protection: { status: 'unverifiable', reason: 'identity-or-tree-unverified' },
      });
      expect(readFileSync(canary, 'utf8')).toBe('outside-canary\n');
      expect(existsSync(original)).toBe(true);
    });

    it('retains a safe-tree domain after its parent is replaced by a junction', () => {
      const container = temporaryRoot('safe-parent-replacement-container');
      const parent = join(container, 'temporary-parent');
      const outside = temporaryRoot('safe-parent-replacement-target');
      mkdirSync(parent);
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-windows-safe-parent-',
        projectRoot: process.cwd(),
        temporaryParent: parent,
      });
      const replacementRoot = join(outside, win32.basename(temporary.root));
      const canary = join(replacementRoot, 'sentinel.txt');
      mkdirSync(replacementRoot);
      writeFileSync(canary, 'outside-canary\n');
      writeFileSync(join(temporary.root, 'status.json'), '{}\n');
      temporary.sealSafeTree();
      const originalParent = `${parent}-original`;
      renameSync(parent, originalParent);
      symlinkSync(outside, parent, 'junction');
      expect(lstatSync(parent).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(temporary.root, 'sentinel.txt'), 'utf8')).toBe('outside-canary\n');

      expect(temporary.cleanup()).toMatchObject({
        status: 'unverifiable',
        location: { status: 'unverifiable', candidates: [temporary.root] },
        protection: { status: 'unverifiable', reason: 'identity-or-tree-unverified' },
      });
      expect(readFileSync(canary, 'utf8')).toBe('outside-canary\n');
      expect(existsSync(join(originalParent, win32.basename(temporary.root), 'status.json'))).toBe(
        true,
      );
    });
  },
);

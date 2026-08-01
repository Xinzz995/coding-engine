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
import { acquireWorkspaceLease } from './lease.js';
import { createWorkspaceSession } from './session.js';
import { inspectWindowsPathAttributes } from './windows-path-attributes.js';

const roots: string[] = [];
const WINDOWS_REVIEW_TEMPORARY_TEST_TIMEOUT_MS = 60_000;

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

function managedReviewPackage(): ReviewPackage {
  const temporary = ReviewTemporaryDirectory.create({
    prefix: 'coding-x-review-windows-managed-',
    projectRoot: process.cwd(),
  });
  roots.push(temporary.root);
  const input = '{}\n';
  const schema = '{}\n';
  const manifest = '{}\n';
  const runner = [
    'const chunks=[];',
    'process.stdin.on("data",chunk=>chunks.push(chunk));',
    'process.stdin.on("end",()=>{',
    '  if(Buffer.concat(chunks).length===0) process.exit(9);',
    '  const answer={status:"passed",summary:"ok",requestDeepReview:false,',
    '    unverifiableReason:null,findings:[]};',
    '  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"fixture"})+"\\n");',
    '  process.stdout.write(JSON.stringify({type:"item.completed",item:{',
    '    type:"agent_message",text:JSON.stringify(answer)}})+"\\n");',
    '  process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");',
    '});',
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
    cleanup: () => temporary.cleanup(),
    assertUnchanged: () => temporary.assertUnchanged(),
    prepareManagedUse: () => temporary.prepareManagedUse(),
    beginManagedUse: () => temporary.beginManagedUse(),
    confirmManagedUseSettled: () => temporary.confirmManagedUseSettled(),
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
        const workspace = temporaryRoot('managed-workspace');
        await bootstrapWorkspace({ workspacePath: workspace });
        const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
        const session = createWorkspaceSession(lease);
        const reviewPackage = managedReviewPackage();
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
            }),
          ).resolves.toMatchObject({
            attempts: 1,
            output: { status: 'passed' },
          });
          expect(() => reviewPackage.assertUnchanged()).not.toThrow();
          expect(reviewPackage.cleanup()).toEqual({ status: 'removed' });
          expect(existsSync(reviewPackage.root)).toBe(false);
        } finally {
          reviewPackage.cleanup();
          await session.close();
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
          expect(fstatSync(inputHandle).isSymbolicLink()).toBe(false);
          expect(readFileSync(inputHandle).byteLength).toBe(bytes.byteLength);
        } finally {
          closeSync(inputHandle);
        }

        expect(() =>
          temporary.sealExactTree({
            files: [{ path: 'review-input.json', bytes, maximumBytes: bytes.byteLength }],
          }),
        ).toThrow(/Windows path attribute|external backing/u);
        expect(temporary.retain('native WOF fixture')).toMatchObject({ status: 'retained' });
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
      expect(temporary.retain('native junction fixture')).toMatchObject({ status: 'retained' });
      expect(readFileSync(outsideInput, 'utf8')).toBe('outside-canary\n');
    });

    it('does not chmod or delete a junction installed at the frozen root path', () => {
      const parent = temporaryRoot('root-replacement-parent');
      const outside = temporaryRoot('root-replacement-target');
      const canary = join(outside, 'sentinel.txt');
      writeFileSync(canary, 'outside-canary\n');
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
      renameSync(temporary.root, original);
      symlinkSync(outside, temporary.root, 'junction');
      expect(lstatSync(temporary.root).isSymbolicLink()).toBe(true);

      expect(temporary.cleanup()).toMatchObject({ status: 'retained', path: temporary.root });
      expect(readFileSync(canary, 'utf8')).toBe('outside-canary\n');
      expect(existsSync(join(original, 'input.json'))).toBe(true);
    });

    it('retains the original tree when the temporary parent is replaced by a junction', () => {
      const container = temporaryRoot('parent-replacement-container');
      const parent = join(container, 'temporary-parent');
      const outside = temporaryRoot('parent-replacement-target');
      mkdirSync(parent);
      writeFileSync(join(outside, 'sentinel.txt'), 'outside-canary\n');
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
      renameSync(parent, originalParent);
      symlinkSync(outside, parent, 'junction');
      expect(lstatSync(parent).isSymbolicLink()).toBe(true);

      expect(temporary.cleanup()).toMatchObject({ status: 'retained' });
      expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside-canary\n');
      expect(existsSync(join(originalParent, win32.basename(temporary.root), 'input.json'))).toBe(
        true,
      );
    });
  },
);

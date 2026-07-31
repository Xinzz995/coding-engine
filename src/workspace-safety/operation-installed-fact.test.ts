import { linkSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installFileNoReplace, readExactFile } from './filesystem.js';
import {
  ABORT_STAGING_PATTERN,
  DRAINED_RECEIPT_FILE,
  PRESTART_ABORT_FILE,
  RECEIPT_STAGING_PATTERN,
  readOperationInstalledFact,
  recoverOperationInstalledFact,
} from './operation-records.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { root: string; source: string; target: string; bytes: Buffer } {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-operation-fact-'));
  roots.push(root);
  const source = join(root, 'drained-receipt.prepare-00000000-0000-4000-8000-000000000099.json');
  const target = join(root, DRAINED_RECEIPT_FILE);
  const bytes = Buffer.from('{"fixed":"receipt"}\n', 'utf8');
  writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 });
  return { root, source, target, bytes };
}

describe('operation fact linked-install recovery', () => {
  it('recognizes and closes the exact link-to-unlink crash window under repeated authority', async () => {
    const fixture = setup();
    await expect(
      installFileNoReplace(fixture.source, fixture.target, {
        afterLink: () => {
          throw new Error('simulated hard stop after link');
        },
      }),
    ).rejects.toThrow(/hard stop/u);
    expect(statSync(fixture.source).nlink).toBe(2);
    expect(statSync(fixture.target).nlink).toBe(2);

    const observed = await readOperationInstalledFact({
      operationPath: fixture.root,
      canonicalName: DRAINED_RECEIPT_FILE,
      stagingPattern: RECEIPT_STAGING_PATTERN,
      maxBytes: 1024,
    });
    expect(observed).toEqual({ bytes: fixture.bytes, linkedSource: fixture.source });
    let authorityChecks = 0;
    await recoverOperationInstalledFact({
      source: observed.linkedSource!,
      target: fixture.target,
      expectedBytes: observed.bytes,
      authorize: () => {
        authorityChecks += 1;
      },
    });
    expect(authorityChecks).toBe(2);
    expect(statSync(fixture.target).nlink).toBe(1);
    await expect(readExactFile(fixture.target)).resolves.toEqual(fixture.bytes);
  });

  it('rejects a third alias instead of treating it as a controlled install window', async () => {
    const fixture = setup();
    linkSync(fixture.source, fixture.target);
    linkSync(fixture.source, join(fixture.root, 'third-alias.json'));

    await expect(
      readOperationInstalledFact({
        operationPath: fixture.root,
        canonicalName: DRAINED_RECEIPT_FILE,
        stagingPattern: RECEIPT_STAGING_PATTERN,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('applies the same strict recovery boundary to prestart-abort installation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-operation-abort-fact-'));
    roots.push(root);
    const source = join(root, 'prestart-abort.prepare-00000000-0000-4000-8000-000000000099.json');
    const target = join(root, PRESTART_ABORT_FILE);
    const bytes = Buffer.from('{"fixed":"prestart-abort"}\n', 'utf8');
    writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 });
    await expect(
      installFileNoReplace(source, target, {
        afterLink: () => {
          throw new Error('simulated hard stop after abort link');
        },
      }),
    ).rejects.toThrow(/hard stop/u);

    const observed = await readOperationInstalledFact({
      operationPath: root,
      canonicalName: PRESTART_ABORT_FILE,
      stagingPattern: ABORT_STAGING_PATTERN,
      maxBytes: 1024,
    });
    expect(observed).toEqual({ bytes, linkedSource: source });
    await recoverOperationInstalledFact({
      source: observed.linkedSource!,
      target,
      expectedBytes: observed.bytes,
      authorize: () => undefined,
    });
    expect(statSync(target).nlink).toBe(1);
    await expect(readExactFile(target)).resolves.toEqual(bytes);
  });
});

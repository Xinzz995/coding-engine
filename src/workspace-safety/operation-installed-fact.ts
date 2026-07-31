import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  pathExists,
  readExactFile,
  readLinkedFileInstall,
  recoverLinkedFileInstall,
  type RecoverLinkedFileInstallOptions,
} from './filesystem.js';
import { WorkspaceSafetyError } from './types.js';

export const RECEIPT_STAGING_PATTERN =
  /^drained-receipt\.prepare-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
export const ABORT_STAGING_PATTERN =
  /^prestart-abort\.prepare-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

export interface ReadOperationInstalledFactOptions {
  readonly operationPath: string;
  readonly canonicalName: string;
  readonly stagingPattern: RegExp;
  readonly maxBytes: number;
}

export interface OperationInstalledFact {
  readonly bytes: Buffer;
  readonly linkedSource?: string;
}

function invalid(message: string): WorkspaceSafetyError {
  return new WorkspaceSafetyError('invalid', `Invalid operation fact installation: ${message}`);
}

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

export async function readOperationInstalledFact(
  options: ReadOperationInstalledFactOptions,
): Promise<OperationInstalledFact> {
  const target = join(options.operationPath, options.canonicalName);
  if (!(await pathExists(target))) throw invalid(`${options.canonicalName} is missing`);
  const targetInfo = await lstat(target, { bigint: true });
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    throw invalid(`${options.canonicalName} is not an ordinary file`);
  }
  const candidates: Array<{ readonly path: string; readonly dev: bigint; readonly ino: bigint }> =
    [];
  for (const name of await readdir(options.operationPath)) {
    if (!patternMatches(options.stagingPattern, name)) continue;
    const path = join(options.operationPath, name);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) {
      throw invalid(`${name} is not an ordinary staging file`);
    }
    if (info.nlink === 2n) candidates.push({ path, dev: info.dev, ino: info.ino });
    else if (info.nlink !== 1n) throw invalid(`${name} has an unsupported link count`);
  }

  if (targetInfo.nlink === 1n) {
    if (candidates.length !== 0) throw invalid('canonical fact has unrelated linked staging');
    const bytes = await readExactFile(target);
    if (bytes.byteLength > options.maxBytes) throw invalid('canonical fact exceeds its byte bound');
    return { bytes };
  }
  if (targetInfo.nlink !== 2n) throw invalid('canonical fact has an unsupported link count');
  const linked = candidates.filter(
    (candidate) => candidate.dev === targetInfo.dev && candidate.ino === targetInfo.ino,
  );
  if (linked.length !== 1 || candidates.length !== 1) {
    throw invalid('canonical fact lacks one unique controlled linked staging source');
  }
  const bytes = await readLinkedFileInstall({
    source: linked[0].path,
    target,
    maxBytes: options.maxBytes,
  });
  return { bytes, linkedSource: linked[0].path };
}

export async function recoverOperationInstalledFact(
  options: RecoverLinkedFileInstallOptions,
): Promise<void> {
  await recoverLinkedFileInstall(options);
}

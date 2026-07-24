import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export class QualityGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QualityGitError';
  }
}
export function gitText(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    }).trimEnd();
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    throw new QualityGitError(`git ${args[0] ?? ''} 失败：${diagnostic}`);
  }
}

export function resolveGitRoot(cwd: string): string {
  const result = gitText(cwd, ['rev-parse', '--show-toplevel']);
  if (result.trim() === '') throw new QualityGitError('无法定位 Git 根目录');
  return resolve(result);
}

export function gitHead(root: string, ref = 'HEAD'): string {
  const value = gitText(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new QualityGitError(`无法解析提交：${ref}`);
  return value;
}

export function defaultBranch(root: string): string {
  try {
    const symbolic = gitText(root, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const prefix = 'refs/remotes/origin/';
    if (symbolic.startsWith(prefix)) return symbolic.slice(prefix.length);
  } catch {
    // Fall through to the local conventional branch checks.
  }
  for (const candidate of ['main', 'master']) {
    try {
      gitHead(root, candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  throw new QualityGitError('无法确定默认分支；请在质量契约中明确 github.defaultBranch');
}

export function repositoryFromRemote(root: string): string | null {
  let url: string;
  try {
    url = gitText(root, ['remote', 'get-url', 'origin']).trim();
  } catch {
    return null;
  }
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (ssh) return ssh[1];
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return https ? https[1] : null;
}

export interface GitDiffBundle {
  baseSha: string;
  headSha: string;
  diff: string;
  changedFiles: string[];
  numstat: Array<{ path: string; added: number | null; deleted: number | null }>;
}

export function collectGitDiff(root: string, baseRef: string, headRef = 'HEAD'): GitDiffBundle {
  const baseSha = gitHead(root, baseRef);
  const headSha = gitHead(root, headRef);
  const range = `${baseSha}...${headSha}`;
  const diff = gitText(root, [
    'diff', '--no-ext-diff', '--no-color', '--find-renames', '--unified=40',
    range, '--', '.', ':(exclude)*.lock', ':(exclude)package-lock.json',
    ':(exclude)dist/**', ':(exclude)node_modules/**',
  ]);
  const names = gitText(root, [
    'diff', '--name-only', '--find-renames', range, '--',
    '.', ':(exclude)*.lock', ':(exclude)package-lock.json',
    ':(exclude)dist/**', ':(exclude)node_modules/**',
  ]);
  const stats = gitText(root, [
    'diff', '--numstat', '--find-renames', range, '--',
    '.', ':(exclude)*.lock', ':(exclude)package-lock.json',
    ':(exclude)dist/**', ':(exclude)node_modules/**',
  ]);
  const numstat = stats === '' ? [] : stats.split('\n').flatMap((line) => {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) return [];
    return [{
      path: match[3],
      added: match[1] === '-' ? null : Number(match[1]),
      deleted: match[2] === '-' ? null : Number(match[2]),
    }];
  });
  return {
    baseSha,
    headSha,
    diff,
    changedFiles: names === '' ? [] : names.split('\n'),
    numstat,
  };
}

export function collectGitDiffByFile(
  root: string,
  bundle: Pick<GitDiffBundle, 'baseSha' | 'headSha' | 'changedFiles'>,
): Map<string, string> {
  const range = `${bundle.baseSha}...${bundle.headSha}`;
  return new Map(bundle.changedFiles.map((path) => [
    path,
    gitText(root, [
      'diff', '--no-ext-diff', '--no-color', '--find-renames', '--unified=40',
      range, '--', path,
    ]),
  ]));
}

export function trackedPathsAtRef(root: string, ref: string, sources: string[]): string[] {
  const paths = gitText(root, ['ls-tree', '-r', '--name-only', ref, '--', ...sources]);
  return paths === '' ? [] : [...new Set(paths.split('\n'))].sort();
}

export function readTextAtRef(root: string, ref: string, path: string, maxBytes: number): string {
  let raw: Buffer;
  try {
    raw = execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: maxBytes + 1,
    });
  } catch (error) {
    throw new QualityGitError(
      `无法读取 ${ref}:${path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw.byteLength > maxBytes) throw new QualityGitError(`${path} 超过读取上限 ${maxBytes} bytes`);
  if (raw.includes(0)) throw new QualityGitError(`${path} 不是文本文件`);
  return raw.toString('utf8');
}

export function readWorkingText(root: string, path: string, maxBytes: number): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new QualityGitError(`${path} 越出项目根`);
  }
  const raw = readFileSync(absolute);
  if (raw.byteLength > maxBytes) throw new QualityGitError(`${path} 超过读取上限 ${maxBytes} bytes`);
  if (raw.includes(0)) throw new QualityGitError(`${path} 不是文本文件`);
  return raw.toString('utf8');
}

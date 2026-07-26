import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const CODE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts']);

function git(root, args, allowFailure = false) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`);
  }
  return result;
}

function nullList(value) {
  return value.split('\0').filter(Boolean);
}

function changedPaths(root, args) {
  return nullList(git(root, [...args, '-z']).stdout);
}

function normalizeLineEndings(value) {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function isCodeFile(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function collectAddedCodeFiles(root, base) {
  git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  const paths = new Set([
    ...changedPaths(root, ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`]),
    ...changedPaths(root, ['diff', '--cached', '--name-only', '--diff-filter=A']),
    ...changedPaths(root, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...paths].filter((path) => isCodeFile(path) && existsSync(resolve(root, path))).sort();
}

function diffWhitespaceIssues(root, base) {
  const commands = [
    ['diff', '--check', `${base}...HEAD`],
    ['diff', '--cached', '--check'],
    ['diff', '--check'],
  ];
  const issues = [];
  for (const args of commands) {
    const result = git(root, args, true);
    if (result.status !== 0) issues.push((result.stdout || result.stderr).trim());
  }
  return issues.filter(Boolean);
}

export async function runFormatGate(options) {
  const root = resolve(options.root);
  const addedFiles = collectAddedCodeFiles(root, options.base);
  const unformatted = [];
  for (const path of addedFiles) {
    const absolute = resolve(root, path);
    const info = await prettier.getFileInfo(absolute);
    if (info.ignored || info.inferredParser === null) continue;
    const source = readFileSync(absolute, 'utf8');
    const config = (await prettier.resolveConfig(absolute)) ?? {};
    const formatted = await prettier.format(source, { ...config, filepath: absolute });
    if (normalizeLineEndings(source) === normalizeLineEndings(formatted)) continue;
    if (options.write) writeFileSync(absolute, formatted);
    else unformatted.push(path);
  }
  return {
    addedFiles,
    unformatted,
    whitespaceIssues: diffWhitespaceIssues(root, options.base),
  };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

async function main() {
  const result = await runFormatGate({
    root: process.cwd(),
    base: argument('--base', 'origin/main'),
    write: process.argv.includes('--write'),
  });
  if (result.unformatted.length > 0) {
    console.error(`新增代码文件未格式化：${result.unformatted.join(', ')}`);
  }
  if (result.whitespaceIssues.length > 0) {
    console.error(result.whitespaceIssues.join('\n'));
  }
  if (result.unformatted.length > 0 || result.whitespaceIssues.length > 0) process.exitCode = 1;
  else console.log(`格式检查通过（新增代码文件 ${result.addedFiles.length} 个）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

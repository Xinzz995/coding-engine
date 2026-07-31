import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  GIT_OUTPUT_LIMIT,
  checkPolicyFiles,
  fail,
  findForbiddenAddedLine,
  scanUntrackedListing,
  type GitResult,
  type TddConfig,
  type TddPolicyResult,
} from './tdd-gate.js';

function runGit(root: string, args: string[]): GitResult {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const diagnostic = (stderr || result.error?.message || stdout).slice(-2000);
  return {
    ok: !result.error && result.status === 0,
    stdout,
    diagnostic,
    exitCode: result.status,
  };
}

/** No-session diagnostic. Formal run/apply-prd must use checkTddPolicyManaged. */
export function checkTddPolicy(config: TddConfig, projectRoot: string): TddPolicyResult {
  const started = Date.now();
  let root: string;
  try {
    root = realpathSync(projectRoot);
  } catch (err) {
    return {
      ok: false,
      failure: fail(
        'project-root-unreadable',
        `项目根不可读：${err instanceof Error ? err.message : String(err)}`,
      ),
      ms: Date.now() - started,
    };
  }

  const prefix = runGit(root, ['rev-parse', '--show-prefix']);
  if (!prefix.ok) {
    return {
      ok: false,
      failure: fail(
        'git-unavailable',
        `TDD 门禁要求 Git 仓库：${prefix.diagnostic}`,
        'git rev-parse',
        prefix.exitCode,
      ),
      ms: Date.now() - started,
    };
  }
  if (prefix.stdout.trim() !== '') {
    const top = runGit(root, ['rev-parse', '--show-toplevel']);
    return {
      ok: false,
      failure: fail(
        'git-root-mismatch',
        `coding-x 必须从 Git 根启动；当前 ${root}，Git 根 ${top.ok ? top.stdout.trim() : '不可读'}`,
      ),
      ms: Date.now() - started,
    };
  }

  const baseline = runGit(root, ['cat-file', '-e', `${config.baselineRef}^{commit}`]);
  if (!baseline.ok) {
    return {
      ok: false,
      failure: fail(
        'baseline-unreachable',
        `TDD baselineRef 不可达：${config.baselineRef}`,
        `git cat-file -e ${config.baselineRef}^{commit}`,
        baseline.exitCode,
      ),
      ms: Date.now() - started,
    };
  }

  const policyFailure = checkPolicyFiles(config, root, started);
  if (policyFailure) return policyFailure;

  const diff = runGit(root, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--unified=0',
    config.baselineRef,
    '--',
    ...config.sourcePathspecs,
  ]);
  if (!diff.ok) {
    return {
      ok: false,
      failure: fail(
        'source-scan-failed',
        `生产代码 diff 扫描失败：${diff.diagnostic}`,
        'git diff <baselineRef> -- <sourcePathspecs>',
        diff.exitCode,
      ),
      ms: Date.now() - started,
    };
  }
  const forbidden = findForbiddenAddedLine(diff.stdout, config.forbiddenAddedPatterns);
  if (forbidden) {
    return {
      ok: false,
      failure: fail('forbidden-pattern-added', forbidden),
      ms: Date.now() - started,
    };
  }
  const untrackedFailure = scanUntrackedListing(
    root,
    config,
    runGit(root, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...config.sourcePathspecs,
    ]),
  );
  if (untrackedFailure) {
    return { ok: false, failure: untrackedFailure, ms: Date.now() - started };
  }

  return { ok: true, failure: null, ms: Date.now() - started };
}

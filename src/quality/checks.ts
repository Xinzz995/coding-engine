import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { runGateCommand, GATE_TIMEOUT_MS } from '../engine/gate.js';
import type { QualityCheck, QualityStatus } from './types.js';

export interface ProjectCheckResult {
  id: string;
  command: string;
  cwd: string;
  applicable: boolean;
  status: QualityStatus;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  diagnosticTail: string;
  errorCode: string | null;
}

export interface ProjectChecksResult {
  status: QualityStatus;
  results: ProjectCheckResult[];
  durationMs: number;
}

function pathMatchesSelector(path: string, selector: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedSelector = selector.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalizedSelector === '.' || normalizedSelector === '') return true;
  if (normalizedSelector.endsWith('/')) return normalizedPath.startsWith(normalizedSelector);
  return normalizedPath === normalizedSelector
    || normalizedPath.startsWith(`${normalizedSelector}/`);
}

export function checkAppliesToChanges(
  check: QualityCheck,
  changedFiles: string[],
): boolean {
  return changedFiles.some((path) =>
    check.paths.some((selector) => pathMatchesSelector(path, selector)));
}

export async function runProjectChecks(
  checks: QualityCheck[],
  root: string,
  timeoutMs = GATE_TIMEOUT_MS,
  changedFiles?: string[],
  env?: NodeJS.ProcessEnv,
): Promise<ProjectChecksResult> {
  const started = Date.now();
  const results: ProjectCheckResult[] = [];
  for (const check of checks) {
    if (changedFiles && !checkAppliesToChanges(check, changedFiles)) {
      results.push({
        id: check.id,
        command: check.command,
        cwd: check.cwd,
        applicable: false,
        status: 'passed',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        diagnosticTail: '当前改动未命中该检查的适用路径',
        errorCode: null,
      });
      continue;
    }
    const cwd = resolve(root, check.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      results.push({
        id: check.id,
        command: check.command,
        cwd: check.cwd,
        applicable: true,
        status: 'unverifiable',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        diagnosticTail: `工作目录不存在：${check.cwd}`,
        errorCode: 'check-cwd-missing',
      });
      return { status: 'unverifiable', results, durationMs: Date.now() - started };
    }
    const checkStarted = Date.now();
    let failure;
    try {
      failure = await runGateCommand(check.command, cwd, timeoutMs, env);
    } catch (error) {
      results.push({
        id: check.id,
        command: check.command,
        cwd: check.cwd,
        applicable: true,
        status: 'unverifiable',
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - checkStarted,
        diagnosticTail: error instanceof Error ? error.message : String(error),
        errorCode: 'check-runner-error',
      });
      return { status: 'unverifiable', results, durationMs: Date.now() - started };
    }
    if (failure === null) {
      results.push({
        id: check.id,
        command: check.command,
        cwd: check.cwd,
        applicable: true,
        status: 'passed',
        exitCode: 0,
        timedOut: false,
        durationMs: Date.now() - checkStarted,
        diagnosticTail: '',
        errorCode: null,
      });
      continue;
    }
    const status: QualityStatus = failure.exitCode === null && !failure.timedOut
      ? 'unverifiable'
      : 'failed';
    results.push({
      id: check.id,
      command: check.command,
      cwd: check.cwd,
      applicable: true,
      status,
      exitCode: failure.exitCode,
      timedOut: failure.timedOut,
      durationMs: Date.now() - checkStarted,
      diagnosticTail: failure.outputTail,
      errorCode: status === 'unverifiable' ? 'check-spawn-error' : null,
    });
    return { status, results, durationMs: Date.now() - started };
  }
  return { status: 'passed', results, durationMs: Date.now() - started };
}

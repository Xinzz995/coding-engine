#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 600_000;
const TERMINATION_GRACE_MS = 5000;
const TERMINATION_CONFIRM_MS = 5000;
const PROCESS_GROUP_POLL_MS = 25;
const CONFIG_KEYS = [
  'coverageCheck',
  'sourcePathspecs',
  'policyFiles',
  'baselineRef',
  'forbiddenAddedPatterns',
];
const POLICY_FILE_KEYS = ['path', 'sha256'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && wanted.every((key, index) => actual[index] === key);
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\0\r\n]/.test(value);
}

function hasParentSegment(path) {
  return path.split(/[\\/]/).includes('..');
}

function pathspecBody(pathspec) {
  if (!pathspec.startsWith(':')) return pathspec;
  if (!pathspec.startsWith(':(')) return null;
  const close = pathspec.indexOf(')');
  if (close < 3) return null;
  const magic = pathspec.slice(2, close).split(',').map((part) => part.trim());
  if (magic.length === 0 || magic.some((part) => !['glob', 'top', 'literal'].includes(part))) {
    return null;
  }
  return pathspec.slice(close + 1);
}

function isSafeSourcePathspec(value) {
  if (!isNonBlankString(value)) return false;
  const body = pathspecBody(value);
  return Boolean(body)
    && !isAbsolute(body)
    && !win32.isAbsolute(body)
    && !hasParentSegment(body)
    && !body.startsWith('!')
    && !body.startsWith('^')
    && !body.includes('\\');
}

function isSafePolicyPath(value) {
  return isNonBlankString(value)
    && value !== '.'
    && !isAbsolute(value)
    && !win32.isAbsolute(value)
    && !hasParentSegment(value)
    && !value.includes('\\');
}

function uniqueStrings(value, validate, caseInsensitive = false) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set();
  const output = [];
  for (const item of value) {
    if (!validate(item)) return null;
    const key = caseInsensitive ? item.toLowerCase() : item;
    if (seen.has(key)) return null;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function parseConfig(raw) {
  if (!isRecord(raw) || !hasExactKeys(raw, CONFIG_KEYS)) {
    return { ok: false, error: `tdd 必须只包含 ${CONFIG_KEYS.join('、')}` };
  }
  if (!isNonBlankString(raw.coverageCheck)) {
    return { ok: false, error: 'tdd.coverageCheck 必须是非空单行命令' };
  }
  const sourcePathspecs = uniqueStrings(raw.sourcePathspecs, isSafeSourcePathspec);
  if (!sourcePathspecs) return { ok: false, error: 'tdd.sourcePathspecs 非法' };
  if (!Array.isArray(raw.policyFiles)) return { ok: false, error: 'tdd.policyFiles 必须是数组' };
  const policyFiles = [];
  const policyPaths = new Set();
  for (const item of raw.policyFiles) {
    if (!isRecord(item) || !hasExactKeys(item, POLICY_FILE_KEYS)
        || !isSafePolicyPath(item.path)
        || typeof item.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(item.sha256)
        || policyPaths.has(item.path)) {
      return { ok: false, error: 'tdd.policyFiles 含非法或重复项' };
    }
    policyPaths.add(item.path);
    policyFiles.push({ path: item.path, sha256: item.sha256 });
  }
  if (typeof raw.baselineRef !== 'string'
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.baselineRef)) {
    return { ok: false, error: 'tdd.baselineRef 必须是完整 Git commit id' };
  }
  const forbiddenAddedPatterns = uniqueStrings(
    raw.forbiddenAddedPatterns,
    isNonBlankString,
    true,
  );
  if (!forbiddenAddedPatterns) return { ok: false, error: 'tdd.forbiddenAddedPatterns 非法' };
  return {
    ok: true,
    config: {
      coverageCheck: raw.coverageCheck,
      sourcePathspecs,
      policyFiles,
      baselineRef: raw.baselineRef,
      forbiddenAddedPatterns,
    },
  };
}

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    diagnostic: (result.stderr || result.error?.message || result.stdout || '')
      .slice(-MAX_DIAGNOSTIC_CHARS),
  };
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function findForbiddenAddedLine(diff, patterns) {
  const lowered = patterns.map((pattern) => pattern.toLowerCase());
  let file = 'unknown';
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    const index = lowered.findIndex((pattern) => added.toLowerCase().includes(pattern));
    if (index >= 0) {
      return `${file}: 新增了禁止的覆盖忽略标记 “${patterns[index]}”\n${added}`;
    }
  }
  return null;
}

function checkPolicy(config, root) {
  const baseline = runGit(root, ['cat-file', '-e', `${config.baselineRef}^{commit}`]);
  if (!baseline.ok) return { ok: false, error: `baselineRef 不可达：${config.baselineRef}` };

  const targets = new Set();
  for (const policy of config.policyFiles) {
    const lexical = resolve(root, policy.path);
    if (!isInside(root, lexical)) return { ok: false, error: `政策文件越出项目根：${policy.path}` };
    let real;
    let actual;
    try {
      real = realpathSync(lexical);
      if (!isInside(root, real)) {
        return { ok: false, error: `政策文件 realpath 越出项目根：${policy.path}` };
      }
      if (targets.has(real)) return { ok: false, error: `多个政策路径指向同一文件：${policy.path}` };
      targets.add(real);
      actual = createHash('sha256').update(readFileSync(real)).digest('hex');
    } catch (error) {
      return {
        ok: false,
        error: `政策文件不可用 ${policy.path}：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (actual !== policy.sha256) {
      return {
        ok: false,
        error: `政策文件摘要变化：${policy.path}（expected ${policy.sha256}, received ${actual}）`,
      };
    }
  }

  const diff = runGit(root, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--unified=0',
    config.baselineRef,
    '--',
    ...config.sourcePathspecs,
  ]);
  if (!diff.ok) return { ok: false, error: `生产代码 diff 扫描失败：${diff.diagnostic}` };
  const forbidden = findForbiddenAddedLine(diff.stdout, config.forbiddenAddedPatterns);
  if (forbidden) return { ok: false, error: forbidden };

  const untracked = runGit(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...config.sourcePathspecs,
  ]);
  if (!untracked.ok) return { ok: false, error: `未跟踪生产文件扫描失败：${untracked.diagnostic}` };
  const lowered = config.forbiddenAddedPatterns.map((pattern) => pattern.toLowerCase());
  for (const path of untracked.stdout.split('\0').filter(Boolean)) {
    let real;
    let content;
    try {
      real = realpathSync(resolve(root, path));
      if (!isInside(root, real)) return { ok: false, error: `未跟踪生产文件越出项目根：${path}` };
      content = readFileSync(real, 'utf8');
    } catch (error) {
      return {
        ok: false,
        error: `无法读取未跟踪生产文件 ${path}：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    for (const line of content.split(/\r?\n/)) {
      const index = lowered.findIndex((pattern) => line.toLowerCase().includes(pattern));
      if (index >= 0) {
        return {
          ok: false,
          error: `${path}: 新增了禁止的覆盖忽略标记 “${config.forbiddenAddedPatterns[index]}”\n${line}`,
        };
      }
    }
  }
  return { ok: true };
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveResult) => {
    const probe = () => {
      if (!isProcessGroupAlive(pid)) return resolveResult(true);
      if (Date.now() >= deadline) return resolveResult(false);
      setTimeout(probe, PROCESS_GROUP_POLL_MS);
    };
    probe();
  });
}

async function terminateTree(child) {
  if (!child.pid) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: TERMINATION_CONFIRM_MS,
    });
    if (result.status !== 0) throw new Error(`taskkill 退出码 ${result.status}`);
    return;
  }
  signalProcessGroup(child.pid, 'SIGTERM');
  if (await waitForProcessGroupExit(child.pid, TERMINATION_GRACE_MS)) return;
  signalProcessGroup(child.pid, 'SIGKILL');
  if (!await waitForProcessGroupExit(child.pid, TERMINATION_CONFIRM_MS)) {
    throw new Error(`进程组 ${child.pid} 在 SIGKILL 后仍未确认退出`);
  }
}

function forceKillTreeOnExit(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: TERMINATION_CONFIRM_MS,
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
}

function runCoverage(command, root, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd: root,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let tail = '';
    const keep = (chunk) => {
      tail = (tail + String(chunk)).slice(-MAX_DIAGNOSTIC_CHARS);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let settled = false;
    let terminating = false;
    const killOnExit = () => forceKillTreeOnExit(child);
    process.once('exit', killOnExit);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      process.removeListener('exit', killOnExit);
      resolveResult({ ...result, outputTail: tail });
    };
    const timeoutTimer = setTimeout(() => {
      terminating = true;
      void terminateTree(child).then(
        () => finish({ ok: false, timedOut: true, exitCode: null }),
        (error) => {
          keep(error instanceof Error ? error.message : String(error));
          finish({ ok: false, timedOut: true, exitCode: null });
        },
      );
    }, timeoutMs);
    child.once('close', (code) => {
      if (terminating) return;
      finish({ ok: code === 0, timedOut: false, exitCode: code });
    });
    child.once('error', (error) => {
      if (terminating) return;
      keep(error.message);
      finish({ ok: false, timedOut: false, exitCode: null });
    });
  });
}

function looksLikeCommit(command) {
  return /\bgit(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+))*\s+commit(?=\s|$)/i
    .test(command);
}

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) {
      return raw.slice(-MAX_INPUT_BYTES);
    }
  }
  return raw;
}

function hookCommand(payload) {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.tool_input) && typeof payload.tool_input.command === 'string') {
    return payload.tool_input.command;
  }
  return typeof payload.command === 'string' ? payload.command : null;
}

function hookCwd(payload) {
  if (isRecord(payload) && typeof payload.cwd === 'string' && payload.cwd.trim()) return payload.cwd;
  if (isRecord(payload) && isRecord(payload.tool_input)
      && typeof payload.tool_input.cwd === 'string' && payload.tool_input.cwd.trim()) {
    return payload.tool_input.cwd;
  }
  return process.cwd();
}

function isCursorHookPayload(payload) {
  return isRecord(payload)
    && (payload.hook_event_name === 'beforeShellExecution'
      || (typeof payload.command === 'string' && !isRecord(payload.tool_input)));
}

function allow(cursorPayload) {
  if (cursorPayload) process.stdout.write('{"permission":"allow"}\n');
  return 0;
}

function block(message) {
  process.stderr.write(`❌ TDD commit hook：${String(message).slice(-MAX_DIAGNOSTIC_CHARS)}\n`);
  return 2;
}

async function main() {
  const raw = await readInput();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return looksLikeCommit(raw)
      ? block('hook 输入无法解析，commit-like 调用按 fail-closed 阻断')
      : 0;
  }
  const cursorPayload = isCursorHookPayload(payload);
  const command = hookCommand(payload);
  if (!command || !looksLikeCommit(command)) return allow(cursorPayload);

  const top = runGit(hookCwd(payload), ['rev-parse', '--show-toplevel']);
  if (!top.ok) return allow(cursorPayload);
  let root;
  try {
    root = realpathSync(top.stdout.trim());
  } catch {
    return allow(cursorPayload);
  }

  let workspace = join(root, '.workspace');
  const injectedRoot = process.env.CODING_X_PROJECT_ROOT;
  const injectedWorkspace = process.env.CODING_X_WORKSPACE;
  if (injectedRoot && injectedWorkspace && isAbsolute(injectedWorkspace)) {
    try {
      if (realpathSync(injectedRoot) === root) workspace = injectedWorkspace;
    } catch {
      // 环境来自其他项目或已失效时只回退当前 Git 根，不跨项目误读。
    }
  }

  const prdPath = join(workspace, 'prd.json');
  let prd;
  try {
    prd = JSON.parse(readFileSync(prdPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return allow(cursorPayload);
    return block(`无法读取 ${prdPath}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(prd) || !Object.prototype.hasOwnProperty.call(prd, 'tdd')) {
    return allow(cursorPayload);
  }
  const parsed = parseConfig(prd.tdd);
  if (!parsed.ok) return block(parsed.error);

  const policy = checkPolicy(parsed.config, root);
  if (!policy.ok) return block(policy.error);

  const configuredTimeout = Number(process.env.CODING_X_TDD_HOOK_TIMEOUT_MS);
  const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
  const result = await runCoverage(parsed.config.coverageCheck, root, timeoutMs);
  if (result.ok) return allow(cursorPayload);
  const reason = result.timedOut
    ? `覆盖率命令超时（${timeoutMs}ms）`
    : `覆盖率命令退出码 ${result.exitCode}`;
  return block(`${reason}\n${result.outputTail || parsed.config.coverageCheck}`);
}

process.exitCode = await main();

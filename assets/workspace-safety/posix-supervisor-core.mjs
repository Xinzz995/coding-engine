import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const corePath = fileURLToPath(import.meta.url);
const MAX_CONTROL_BYTES = 64 * 1024;
// Canonical base64 expands a bounded control message by 4/3. Keep the generic IPC event-string
// bound small, but give encoded control bytes their exact derived budget; otherwise ordinary CI
// environments can fit the decoded DATA contract while being rejected before decoding.
const MAX_CONTROL_BASE64_CHARS = Math.ceil(MAX_CONTROL_BYTES / 3) * 4;
const MAX_BASELINE_BYTES = 64 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export function helperBundleBytes(supervisorPath, launcherPath) {
  const supervisorBytes = readStableFile(supervisorPath, MAX_CONTROL_BYTES * 16);
  const coreBytes = readStableFile(corePath, MAX_CONTROL_BYTES * 16);
  const launcherBytes = readStableFile(launcherPath, MAX_CONTROL_BYTES * 16);
  return Buffer.concat([
    Buffer.from('coding-x-posix-supervisor-v1\0', 'utf8'),
    supervisorBytes,
    Buffer.from('\0coding-x-posix-supervisor-core-v1\0', 'utf8'),
    coreBytes,
    Buffer.from('\0coding-x-posix-launcher-v1\0', 'utf8'),
    launcherBytes,
  ]);
}

export function exactKeys(value, expected) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

export function boundedString(value, name, allowEmpty = false) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > 16_384 ||
    value.includes('\0')
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function parseTimeouts(value) {
  const parsed = JSON.parse(value);
  if (
    !exactKeys(parsed, ['handshakeMs', 'naturalDrainMs', 'termMs', 'killMs', 'ackMs', 'pollMs'])
  ) {
    throw new Error('invalid POSIX supervisor timeouts');
  }
  return {
    handshakeMs: boundedInteger(parsed.handshakeMs, 'handshakeMs', 10, 60_000),
    naturalDrainMs: boundedInteger(parsed.naturalDrainMs, 'naturalDrainMs', 0, 60_000),
    termMs: boundedInteger(parsed.termMs, 'termMs', 0, 60_000),
    killMs: boundedInteger(parsed.killMs, 'killMs', 1, 60_000),
    ackMs: boundedInteger(parsed.ackMs, 'ackMs', 10, 60_000),
    pollMs: boundedInteger(parsed.pollMs, 'pollMs', 1, 1000),
  };
}

export function readStableFile(path, maximumBytes) {
  let descriptor;
  try {
    // Open first and keep this inode alive. O_NOFOLLOW rejects a final symlink and O_NONBLOCK
    // keeps a raced or pre-existing FIFO from waiting for a writer before fstat can reject it.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(maximumBytes)) {
      throw new Error('not an ordinary bounded single-link file');
    }
    const openedPath = lstatSync(path, { bigint: true });
    if (
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      openedPath.nlink !== 1n ||
      opened.dev !== openedPath.dev ||
      opened.ino !== openedPath.ino ||
      opened.nlink !== openedPath.nlink ||
      opened.size !== openedPath.size ||
      opened.mtimeNs !== openedPath.mtimeNs ||
      opened.ctimeNs !== openedPath.ctimeNs
    ) {
      throw new Error('file identity changed after open');
    }
    const bytes = readFileSync(descriptor);
    const afterHandle = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterHandle.nlink !== 1n ||
      afterPath.nlink !== 1n ||
      opened.dev !== afterHandle.dev ||
      opened.ino !== afterHandle.ino ||
      opened.nlink !== afterHandle.nlink ||
      opened.size !== afterHandle.size ||
      opened.mtimeNs !== afterHandle.mtimeNs ||
      opened.ctimeNs !== afterHandle.ctimeNs ||
      afterHandle.dev !== afterPath.dev ||
      afterHandle.ino !== afterPath.ino ||
      afterHandle.nlink !== afterPath.nlink ||
      afterHandle.size !== afterPath.size ||
      afterHandle.mtimeNs !== afterPath.mtimeNs ||
      afterHandle.ctimeNs !== afterPath.ctimeNs ||
      afterHandle.size > BigInt(maximumBytes) ||
      BigInt(bytes.length) !== afterHandle.size
    ) {
      throw new Error('file changed during read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readAuthorityFiles(workspacePath) {
  const operationPath = join(workspacePath, 'engine.lock', 'lease', 'operation');
  const paths = {
    marker: [join(workspacePath, 'workspace-safety.json'), MAX_CONTROL_BYTES],
    owner: [join(workspacePath, 'engine.lock', 'lease', 'owner.json'), MAX_CONTROL_BYTES],
    protocol: [join(workspacePath, 'engine.lock', 'protocol.json'), MAX_CONTROL_BYTES],
    active: [join(operationPath, 'active-child.json'), MAX_CONTROL_BYTES],
    baseline: [join(operationPath, 'delegated-baseline.json'), MAX_BASELINE_BYTES],
  };
  const first = Object.fromEntries(
    Object.entries(paths).map(([name, [path, maximum]]) => [name, readStableFile(path, maximum)]),
  );
  const second = Object.fromEntries(
    Object.entries(paths).map(([name, [path, maximum]]) => [name, readStableFile(path, maximum)]),
  );
  for (const name of Object.keys(first)) {
    if (!first[name].equals(second[name])) throw new Error(`canonical ${name} changed during read`);
  }
  return { operationPath, ...second };
}

class JsonShapeScanner {
  index = 0;

  constructor(text) {
    this.text = text;
  }

  scan() {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new Error('trailing JSON input');
  }

  scanValue() {
    const character = this.text[this.index];
    if (character === '{') return this.scanObject();
    if (character === '[') return this.scanArray();
    if (character === '"') return void this.scanString();
    if (character === 't') return this.scanLiteral('true');
    if (character === 'f') return this.scanLiteral('false');
    if (character === 'n') return this.scanLiteral('null');
    this.scanNumber();
  }

  scanObject() {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume('}')) return;
    const keys = new Set();
    while (true) {
      if (this.text[this.index] !== '"') throw new Error('object key must be a string');
      const key = this.scanString();
      if (keys.has(key)) throw new Error('duplicate JSON key');
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      this.scanValue();
      this.skipWhitespace();
      if (this.consume('}')) return;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  scanArray() {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume(']')) return;
    while (true) {
      this.scanValue();
      this.skipWhitespace();
      if (this.consume(']')) return;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  scanString() {
    const start = this.index;
    this.expect('"');
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (character === '"') return JSON.parse(this.text.slice(start, this.index));
      if (character === '\\') {
        const escape = this.text[this.index++];
        if (escape === 'u') {
          const codePoint = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(codePoint)) throw new Error('invalid unicode escape');
          this.index += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
          throw new Error('invalid string escape');
        }
      } else if (!character || character.charCodeAt(0) < 0x20) {
        throw new Error('invalid string character');
      }
    }
    throw new Error('unterminated string');
  }

  scanLiteral(literal) {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      throw new Error('invalid literal');
    }
    this.index += literal.length;
  }

  scanNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.text.slice(this.index));
    if (!match) throw new Error('invalid JSON value');
    this.index += match[0].length;
  }

  skipWhitespace() {
    while (/\s/u.test(this.text[this.index] ?? '')) this.index += 1;
  }

  consume(character) {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  expect(character) {
    if (!this.consume(character)) throw new Error(`expected ${character}`);
  }
}

export function assertWellFormedUnicode(value, name) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error(`${name} has unpaired surrogate`);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${name} has unpaired surrogate`);
    }
  }
}

export function parseJson(bytes, name) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${name} contains a BOM`);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  new JsonShapeScanner(text).scan();
  const value = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not an object`);
  }
  const visit = (entry) => {
    if (typeof entry === 'string') assertWellFormedUnicode(entry, name);
    else if (Array.isArray(entry)) entry.forEach(visit);
    else if (typeof entry === 'object' && entry !== null) Object.values(entry).forEach(visit);
  };
  visit(value);
  return value;
}

export function linuxStat(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 2) throw new Error('invalid Linux process stat');
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  if (!fields[19] || !/^\d+$/u.test(fields[19])) throw new Error('invalid Linux start time');
  return {
    state: fields[0],
    pgid: Number(fields[2]),
    sessionId: Number(fields[3]),
    identity: fields[19],
  };
}

export function command(commandPath, args) {
  const result = spawnSync(commandPath, args, {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    timeout: 5000,
  });
  if (result.error || result.status !== 0) throw new Error(`platform probe failed: ${commandPath}`);
  return result.stdout.trim();
}

export function processIdentity(pid) {
  if (process.platform === 'linux') return linuxStat(pid).identity;
  if (process.platform === 'darwin') {
    const value = command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']).replace(/\s+/gu, ' ');
    if (!value) throw new Error('macOS process identity is unavailable');
    return value;
  }
  throw new Error('unsupported POSIX identity platform');
}

export function processIds(pid) {
  if (process.platform === 'linux') {
    const stat = linuxStat(pid);
    return { pgid: stat.pgid, sessionId: stat.sessionId };
  }
  if (process.platform === 'darwin') {
    const output = command('/usr/bin/ruby', [
      '-e',
      'print "#{Process.getsid(ARGV[0].to_i)} #{Process.getpgid(ARGV[0].to_i)}"',
      String(pid),
    ]);
    const [sessionId, pgid] = output.split(/\s+/u).map(Number);
    if (!Number.isSafeInteger(sessionId) || !Number.isSafeInteger(pgid)) {
      throw new Error('invalid macOS process group identity');
    }
    return { pgid, sessionId };
  }
  throw new Error('unsupported POSIX process group platform');
}

export function groupMembers(pgid) {
  if (process.platform === 'linux') {
    const members = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue;
      try {
        if (linuxStat(Number(name)).pgid === pgid) members.push(Number(name));
      } catch {
        // A process may disappear between directory enumeration and stat read.
      }
    }
    return members.sort((left, right) => left - right);
  }
  if (process.platform === 'darwin') {
    return command('/bin/ps', ['-axo', 'pid=,pgid='])
      .split('\n')
      .map((line) => line.trim().split(/\s+/u).map(Number))
      .filter(([pid, group]) => Number.isSafeInteger(pid) && group === pgid)
      .map(([pid]) => pid)
      .sort((left, right) => left - right);
  }
  throw new Error('unsupported POSIX process group platform');
}

export function probeGroup(pgid) {
  try {
    process.kill(-pgid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'empty';
    if (error?.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function monotonicNow() {
  return performance.now();
}

export function deadlineAfter(timeoutMs) {
  return monotonicNow() + timeoutMs;
}

export function remainingDeadlineMs(deadline) {
  return Math.max(0, Math.ceil(deadline - monotonicNow()));
}

export async function waitUntilDeadline(predicate, deadline, pollMs = 25) {
  do {
    if (predicate()) return true;
    const remaining = remainingDeadlineMs(deadline);
    if (remaining === 0) return false;
    await delay(Math.min(pollMs, remaining));
  } while (true);
}

export async function waitUntil(predicate, timeoutMs, pollMs = 25) {
  return waitUntilDeadline(predicate, deadlineAfter(timeoutMs), pollMs);
}

export function parseTarget(value) {
  if (!exactKeys(value, ['executable', 'args', 'cwd', 'environment'])) {
    throw new Error('target has unknown or missing fields');
  }
  const executable = boundedString(value.executable, 'target executable');
  const cwd = boundedString(value.cwd, 'target cwd');
  if (!isAbsolute(executable) || !isAbsolute(cwd)) {
    throw new Error('target executable and cwd must be absolute');
  }
  if (!Array.isArray(value.args) || value.args.length > 256) throw new Error('target args invalid');
  if (!Array.isArray(value.environment) || value.environment.length > 256) {
    throw new Error('target environment invalid');
  }
  const names = new Set();
  const environment = value.environment.map((entry) => {
    if (!exactKeys(entry, ['name', 'value'])) throw new Error('target environment entry invalid');
    const name = boundedString(entry.name, 'environment name');
    const environmentValue = boundedString(entry.value, 'environment value', true);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || names.has(name)) {
      throw new Error('target environment name invalid');
    }
    names.add(name);
    return { name, value: environmentValue };
  });
  return {
    executable,
    cwd,
    args: value.args.map((argument) => boundedString(argument, 'target argument', true)),
    environment,
  };
}

export function parseControlBytes(encoded, expectedType) {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > MAX_CONTROL_BASE64_CHARS ||
    encoded.includes('\0')
  ) {
    throw new Error(`${expectedType} bytes are invalid`);
  }
  const value = encoded;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_CONTROL_BYTES || bytes.toString('base64') !== value) {
    throw new Error(`${expectedType} bytes are invalid`);
  }
  const message = parseJson(bytes, expectedType);
  if (message.schemaVersion !== 1 || message.type !== expectedType) {
    throw new Error(`${expectedType} message is invalid`);
  }
  return message;
}

export function requireExactKeys(value, expected, name) {
  if (!exactKeys(value, expected)) throw new Error(`${name} has unknown or missing fields`);
}

export function requirePattern(value, pattern, name) {
  const parsed = boundedString(value, name);
  if (!pattern.test(parsed)) throw new Error(`${name} has invalid format`);
  return parsed;
}

export function requireTimestamp(value, name) {
  const parsed = requirePattern(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, name);
  if (new Date(Date.parse(parsed)).toISOString() !== parsed) throw new Error(`${name} is invalid`);
  return parsed;
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value !== 'object') throw new Error('canonical JSON contains an unsupported value');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function validateRelativePath(value, name) {
  const path = boundedString(value, name);
  if (
    Buffer.byteLength(path, 'utf8') > 4096 ||
    path !== path.normalize('NFC') ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    path === 'engine.lock' ||
    path.startsWith('engine.lock/')
  ) {
    throw new Error(`${name} is not a canonical delegated path`);
  }
  return path;
}

export function validateSemanticContract(semantic) {
  if (semantic?.version === 'read-only-v1') {
    requireExactKeys(semantic, ['version'], 'read-only semantic contract');
    return semantic;
  }
  if (semantic?.version === 'builder-state-v1') {
    requireExactKeys(
      semantic,
      ['version', 'storyId', 'acceptanceHash', 'checkCount'],
      'builder semantic contract',
    );
    const storyId = boundedString(semantic.storyId, 'builder semantic storyId');
    if (storyId.length > 4096) throw new Error('builder semantic storyId is too large');
    requirePattern(semantic.acceptanceHash, DIGEST_PATTERN, 'builder semantic acceptanceHash');
    boundedInteger(semantic.checkCount, 'builder semantic checkCount', 0, Number.MAX_SAFE_INTEGER);
    return semantic;
  }
  if (semantic?.version === 'validator-result-v1') {
    requireExactKeys(
      semantic,
      ['version', 'requestId', 'storyId', 'acceptanceHash', 'checkCount', 'gitHead'],
      'validator semantic contract',
    );
    requirePattern(semantic.requestId, UUID_PATTERN, 'validator semantic requestId');
    const storyId = boundedString(semantic.storyId, 'validator semantic storyId');
    if (storyId.length > 4096) throw new Error('validator semantic storyId is too large');
    requirePattern(semantic.acceptanceHash, DIGEST_PATTERN, 'validator semantic acceptanceHash');
    boundedInteger(
      semantic.checkCount,
      'validator semantic checkCount',
      0,
      Number.MAX_SAFE_INTEGER,
    );
    requirePattern(semantic.gitHead, GIT_HEAD_PATTERN, 'validator semantic gitHead');
    return semantic;
  }
  throw new Error('delegation semantic contract version is invalid');
}

export function validateContract(contract) {
  requireExactKeys(contract, ['version', 'semantic', 'rules'], 'delegation contract');
  boundedString(contract.version, 'delegation contract version');
  validateSemanticContract(contract.semantic);
  if (!Array.isArray(contract.rules) || contract.rules.length > 256) {
    throw new Error('delegation contract rules are invalid');
  }
  let previous;
  for (const [index, rule] of contract.rules.entries()) {
    const hasPointers = Object.hasOwn(rule, 'mutableJsonPointers');
    requireExactKeys(
      rule,
      hasPointers
        ? ['path', 'semantics', 'allow', 'mutableJsonPointers']
        : ['path', 'semantics', 'allow'],
      `delegation rule ${index}`,
    );
    const path = validateRelativePath(rule.path, `delegation rule ${index} path`);
    if (previous !== undefined && previous >= path) {
      throw new Error('delegation rules are not strictly sorted');
    }
    previous = path;
    if (
      !['whole-file', 'append-only', 'json-mutable-pointers', 'add-only-directory'].includes(
        rule.semantics,
      ) ||
      !Array.isArray(rule.allow) ||
      rule.allow.length > 3 ||
      new Set(rule.allow).size !== rule.allow.length ||
      rule.allow.some((action) => !['create', 'modify', 'delete'].includes(action))
    ) {
      throw new Error(`delegation rule ${index} is invalid`);
    }
    if (rule.semantics === 'json-mutable-pointers') {
      if (
        !hasPointers ||
        !Array.isArray(rule.mutableJsonPointers) ||
        rule.mutableJsonPointers.length > 256 ||
        new Set(rule.mutableJsonPointers).size !== rule.mutableJsonPointers.length ||
        rule.mutableJsonPointers.some(
          (pointer) =>
            typeof pointer !== 'string' ||
            Buffer.byteLength(pointer, 'utf8') > 512 ||
            (pointer !== '' && !pointer.startsWith('/')),
        )
      ) {
        throw new Error(`delegation rule ${index} JSON pointers are invalid`);
      }
    } else if (hasPointers) {
      throw new Error(`delegation rule ${index} has unexpected JSON pointers`);
    }
  }
  return contract;
}

export function validateBaseline(value) {
  requireExactKeys(
    value,
    [
      'schemaVersion',
      'ownerId',
      'operationId',
      'workspaceIdentity',
      'contract',
      'contractDigest',
      'entries',
      'capturedAt',
      'manifestDigest',
    ],
    'delegated baseline',
  );
  if (value.schemaVersion !== 1) throw new Error('delegated baseline version is invalid');
  requirePattern(value.ownerId, UUID_PATTERN, 'baseline ownerId');
  requirePattern(value.operationId, UUID_PATTERN, 'baseline operationId');
  requirePattern(value.workspaceIdentity, DIGEST_PATTERN, 'baseline workspaceIdentity');
  const contract = validateContract(value.contract);
  const contractDigest = requirePattern(value.contractDigest, DIGEST_PATTERN, 'contractDigest');
  if (contractDigest !== digestBytes(canonicalJson(contract))) {
    throw new Error('delegation contract digest mismatch');
  }
  if (!Array.isArray(value.entries) || value.entries.length > 100_000) {
    throw new Error('delegated baseline entries are invalid');
  }
  let previous;
  for (const [index, entry] of value.entries.entries()) {
    const file = entry?.type === 'file';
    const projection = Object.hasOwn(entry ?? {}, 'protectedProjectionDigest');
    requireExactKeys(
      entry,
      file
        ? projection
          ? ['path', 'type', 'bytes', 'digest', 'protectedProjectionDigest']
          : ['path', 'type', 'bytes', 'digest']
        : ['path', 'type', 'digest'],
      `baseline entry ${index}`,
    );
    if (entry.type !== 'file' && entry.type !== 'directory') {
      throw new Error(`baseline entry ${index} type is invalid`);
    }
    const path = validateRelativePath(entry.path, `baseline entry ${index} path`);
    if (previous !== undefined && previous >= path) {
      throw new Error('baseline entries are not strictly sorted');
    }
    previous = path;
    requirePattern(entry.digest, DIGEST_PATTERN, `baseline entry ${index} digest`);
    if (file && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) {
      throw new Error(`baseline entry ${index} byte count is invalid`);
    }
    if (projection) {
      requirePattern(
        entry.protectedProjectionDigest,
        DIGEST_PATTERN,
        `baseline entry ${index} projection`,
      );
    }
  }
  requireTimestamp(value.capturedAt, 'baseline capturedAt');
  const manifestDigest = requirePattern(value.manifestDigest, DIGEST_PATTERN, 'manifestDigest');
  const { manifestDigest: _manifestDigest, ...partial } = value;
  if (manifestDigest !== digestBytes(canonicalJson(partial))) {
    throw new Error('delegated baseline manifest digest mismatch');
  }
  return value;
}

export function canonicalWorkspaceIdentity(path) {
  const canonical = realpathSync(path);
  if (canonical !== path) throw new Error('workspace path is not canonical');
  const info = statSync(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error('workspace is not an ordinary directory');
  return digestBytes(
    Buffer.from(`${canonical}\0${info.dev.toString()}\0${info.ino.toString()}`, 'utf8'),
  );
}

export function validateCoreAuthority(authority, workspacePath) {
  const marker = parseJson(authority.marker, 'workspace marker');
  const owner = parseJson(authority.owner, 'owner');
  const protocol = parseJson(authority.protocol, 'protocol');
  requireExactKeys(
    marker,
    ['schemaVersion', 'initializedBy', 'workspaceIdentity', 'protocolDigest', 'initializedAt'],
    'workspace marker',
  );
  requireExactKeys(
    protocol,
    ['schemaVersion', 'protocol', 'workspaceIdentity', 'createdBy', 'createdAt'],
    'protocol',
  );
  requireExactKeys(
    owner,
    [
      'schemaVersion',
      'ownerId',
      'pid',
      'processIdentity',
      'bootIdentity',
      'hostId',
      'workspaceIdentity',
      'startedAt',
      'command',
    ],
    'owner',
  );
  requireExactKeys(owner.processIdentity, ['kind', 'value'], 'owner process identity');
  const workspaceIdentity = canonicalWorkspaceIdentity(workspacePath);
  if (
    marker.schemaVersion !== 2 ||
    marker.initializedBy !== '0.34.0' ||
    protocol.schemaVersion !== 1 ||
    protocol.protocol !== 'coding-x-workspace-lease-v1' ||
    protocol.createdBy !== '0.34.0' ||
    owner.schemaVersion !== 2 ||
    !['linux-boot-start', 'macos-boot-start'].includes(owner.processIdentity.kind) ||
    !['workspace-init', 'run', 'repair', 'report', 'apply-prd', 'review-decision'].includes(
      owner.command,
    ) ||
    marker.workspaceIdentity !== workspaceIdentity ||
    protocol.workspaceIdentity !== workspaceIdentity ||
    owner.workspaceIdentity !== workspaceIdentity ||
    marker.protocolDigest !== digestBytes(authority.protocol)
  ) {
    throw new Error('workspace marker/protocol/owner binding mismatch');
  }
  requirePattern(marker.protocolDigest, DIGEST_PATTERN, 'marker protocol digest');
  requirePattern(owner.ownerId, UUID_PATTERN, 'ownerId');
  boundedInteger(owner.pid, 'owner pid', 1, 0xffff_ffff);
  boundedString(owner.processIdentity.value, 'owner process identity value');
  requirePattern(owner.bootIdentity, DIGEST_PATTERN, 'owner boot identity');
  requirePattern(owner.hostId, DIGEST_PATTERN, 'owner host identity');
  requireTimestamp(marker.initializedAt, 'marker initializedAt');
  requireTimestamp(protocol.createdAt, 'protocol createdAt');
  requireTimestamp(owner.startedAt, 'owner startedAt');
  return { marker, owner, protocol };
}

export function assertPreparedBoundAuthority(context) {
  const { workspacePath, operationId, supervisorPath, launcherPath } = context;
  const authority = readAuthorityFiles(workspacePath);
  const { owner } = validateCoreAuthority(authority, workspacePath);
  const active = parseJson(authority.active, 'prepared-bound active-child');
  const baseline = validateBaseline(parseJson(authority.baseline, 'delegated baseline'));
  requireExactKeys(
    active,
    [
      'schemaVersion',
      'ownerId',
      'operationId',
      'state',
      'kind',
      'delegation',
      'platform',
      'helperDigest',
      'delegatedBaselineDigest',
      'delegationContractDigest',
      'startedAt',
      'updatedAt',
      'supervisorPid',
      'supervisorIdentity',
      'signalIsolation',
    ],
    'prepared-bound active-child',
  );
  requirePattern(active.ownerId, UUID_PATTERN, 'prepared-bound ownerId');
  requirePattern(active.operationId, UUID_PATTERN, 'prepared-bound operationId');
  requirePattern(active.helperDigest, DIGEST_PATTERN, 'prepared-bound helper digest');
  requirePattern(active.delegatedBaselineDigest, DIGEST_PATTERN, 'prepared-bound baseline digest');
  requirePattern(active.delegationContractDigest, DIGEST_PATTERN, 'prepared-bound contract digest');
  const expectedDelegation =
    active.kind === 'builder'
      ? 'builder-v1'
      : active.kind === 'validator'
        ? 'validator-v1'
        : ['quality-check', 'tdd-check', 'final-review'].includes(active.kind)
          ? 'read-only-v1'
          : undefined;
  if (
    active.schemaVersion !== 2 ||
    active.ownerId !== owner.ownerId ||
    active.operationId !== operationId ||
    active.state !== 'prepared-bound' ||
    active.delegation !== expectedDelegation ||
    active.platform !== 'posix-process-group-v1' ||
    active.supervisorPid !== process.pid ||
    active.supervisorIdentity !== processIdentity(process.pid) ||
    active.signalIsolation !== 'posix-supervisor-session-signal-shield-v1' ||
    active.delegatedBaselineDigest !== digestBytes(authority.baseline) ||
    baseline.ownerId !== owner.ownerId ||
    baseline.operationId !== operationId ||
    baseline.workspaceIdentity !== canonicalWorkspaceIdentity(workspacePath) ||
    baseline.contract.version !== active.delegation ||
    active.delegationContractDigest !== baseline.contractDigest ||
    active.helperDigest !== digestBytes(helperBundleBytes(supervisorPath, launcherPath))
  ) {
    throw new Error('canonical prepared-bound authority binding mismatch');
  }
  requireTimestamp(active.startedAt, 'prepared-bound startedAt');
  requireTimestamp(active.updatedAt, 'prepared-bound updatedAt');
  return { authority, active };
}

export function assertArmedAuthority(context, startDigest) {
  const {
    workspacePath,
    operationId,
    supervisorPath,
    launcherPath,
    preparedAuthority,
    launcherPid,
    launcherPgid,
    launcherIdentity,
  } = context;
  const authority = readAuthorityFiles(workspacePath);
  const { owner, protocol } = validateCoreAuthority(authority, workspacePath);
  const active = parseJson(authority.active, 'active-child');
  const baseline = validateBaseline(parseJson(authority.baseline, 'delegated baseline'));
  requireExactKeys(
    active,
    [
      'schemaVersion',
      'ownerId',
      'operationId',
      'state',
      'kind',
      'delegation',
      'platform',
      'helperDigest',
      'delegatedBaselineDigest',
      'delegationContractDigest',
      'startedAt',
      'updatedAt',
      'supervisorPid',
      'supervisorIdentity',
      'signalIsolation',
      'containment',
      'containmentDigest',
    ],
    'armed active-child',
  );
  requirePattern(active.ownerId, UUID_PATTERN, 'active ownerId');
  requirePattern(active.operationId, UUID_PATTERN, 'active operationId');
  requirePattern(active.helperDigest, DIGEST_PATTERN, 'active helper digest');
  requirePattern(active.delegatedBaselineDigest, DIGEST_PATTERN, 'active baseline digest');
  requirePattern(active.delegationContractDigest, DIGEST_PATTERN, 'active contract digest');
  requirePattern(active.containmentDigest, DIGEST_PATTERN, 'active containment digest');
  requireTimestamp(active.startedAt, 'active startedAt');
  requireTimestamp(active.updatedAt, 'active updatedAt');
  if (!preparedAuthority) throw new Error('prepared-bound authority was not cached');
  for (const name of ['marker', 'owner', 'protocol', 'baseline']) {
    if (!authority[name].equals(preparedAuthority.authority[name])) {
      throw new Error(`${name} changed between DATA and START`);
    }
  }
  for (const name of [
    'schemaVersion',
    'ownerId',
    'operationId',
    'kind',
    'delegation',
    'platform',
    'helperDigest',
    'delegatedBaselineDigest',
    'delegationContractDigest',
    'startedAt',
    'supervisorPid',
    'supervisorIdentity',
    'signalIsolation',
  ]) {
    if (active[name] !== preparedAuthority.active[name]) {
      throw new Error(`active-child ${name} changed outside the armed transition`);
    }
  }
  if (
    owner.ownerId !== active.ownerId ||
    active.schemaVersion !== 2 ||
    active.state !== 'armed' ||
    !['builder', 'validator', 'quality-check', 'tdd-check', 'final-review'].includes(active.kind) ||
    !['builder-v1', 'validator-v1', 'read-only-v1'].includes(active.delegation) ||
    active.operationId !== operationId ||
    active.platform !== 'posix-process-group-v1' ||
    active.supervisorPid !== process.pid ||
    active.supervisorIdentity !== processIdentity(process.pid) ||
    active.signalIsolation !== 'posix-supervisor-session-signal-shield-v1' ||
    digestBytes(authority.active) !== startDigest ||
    active.delegatedBaselineDigest !== digestBytes(authority.baseline) ||
    baseline.ownerId !== owner.ownerId ||
    baseline.operationId !== operationId ||
    baseline.workspaceIdentity !== canonicalWorkspaceIdentity(workspacePath) ||
    baseline.contract.version !== active.delegation ||
    active.delegationContractDigest !== baseline.contractDigest ||
    active.helperDigest !== digestBytes(helperBundleBytes(supervisorPath, launcherPath)) ||
    !exactKeys(active.containment, ['platform', 'pgid', 'launcherPid', 'launcherIdentity']) ||
    active.containment.platform !== 'posix-process-group-v1' ||
    active.containment.pgid !== launcherPgid ||
    active.containment.launcherPid !== launcherPid ||
    active.containment.launcherIdentity !== launcherIdentity ||
    active.containmentDigest !== digestBytes(jsonBytes(active.containment))
  ) {
    throw new Error('canonical armed authority binding mismatch');
  }
  const launcherIds = processIds(launcherPid);
  const supervisorIds = processIds(process.pid);
  if (
    launcherPid !== launcherPgid ||
    launcherIds.pgid !== launcherPgid ||
    launcherIds.sessionId !== launcherPgid ||
    processIdentity(launcherPid) !== launcherIdentity ||
    supervisorIds.pgid === launcherPgid ||
    supervisorIds.sessionId === launcherPgid
  ) {
    throw new Error('live POSIX containment binding mismatch');
  }
  return {
    markerDigest: digestBytes(authority.marker),
    ownerId: owner.ownerId,
    operationId,
    ownerRecordDigest: digestBytes(authority.owner),
    protocolDigest: digestBytes(authority.protocol),
    activeChildDigest: digestBytes(authority.active),
    delegatedBaselineDigest: digestBytes(authority.baseline),
    delegationContractDigest: active.delegationContractDigest,
    containmentDigest: active.containmentDigest,
    helperDigest: active.helperDigest,
    supervisorIdentity: active.supervisorIdentity,
    operationPath: authority.operationPath,
  };
}

export function assertCachedAuthorityCurrent(context) {
  const { workspacePath, cachedBinding, supervisorPath, launcherPath } = context;
  if (!cachedBinding) throw new Error('START binding was not cached');
  const authority = readAuthorityFiles(workspacePath);
  validateCoreAuthority(authority, workspacePath);
  if (
    digestBytes(authority.marker) !== cachedBinding.markerDigest ||
    digestBytes(authority.owner) !== cachedBinding.ownerRecordDigest ||
    digestBytes(authority.protocol) !== cachedBinding.protocolDigest ||
    digestBytes(authority.active) !== cachedBinding.activeChildDigest ||
    digestBytes(authority.baseline) !== cachedBinding.delegatedBaselineDigest ||
    digestBytes(helperBundleBytes(supervisorPath, launcherPath)) !== cachedBinding.helperDigest
  ) {
    throw new Error('canonical authority changed after START');
  }
}

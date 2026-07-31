import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 3 * 1024 * 1024;
const MAX_CURSOR_PROMPT_BYTES = 16 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_LENGTH = 64 * 1024;

function fail(message) {
  process.stderr.write(`coding-x review runner proxy: ${message}\n`);
  process.exitCode = 126;
}

function readStableOrdinaryFile(path, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(descriptor);
    const linkedPath = lstatSync(path);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !linkedPath.isFile() ||
      linkedPath.isSymbolicLink() ||
      linkedPath.nlink !== 1 ||
      linkedPath.dev !== opened.dev ||
      linkedPath.ino !== opened.ino ||
      opened.size > maximumBytes
    ) {
      throw new Error(`refusing invalid or oversized file: ${path}`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const hasTrailingByte = readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, null) !== 0;
    const after = fstatSync(descriptor);
    if (
      offset !== opened.size ||
      hasTrailingByte ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`file identity changed while reading: ${path}`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exactObject(value, required, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`${name} fields are invalid`);
  }
  return value;
}

function nonEmptyString(value, name, maximumLength = MAX_ARGUMENT_LENGTH) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes('\0')
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function argumentString(value, name) {
  if (typeof value !== 'string' || value.length > MAX_ARGUMENT_LENGTH || value.includes('\0')) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function parseConfig(configPath) {
  const parsed = JSON.parse(readStableOrdinaryFile(configPath, MAX_CONFIG_BYTES).toString('utf8'));
  const config = exactObject(
    parsed,
    ['schemaVersion', 'runner', 'executable', 'args', 'cwd', 'promptPath', 'promptMode'],
    'config',
  );
  if (config.schemaVersion !== 1) throw new Error('config schemaVersion is invalid');
  if (!['codex', 'claude', 'cursor'].includes(config.runner)) {
    throw new Error('config runner is invalid');
  }
  if (!['stdin', 'argument'].includes(config.promptMode)) {
    throw new Error('config promptMode is invalid');
  }
  if ((config.runner === 'cursor') !== (config.promptMode === 'argument')) {
    throw new Error('runner prompt contract is invalid');
  }
  const executable = nonEmptyString(config.executable, 'config executable');
  const cwd = nonEmptyString(config.cwd, 'config cwd');
  const promptPath = nonEmptyString(config.promptPath, 'config promptPath');
  if (!isAbsolute(executable) || !isAbsolute(cwd) || !isAbsolute(promptPath)) {
    throw new Error('config paths must be absolute');
  }
  if (resolve(dirname(configPath)) !== resolve(dirname(promptPath))) {
    throw new Error('prompt must share the invocation directory');
  }
  if (!Array.isArray(config.args) || config.args.length > MAX_ARGUMENTS) {
    throw new Error('config args are invalid');
  }
  const args = config.args.map((argument, index) =>
    argumentString(argument, `config args[${index}]`),
  );
  return { ...config, executable, cwd, promptPath, args };
}

async function main() {
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) {
    throw new Error('expected one absolute config path');
  }
  const config = parseConfig(process.argv[2]);
  const prompt = readStableOrdinaryFile(config.promptPath, MAX_PROMPT_BYTES);
  const args = [...config.args];
  if (config.promptMode === 'argument') {
    if (prompt.length > MAX_CURSOR_PROMPT_BYTES) {
      throw new Error(
        `Cursor prompt exceeds the fixed ${MAX_CURSOR_PROMPT_BYTES} byte argument limit`,
      );
    }
    args.push(prompt.toString('utf8'));
  }

  const child = spawn(config.executable, args, {
    cwd: config.cwd,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.once('error', (error) => fail(`failed to start runner: ${error.message}`));
  child.once('exit', (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  if (config.promptMode === 'stdin') child.stdin.end(prompt);
  else child.stdin.end();
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

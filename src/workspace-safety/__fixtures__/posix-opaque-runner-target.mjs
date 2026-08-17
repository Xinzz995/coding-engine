import { spawn } from 'node:child_process';

const readyPath = process.argv[2];
const stopPath = process.argv[3];
const exitedPath = process.argv[4];
const nonce = process.argv[5];
if (!readyPath || !stopPath || !exitedPath || !nonce) {
  throw new Error('fixture control arguments are required');
}

const descendantSource = [
  "const { linkSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');",
  'const readyPath = process.argv[1];',
  'const stopPath = process.argv[2];',
  'const exitedPath = process.argv[3];',
  'const nonce = process.argv[4];',
  'const writeCommittedJson = (path, value) => {',
  '  const temporary = `${path}.tmp-${String(process.pid)}`;',
  "  writeFileSync(temporary, `${JSON.stringify(value)}\\n`, { flag: 'wx' });",
  '  linkSync(temporary, path);',
  '  unlinkSync(temporary);',
  '};',
  'let finished = false;',
  'const finish = (reason) => {',
  '  if (finished) return;',
  '  finished = true;',
  '  writeCommittedJson(exitedPath, { pid: process.pid, nonce, reason });',
  '  process.exit(0);',
  '};',
  'writeCommittedJson(readyPath, { pid: process.pid, nonce });',
  'setInterval(() => {',
  "  try { if (readFileSync(stopPath, 'utf8') === nonce) finish('stop-marker'); } catch {}",
  '}, 20);',
  "setTimeout(() => finish('watchdog'), 60_000);",
].join('');

const descendant = spawn(
  process.execPath,
  ['-e', descendantSource, readyPath, stopPath, exitedPath, nonce],
  {
    detached: true,
    stdio: 'ignore',
  },
);
descendant.unref();

setInterval(() => {}, 1000);

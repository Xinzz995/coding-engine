import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Stub agent. Behavior controlled by argv:
//   node fake-agent.mjs ok            -> exits 0 immediately
//   node fake-agent.mjs hang          -> never exits (until killed)
//   node fake-agent.mjs tree           -> spawns a delayed-exit child, then hangs
//   node fake-agent.mjs stubborn-tree  -> spawns a SIGTERM-trapping child, then hangs
//   node fake-agent.mjs delayed-child  -> exits shortly after SIGTERM
//   node fake-agent.mjs stubborn-child -> ignores SIGTERM until SIGKILL
//   node fake-agent.mjs diagnostic     -> writes stdout/stderr then exits 1
//   node fake-agent.mjs long-diagnostic -> writes > evidence bound then exits 1
//   node fake-agent.mjs prepend-progress -> violates the append-only workspace contract
//   node fake-agent.mjs prepend-progress-with-descendant -> also leaves a live descendant
const mode = process.argv[2];
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'tree' || mode === 'stubborn-tree') {
  const childMode = mode === 'tree' ? 'delayed-child' : 'stubborn-child';
  spawn(process.execPath, [fileURLToPath(import.meta.url), childMode], {
    stdio: 'ignore',
  });
  setInterval(() => {}, 1000);
} else if (mode === 'delayed-child') {
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));
  writeFileSync('fake-agent-child.pid', String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'stubborn-child') {
  process.on('SIGTERM', () => {});
  writeFileSync('fake-agent-child.pid', String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'diagnostic') {
  process.stdout.write('runner started\n');
  process.stderr.write('API Error: 402 Account overdue\n');
  process.exit(1);
} else if (mode === 'long-diagnostic') {
  process.stderr.write(`${'x'.repeat(2500)}TAIL-END\n`);
  process.exit(1);
} else if (mode === 'prepend-progress' || mode === 'prepend-progress-with-descendant') {
  const path = process.env.CODING_X_FAKE_PROGRESS_PATH;
  if (!path) throw new Error('CODING_X_FAKE_PROGRESS_PATH is required');
  writeFileSync(path, `injected-before-prefix\n${readFileSync(path, 'utf8')}`);
  if (mode === 'prepend-progress-with-descendant') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    child.unref();
  }
  process.exit(0);
} else {
  process.exit(0);
}

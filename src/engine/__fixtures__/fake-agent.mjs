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
//   node fake-agent.mjs live-descendant -> reports IPC readiness, then never exits
const mode = process.argv[2];
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'live-descendant') {
  if (!process.send) throw new Error('live-descendant requires an IPC channel');
  setInterval(() => {}, 1000);
  process.send({ type: 'ready', pid: process.pid });
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
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'live-descendant'],
      {
        // libuv places ordinary Windows children in its own
        // kill-on-parent-exit Job. Detached skips that auxiliary Job without
        // breaking away from coding-x's Job. POSIX must keep the descendant
        // in the root process group, so it must not be detached there.
        detached: process.platform === 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    let descendantReady = false;
    let readinessFailureCode;
    const failReadiness = (code, diagnostic) => {
      if (readinessFailureCode !== undefined) return;
      clearTimeout(readinessTimeout);
      readinessFailureCode = code;
      process.stderr.write(`${diagnostic}\n`);
      if (child.exitCode !== null || child.signalCode !== null) {
        process.exit(code);
      }
      // Do not let a readiness-protocol failure impersonate the expected
      // live-descendant result. The root exits only after this child does; if
      // termination fails, the outer managed timeout exposes that failure.
      child.kill();
    };
    const readinessTimeout = setTimeout(() => {
      failReadiness(88, 'descendant-readiness-timeout');
    }, 5000);
    child.once('message', (message) => {
      if (readinessFailureCode !== undefined) return;
      if (
        typeof message !== 'object' ||
        message === null ||
        message.type !== 'ready' ||
        message.pid !== child.pid
      ) {
        failReadiness(86, 'descendant-sent-unexpected-readiness');
        return;
      }
      descendantReady = true;
      clearTimeout(readinessTimeout);
      child.disconnect();
      process.exit(0);
    });
    child.once('error', (error) => {
      clearTimeout(readinessTimeout);
      process.stderr.write(`descendant-spawn-failed: ${error.message}\n`);
      if (readinessFailureCode !== undefined) return;
      process.exit(87);
    });
    child.once('exit', (code, signal) => {
      if (descendantReady) return;
      clearTimeout(readinessTimeout);
      if (readinessFailureCode !== undefined) {
        process.exit(readinessFailureCode);
      }
      process.stderr.write(`descendant-exited-before-readiness: ${code ?? signal}\n`);
      process.exit(89);
    });
  } else {
    process.exit(0);
  }
} else {
  process.exit(0);
}

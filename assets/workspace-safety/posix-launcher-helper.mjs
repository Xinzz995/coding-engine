import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';

let state = 'barrier';
let target;
let root;

function send(message) {
  if (process.connected) process.send(message);
}

function fail(message) {
  send({ schemaVersion: 1, type: 'FAILURE', message });
  process.exitCode = 2;
  process.disconnect?.();
}

function exactKeys(value, expected) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function parseTarget(value) {
  if (!exactKeys(value, ['executable', 'args', 'cwd', 'environment'])) {
    throw new Error('invalid launcher target shape');
  }
  if (
    typeof value.executable !== 'string' ||
    value.executable.length === 0 ||
    typeof value.cwd !== 'string' ||
    value.cwd.length === 0 ||
    !Array.isArray(value.args) ||
    !Array.isArray(value.environment)
  ) {
    throw new Error('invalid launcher target fields');
  }
  const environment = {};
  for (const entry of value.environment) {
    if (
      !exactKeys(entry, ['name', 'value']) ||
      typeof entry.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(entry.name) ||
      typeof entry.value !== 'string' ||
      Object.hasOwn(environment, entry.name)
    ) {
      throw new Error('invalid launcher environment');
    }
    environment[entry.name] = entry.value;
  }
  if (value.args.some((argument) => typeof argument !== 'string')) {
    throw new Error('invalid launcher arguments');
  }
  return {
    executable: value.executable,
    args: [...value.args],
    cwd: value.cwd,
    environment,
  };
}

function closeOutputDescriptors() {
  for (const descriptor of [4, 5]) {
    try {
      closeSync(descriptor);
    } catch {
      // The descriptor may already be closed after a failed spawn.
    }
  }
}

// The launcher is the process-group leader and must remain alive long enough to
// report the real root result. Group-directed TERM/INT is therefore absorbed by
// the launcher while the project target and its descendants receive it normally.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => undefined);

process.on('message', (message) => {
  try {
    if (message?.schemaVersion !== 1 || typeof message.type !== 'string') {
      throw new Error('invalid launcher control message');
    }
    if (message.type === 'CONFIG') {
      if (state !== 'barrier' || !exactKeys(message, ['schemaVersion', 'type', 'target'])) {
        throw new Error('CONFIG is out of order');
      }
      target = parseTarget(message.target);
      state = 'configured';
      send({ schemaVersion: 1, type: 'BARRIER_READY', launcherPid: process.pid });
      return;
    }
    if (message.type === 'START') {
      if (state !== 'configured' || !exactKeys(message, ['schemaVersion', 'type'])) {
        throw new Error('START is out of order');
      }
      state = 'starting';
      root = spawn(target.executable, target.args, {
        cwd: target.cwd,
        env: target.environment,
        detached: false,
        stdio: ['ignore', 4, 5],
        windowsHide: true,
      });
      root.once('spawn', () => {
        closeOutputDescriptors();
        state = 'running';
        send({ schemaVersion: 1, type: 'STARTED', targetPid: root.pid });
      });
      root.once('error', (error) => {
        closeOutputDescriptors();
        fail(`target spawn failed: ${error.message}`);
      });
      root.once('exit', (code, signal) => {
        state = 'root-exited';
        send({ schemaVersion: 1, type: 'RESULT', code, signal });
      });
      return;
    }
    if (message.type === 'RELEASE_AFTER_DRAIN') {
      if (state !== 'root-exited' || !exactKeys(message, ['schemaVersion', 'type'])) {
        throw new Error('RELEASE_AFTER_DRAIN is out of order');
      }
      state = 'released';
      process.disconnect?.();
      return;
    }
    if (message.type === 'RELEASE_BEFORE_START') {
      if (state !== 'configured' || !exactKeys(message, ['schemaVersion', 'type'])) {
        throw new Error('RELEASE_BEFORE_START is out of order');
      }
      state = 'released';
      closeOutputDescriptors();
      process.disconnect?.();
      return;
    }
    if (message.type === 'SIGNAL_GROUP') {
      if (
        !['starting', 'running', 'root-exited'].includes(state) ||
        !exactKeys(message, ['schemaVersion', 'type', 'mode']) ||
        (message.mode !== 'TERM' && message.mode !== 'KILL')
      ) {
        throw new Error('SIGNAL_GROUP is out of order or invalid');
      }
      const signal = message.mode === 'TERM' ? 'SIGTERM' : 'SIGKILL';
      process.kill(-process.pid, signal);
      return;
    }
    throw new Error('unknown launcher control message');
  } catch (error) {
    fail(error instanceof Error ? error.message : 'launcher failure');
  }
});

process.on('disconnect', () => {
  closeOutputDescriptors();
  if (state !== 'released') process.exit(2);
});

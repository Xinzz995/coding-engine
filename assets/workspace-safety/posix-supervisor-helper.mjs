import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertArmedAuthority,
  assertCachedAuthorityCurrent,
  assertPreparedBoundAuthority,
  boundedString,
  deadlineAfter,
  delay,
  digestBytes,
  exactKeys,
  groupMembers,
  helperBundleBytes,
  jsonBytes,
  parseControlBytes,
  parseTarget,
  parseTimeouts,
  probeGroup,
  processIdentity,
  processIds,
  readAuthorityFiles,
  remainingDeadlineMs,
  waitUntilDeadline,
} from './posix-supervisor-core.mjs';

const supervisorPath = fileURLToPath(import.meta.url);
const launcherPath = process.argv[2];
const timeoutInput = process.argv[3];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
// 8 KiB expands to at most 10,924 base64 characters, safely below the
// parent's fixed 16,384-character field limit without relaxing that limit.
const OUTPUT_CHUNK_BYTES = 8 * 1024;

let state = 'bound';
let operationId;
let workspacePath;
let target;
let launcher;
let launcherIdentity;
let launcherPgid;
let rootResult;
let stdoutEof = false;
let stderrEof = false;
let preparedAuthority;
let cachedBinding;
let receiptDigest;
let cleanupStarted = false;
let receiptInstalled = false;
let terminalCause;
let parentConnected = true;
let stageTimer;
let prestartCleanupStarted = false;
let closeoutDeadline;
let pendingParentMessages = 0;

if (process.platform === 'win32' || !launcherPath || !isAbsolute(launcherPath) || !timeoutInput) {
  process.exit(2);
}

const timeouts = parseTimeouts(timeoutInput);
const prepareDeadline = deadlineAfter(timeouts.handshakeMs);

function waitUntil(predicate, deadline) {
  return waitUntilDeadline(predicate, deadline, timeouts.pollMs);
}

function send(message, deadline = deadlineAfter(5000)) {
  if (!parentConnected || !process.connected) return;
  const remaining = remainingDeadlineMs(deadline);
  if (remaining === 0 || pendingParentMessages >= 4096) {
    parentConnected = false;
    void handleParentDisconnect();
    return;
  }
  pendingParentMessages += 1;
  let completed = false;
  const timer = setTimeout(() => {
    if (completed) return;
    completed = true;
    pendingParentMessages -= 1;
    parentConnected = false;
    void handleParentDisconnect();
  }, remaining);
  try {
    process.send(message, (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      pendingParentMessages -= 1;
      if (error) {
        parentConnected = false;
        void handleParentDisconnect();
      }
    });
  } catch {
    if (!completed) {
      completed = true;
      clearTimeout(timer);
      pendingParentMessages -= 1;
    }
    parentConnected = false;
    void handleParentDisconnect();
  }
}

function sendOutput(stream, chunk) {
  for (let offset = 0; offset < chunk.length; offset += OUTPUT_CHUNK_BYTES) {
    send({
      schemaVersion: 1,
      type: 'OUTPUT',
      stream,
      data: chunk.subarray(offset, offset + OUTPUT_CHUNK_BYTES).toString('base64'),
    });
  }
}

function armStageDeadline(label, deadline) {
  clearTimeout(stageTimer);
  const remaining = remainingDeadlineMs(deadline);
  if (remaining === 0) {
    queueMicrotask(() => void failClosed(`${label} timed out`));
    return;
  }
  stageTimer = setTimeout(() => {
    void failClosed(`${label} timed out`);
  }, remaining);
}

function armPrepareDeadline(label) {
  armStageDeadline(label, prepareDeadline);
}

function beginCloseout(includeNaturalDrain = false) {
  const candidate = deadlineAfter(
    timeouts.killMs + (includeNaturalDrain ? timeouts.naturalDrainMs : 0),
  );
  closeoutDeadline =
    closeoutDeadline === undefined || includeNaturalDrain
      ? (closeoutDeadline ?? candidate)
      : Math.min(closeoutDeadline, candidate);
  armStageDeadline('containment closeout', closeoutDeadline);
  return closeoutDeadline;
}

function authorityContext() {
  return {
    workspacePath,
    operationId,
    supervisorPath,
    launcherPath,
    preparedAuthority,
    cachedBinding,
    launcherPid: launcher?.pid,
    launcherPgid,
    launcherIdentity,
  };
}

function assertLiveLauncherGroupBinding() {
  if (!launcher || !launcherPgid || !launcherIdentity) {
    throw new Error('launcher containment binding is unavailable');
  }
  const ids = processIds(launcher.pid);
  if (
    launcher.pid !== launcherPgid ||
    ids.pgid !== launcherPgid ||
    ids.sessionId !== launcherPgid ||
    processIdentity(launcher.pid) !== launcherIdentity
  ) {
    throw new Error('launcher containment identity changed before signalling');
  }
}

function requestLauncherGroupSignal(mode, deadline) {
  if (
    !launcher ||
    !launcher.connected ||
    launcher.pid !== launcherPgid ||
    !launcherIdentity ||
    (mode !== 'TERM' && mode !== 'KILL')
  ) {
    throw new Error('fixed launcher signal channel is unavailable');
  }
  return new Promise((resolveSignal, rejectSignal) => {
    const remaining = remainingDeadlineMs(deadline);
    if (remaining === 0) {
      rejectSignal(new Error(`launcher ${mode} signal delivery timed out`));
      return;
    }
    const timer = setTimeout(
      () => rejectSignal(new Error(`launcher ${mode} signal delivery timed out`)),
      remaining,
    );
    launcher.send({ schemaVersion: 1, type: 'SIGNAL_GROUP', mode }, (error) => {
      clearTimeout(timer);
      if (error) rejectSignal(error);
      else resolveSignal();
    });
  });
}

function installReceipt(proof, drainReason) {
  if (!cachedBinding) throw new Error('START binding was not cached');
  assertCachedAuthorityCurrent(authorityContext());
  const receipt = {
    schemaVersion: 1,
    ownerId: cachedBinding.ownerId,
    operationId: cachedBinding.operationId,
    ownerRecordDigest: cachedBinding.ownerRecordDigest,
    protocolDigest: cachedBinding.protocolDigest,
    activeChildDigest: cachedBinding.activeChildDigest,
    delegatedBaselineDigest: cachedBinding.delegatedBaselineDigest,
    delegationContractDigest: cachedBinding.delegationContractDigest,
    containmentDigest: cachedBinding.containmentDigest,
    helperDigest: cachedBinding.helperDigest,
    supervisorIdentity: cachedBinding.supervisorIdentity,
    proof,
    drainReason,
    drainedAt: new Date().toISOString(),
  };
  const bytes = jsonBytes(receipt);
  const staging = join(cachedBinding.operationPath, `drained-receipt.prepare-${randomUUID()}.json`);
  const destination = join(cachedBinding.operationPath, 'drained-receipt.json');
  writeFileSync(staging, bytes, { flag: 'wx', mode: 0o600 });
  if (!readFileSync(staging).equals(bytes)) throw new Error('receipt staging readback mismatch');
  try {
    linkSync(staging, destination);
    if (!readFileSync(destination).equals(bytes)) throw new Error('receipt readback mismatch');
  } finally {
    try {
      unlinkSync(staging);
    } catch {
      // A crash-safe leftover is intentionally not treated as authority.
    }
  }
  receiptDigest = digestBytes(bytes);
  return jsonBytes({
    schemaVersion: 1,
    type: 'DRAINED',
    operationId,
    receiptDigest,
    proof,
  });
}

async function ensureOutputEof(deadline) {
  return waitUntil(() => stdoutEof && stderrEof, deadline);
}

async function terminateContainment(deadline = beginCloseout()) {
  if (!launcherPgid) return;
  const initial = probeGroup(launcherPgid);
  if (initial === 'unknown') throw new Error('POSIX group presence is unknown');
  if (initial === 'alive') {
    await requestLauncherGroupSignal('TERM', deadline);
    const termDeadline = Math.min(deadline, deadlineAfter(timeouts.termMs));
    if (!rootResult) {
      await waitUntil(() => rootResult !== undefined, termDeadline);
    }
    if (rootResult) {
      await waitUntil(
        () => {
          const members = groupMembers(launcherPgid);
          return members.length === 1 && members[0] === launcher.pid;
        },
        termDeadline,
      );
    }

    const afterRootMembers = groupMembers(launcherPgid);
    if (afterRootMembers.length === 1 && afterRootMembers[0] === launcher.pid) {
      launcher.send({ schemaVersion: 1, type: 'RELEASE_AFTER_DRAIN' });
    } else if (afterRootMembers.length > 0) {
      await requestLauncherGroupSignal('KILL', deadline);
    }
    if (!(await waitUntil(() => probeGroup(launcherPgid) === 'empty', deadline))) {
      throw new Error('POSIX group could not be confirmed empty');
    }
  }
  if (!(await ensureOutputEof(deadline)))
    throw new Error('target output pipes did not close');
}

async function finishWithReceipt(proof, drainReason) {
  if (receiptInstalled) return;
  receiptInstalled = true;
  clearTimeout(stageTimer);
  if (probeGroup(launcherPgid) !== 'empty' || !stdoutEof || !stderrEof) {
    throw new Error('receipt attempted before POSIX containment and output were drained');
  }
  const messageBytes = installReceipt(proof, drainReason);
  state = 'drained';
  send(
    {
      schemaVersion: 1,
      type: 'DRAINED',
      messageBase64: messageBytes.toString('base64'),
    },
    closeoutDeadline ?? deadlineAfter(timeouts.killMs),
  );
  if (!parentConnected) return process.exit(0);
  armStageDeadline('ACK', deadlineAfter(timeouts.ackMs));
}

async function drainNeverStartedContainment(deadline = beginCloseout()) {
  const presence = probeGroup(launcherPgid);
  if (presence === 'unknown') throw new Error('POSIX group presence is unknown');
  if (presence === 'alive') {
    assertLiveLauncherGroupBinding();
    launcher.send({ schemaVersion: 1, type: 'RELEASE_BEFORE_START' });
    if (!(await waitUntil(() => probeGroup(launcherPgid) === 'empty', deadline))) {
      throw new Error('never-started launcher group did not disappear');
    }
  }
  if (!(await ensureOutputEof(deadline))) {
    throw new Error('never-started output pipes did not close');
  }
}

function parseAbortBeforeStart(envelope) {
  if (!exactKeys(envelope, ['schemaVersion', 'type', 'messageBase64'])) {
    throw new Error('ABORT_BEFORE_START is out of order');
  }
  const message = parseControlBytes(envelope.messageBase64, 'ABORT_BEFORE_START');
  if (
    !exactKeys(message, ['schemaVersion', 'type', 'operationId']) ||
    message.schemaVersion !== 1 ||
    message.type !== 'ABORT_BEFORE_START' ||
    !UUID_PATTERN.test(message.operationId)
  ) {
    throw new Error('ABORT_BEFORE_START binding is invalid');
  }
  if (operationId !== undefined && message.operationId !== operationId) {
    throw new Error('ABORT_BEFORE_START operation mismatch');
  }
  return message.operationId;
}

async function finishPrestartAbort() {
  if (prestartCleanupStarted) return;
  prestartCleanupStarted = true;
  clearTimeout(stageTimer);
  const deadline = beginCloseout();
  if (launcher) await drainNeverStartedContainment(deadline);
  const messageBytes = jsonBytes({
    schemaVersion: 1,
    type: 'PRESTART_DRAINED',
    operationId,
    supervisorPid: process.pid,
    supervisorIdentity: selfIdentity,
    proof: 'prestart-containment-empty-and-pipes-eof-v1',
    drainedAt: new Date().toISOString(),
  });
  state = 'prestart-drained';
  send(
    {
      schemaVersion: 1,
      type: 'PRESTART_DRAINED',
      messageBase64: messageBytes.toString('base64'),
    },
    deadline,
  );
}

async function drainNormally() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const deadline = beginCloseout(true);
  const naturalDeadline = Math.min(deadline, deadlineAfter(timeouts.naturalDrainMs));
  const containmentIsNaturallyDrained = () => {
    if (stdoutEof && stderrEof) {
      const members = groupMembers(launcherPgid);
      return members.length === 1 && members[0] === launcher.pid;
    }
    return false;
  };
  let naturallyDrained = containmentIsNaturallyDrained();
  while (
    !naturallyDrained &&
    parentConnected &&
    !terminalCause &&
    remainingDeadlineMs(naturalDeadline) > 0
  ) {
    await delay(Math.min(timeouts.pollMs, remainingDeadlineMs(naturalDeadline)));
    naturallyDrained = containmentIsNaturallyDrained();
  }
  if (terminalCause) {
    await terminateContainment(deadline);
    return finishWithReceipt('posix-group-empty-and-pipes-eof-v1', terminalCause);
  }
  if (!naturallyDrained) {
    terminalCause = 'process-tree-not-empty';
    await terminateContainment(deadline);
    return finishWithReceipt('posix-group-empty-and-pipes-eof-v1', terminalCause);
  }
  terminalCause = 'natural';
  launcher.send({ schemaVersion: 1, type: 'RELEASE_AFTER_DRAIN' });
  if (!(await waitUntil(() => probeGroup(launcherPgid) === 'empty', deadline))) {
    throw new Error('launcher group did not disappear after natural drain');
  }
  return finishWithReceipt('posix-group-empty-and-pipes-eof-v1', terminalCause);
}

async function failClosed(message) {
  if (state === 'failed') return;
  state = 'failed';
  clearTimeout(stageTimer);
  send({ schemaVersion: 1, type: 'FAILURE', message });
  try {
    const deadline = deadlineAfter(timeouts.killMs);
    if (launcherPgid && probeGroup(launcherPgid) === 'alive') {
      await requestLauncherGroupSignal('KILL', deadline);
      await waitUntil(() => probeGroup(launcherPgid) === 'empty', deadline);
    }
  } catch {
    // Failure remains fail-closed; never synthesize a receipt from this path.
  }
  process.exit(2);
}

async function handleParentDisconnect() {
  parentConnected = false;
  clearTimeout(stageTimer);
  if (state === 'drained') return process.exit(0);
  if (state === 'prestart-drained') return process.exit(0);
  if (!launcherPgid) return process.exit(0);
  try {
    if (state === 'start-accepted' || state === 'running' || state === 'root-exited') {
      terminalCause ??= 'parent-shutdown';
      if (cleanupStarted) return;
      cleanupStarted = true;
      await terminateContainment(beginCloseout());
      await finishWithReceipt('posix-group-empty-and-pipes-eof-v1', 'parent-shutdown');
      return process.exit(0);
    }
    if (state === 'armed' || state === 'termination-before-start') {
      const authority = readAuthorityFiles(workspacePath);
      const activeDigest = digestBytes(authority.active);
      cachedBinding ??= assertArmedAuthority(authorityContext(), activeDigest);
      terminalCause ??= 'parent-shutdown';
      if (cleanupStarted) return;
      cleanupStarted = true;
      await drainNeverStartedContainment(beginCloseout());
      await finishWithReceipt('never-started-containment-empty-v1', 'parent-shutdown');
      return process.exit(0);
    }
    if (cleanupStarted) return;
    await terminateContainment(beginCloseout());
    return process.exit(0);
  } catch {
    return process.exit(2);
  }
}

function handleLauncherMessage(message) {
  try {
    if (message?.schemaVersion !== 1 || typeof message.type !== 'string') {
      throw new Error('invalid launcher message');
    }
    if (message.type === 'BARRIER_READY') {
      if (
        !['data-accepted', 'prestart-aborting'].includes(state) ||
        !exactKeys(message, ['schemaVersion', 'type', 'launcherPid']) ||
        message.launcherPid !== launcher.pid
      ) {
        throw new Error('launcher barrier binding mismatch');
      }
      const ids = processIds(launcher.pid);
      const supervisorIds = processIds(process.pid);
      launcherIdentity = processIdentity(launcher.pid);
      launcherPgid = launcher.pid;
      if (
        ids.pgid !== launcher.pid ||
        ids.sessionId !== launcher.pid ||
        supervisorIds.pgid === launcher.pid ||
        supervisorIds.sessionId === launcher.pid
      ) {
        throw new Error('launcher is not an isolated POSIX session/process group');
      }
      if (state === 'prestart-aborting') {
        void finishPrestartAbort().catch((error) =>
          failClosed(error instanceof Error ? error.message : 'prestart abort failed'),
        );
        return;
      }
      state = 'armed';
      armPrepareDeadline('START');
      send(
        {
          schemaVersion: 1,
          type: 'ARMED',
          containment: {
            platform: 'posix-process-group-v1',
            pgid: launcherPgid,
            launcherPid: launcher.pid,
            launcherIdentity,
          },
        },
        prepareDeadline,
      );
      return;
    }
    if (message.type === 'STARTED') {
      if (
        state !== 'start-accepted' ||
        !exactKeys(message, ['schemaVersion', 'type', 'targetPid']) ||
        !Number.isSafeInteger(message.targetPid)
      ) {
        throw new Error('STARTED is out of order');
      }
      state = 'running';
      send(message);
      return;
    }
    if (message.type === 'RESULT') {
      if (
        state !== 'running' ||
        !exactKeys(message, ['schemaVersion', 'type', 'code', 'signal']) ||
        !(
          (message.code === null || Number.isSafeInteger(message.code)) &&
          (message.signal === null || typeof message.signal === 'string')
        )
      ) {
        throw new Error('RESULT is out of order');
      }
      state = 'root-exited';
      rootResult = { code: message.code, signal: message.signal };
      send(message, beginCloseout(true));
      void drainNormally().catch((error) =>
        failClosed(error instanceof Error ? error.message : 'normal drain failed'),
      );
      return;
    }
    if (message.type === 'FAILURE') {
      throw new Error(boundedString(message.message, 'launcher failure'));
    }
    throw new Error('unknown launcher message');
  } catch (error) {
    void failClosed(error instanceof Error ? error.message : 'launcher protocol failed');
  }
}

function handleParentMessage(envelope) {
  try {
    if (envelope?.schemaVersion !== 1 || typeof envelope.type !== 'string') {
      throw new Error('invalid parent envelope');
    }
    if (envelope.type === 'DATA') {
      if (
        state !== 'bound' ||
        !exactKeys(envelope, ['schemaVersion', 'type', 'workspacePath', 'messageBase64'])
      ) {
        throw new Error('DATA is out of order');
      }
      const message = parseControlBytes(envelope.messageBase64, 'DATA');
      if (
        !exactKeys(message, ['schemaVersion', 'type', 'operationId', 'target']) ||
        !UUID_PATTERN.test(message.operationId)
      ) {
        throw new Error('DATA message binding is invalid');
      }
      workspacePath = resolve(boundedString(envelope.workspacePath, 'workspace path'));
      operationId = message.operationId;
      target = parseTarget(message.target);
      preparedAuthority = assertPreparedBoundAuthority(authorityContext());
      state = 'data-accepted';
      launcher = spawn(process.execPath, [launcherPath], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        windowsHide: true,
      });
      launcher.on('message', handleLauncherMessage);
      launcher.on('error', (error) => void failClosed(`launcher spawn failed: ${error.message}`));
      launcher.on('exit', () => {
        if (!cleanupStarted && !['root-exited', 'drained', 'failed'].includes(state)) {
          void failClosed('launcher exited before drain');
        }
      });
      launcher.stdio[4].on('data', (chunk) => {
        sendOutput('stdout', chunk);
      });
      launcher.stdio[5].on('data', (chunk) => {
        sendOutput('stderr', chunk);
      });
      launcher.stdio[4].once('end', () => {
        stdoutEof = true;
      });
      launcher.stdio[5].once('end', () => {
        stderrEof = true;
      });
      launcher.once('spawn', () => {
        launcher.send({ schemaVersion: 1, type: 'CONFIG', target });
      });
      armPrepareDeadline('launcher barrier');
      return;
    }
    if (envelope.type === 'START') {
      if (
        !['armed', 'termination-before-start'].includes(state) ||
        !exactKeys(envelope, ['schemaVersion', 'type', 'messageBase64'])
      ) {
        throw new Error('START is out of order');
      }
      const message = parseControlBytes(envelope.messageBase64, 'START');
      if (
        !exactKeys(message, ['schemaVersion', 'type', 'operationId', 'activeChildDigest']) ||
        message.operationId !== operationId ||
        !DIGEST_PATTERN.test(message.activeChildDigest)
      ) {
        throw new Error('START message binding is invalid');
      }
      if (state === 'termination-before-start') {
        if (!cachedBinding || message.activeChildDigest !== cachedBinding.activeChildDigest) {
          throw new Error('late START does not match the frozen armed binding');
        }
        return;
      }
      cachedBinding = assertArmedAuthority(authorityContext(), message.activeChildDigest);
      state = 'start-accepted';
      clearTimeout(stageTimer);
      launcher.send({ schemaVersion: 1, type: 'START' });
      return;
    }
    if (envelope.type === 'ACK') {
      if (state !== 'drained' || !exactKeys(envelope, ['schemaVersion', 'type', 'messageBase64'])) {
        throw new Error('ACK is out of order');
      }
      const message = parseControlBytes(envelope.messageBase64, 'ACK');
      if (
        !exactKeys(message, ['schemaVersion', 'type', 'operationId', 'receiptDigest']) ||
        message.operationId !== operationId ||
        message.receiptDigest !== receiptDigest
      ) {
        throw new Error('ACK binding is invalid');
      }
      state = 'acknowledged';
      clearTimeout(stageTimer);
      process.disconnect?.();
      return;
    }
    if (envelope.type === 'TERMINATE') {
      if (!exactKeys(envelope, ['schemaVersion', 'type', 'messageBase64'])) {
        throw new Error('TERMINATE is out of order');
      }
      const message = parseControlBytes(envelope.messageBase64, 'TERMINATE');
      if (
        !exactKeys(message, ['schemaVersion', 'type', 'operationId', 'reason']) ||
        message.operationId !== operationId ||
        !['timeout', 'user-interrupt', 'parent-shutdown'].includes(message.reason)
      ) {
        throw new Error('TERMINATE binding is invalid');
      }
      if (terminalCause !== undefined || state === 'drained' || state === 'acknowledged') {
        return;
      }
      if (state === 'armed') {
        const authority = readAuthorityFiles(workspacePath);
        cachedBinding = assertArmedAuthority(authorityContext(), digestBytes(authority.active));
        terminalCause = message.reason;
        state = 'termination-before-start';
        clearTimeout(stageTimer);
        cleanupStarted = true;
        const deadline = beginCloseout();
        void drainNeverStartedContainment(deadline)
          .then(() => finishWithReceipt('never-started-containment-empty-v1', terminalCause))
          .catch((error) =>
            failClosed(error instanceof Error ? error.message : 'prestart termination failed'),
          );
        return;
      }
      if (!['start-accepted', 'running', 'root-exited'].includes(state)) {
        throw new Error('TERMINATE is out of order');
      }
      terminalCause = message.reason;
      clearTimeout(stageTimer);
      if (!cleanupStarted) {
        cleanupStarted = true;
        const deadline = beginCloseout();
        void terminateContainment(deadline)
          .then(() => finishWithReceipt('posix-group-empty-and-pipes-eof-v1', terminalCause))
          .catch((error) =>
            failClosed(error instanceof Error ? error.message : 'termination failed'),
          );
      }
      return;
    }
    if (envelope.type === 'ABORT_BEFORE_START') {
      if (!['bound', 'data-accepted', 'armed'].includes(state)) {
        throw new Error('ABORT_BEFORE_START is out of order');
      }
      operationId = parseAbortBeforeStart(envelope);
      if (state === 'data-accepted') {
        state = 'prestart-aborting';
        beginCloseout();
        return;
      }
      state = 'prestart-aborting';
      void finishPrestartAbort().catch((error) =>
        failClosed(error instanceof Error ? error.message : 'prestart abort failed'),
      );
      return;
    }
    throw new Error('unknown parent envelope');
  } catch (error) {
    void failClosed(error instanceof Error ? error.message : 'parent protocol failed');
  }
}

process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => undefined);
process.on('message', handleParentMessage);
process.on('disconnect', () => {
  void handleParentDisconnect();
});

const selfIdentity = processIdentity(process.pid);
const selfIds = processIds(process.pid);
if (selfIds.pgid !== process.pid || selfIds.sessionId !== process.pid) process.exit(2);

send(
  {
    schemaVersion: 1,
    type: 'BOUND',
    supervisorPid: process.pid,
    supervisorIdentity: selfIdentity,
    helperDigest: digestBytes(helperBundleBytes(supervisorPath, launcherPath)),
  },
  prepareDeadline,
);
armPrepareDeadline('DATA');

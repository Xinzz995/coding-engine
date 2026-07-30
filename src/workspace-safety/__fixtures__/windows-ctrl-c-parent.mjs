import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SUPERVISOR_EXECUTABLE = 'coding-x-windows-supervisor.exe';
const SUPERVISOR_DOMAIN = Buffer.from('coding-x-windows-supervisor-exe-v1\0', 'utf8');
const OPERATION_ID = '12345678-1234-4234-8234-123456789abc';
const OWNER_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function helperBundle(assetRoot) {
  return Buffer.concat([SUPERVISOR_DOMAIN, readFileSync(join(assetRoot, SUPERVISOR_EXECUTABLE))]);
}

function send(child, type, message, extra = {}) {
  child.stdin.write(
    `${JSON.stringify({
      schemaVersion: 1,
      type,
      ...extra,
      messageBase64: Buffer.from(JSON.stringify(message), 'utf8').toString('base64'),
    })}\n`,
  );
}

class Events {
  constructor(child) {
    this.child = child;
    this.iterator = createInterface({ input: child.stdout, crlfDelay: Infinity })[
      Symbol.asyncIterator
    ]();
    this.stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.exit = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
  }

  async next(expected) {
    while (true) {
      const step = await Promise.race([
        this.iterator.next(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), 30_000),
        ),
      ]);
      if (step.done) throw new Error(`helper exited before ${expected}: ${this.stderr}`);
      const event = JSON.parse(step.value);
      if (event.type === 'FAILURE') throw new Error(`helper failure: ${event.message}`);
      if (event.type === expected) return event;
    }
  }
}

async function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

function installPrepared(workspace, helperDigest, bound) {
  const timestamp = new Date().toISOString();
  const protocol = {
    schemaVersion: 1,
    protocol: 'coding-x-workspace-lease-v1',
    workspaceIdentity: digest('ctrl-c-workspace'),
    createdBy: '0.34.0',
    createdAt: timestamp,
  };
  const protocolBytes = Buffer.from(JSON.stringify(protocol), 'utf8');
  const marker = {
    schemaVersion: 2,
    initializedBy: '0.34.0',
    workspaceIdentity: protocol.workspaceIdentity,
    protocolDigest: digest(protocolBytes),
    initializedAt: timestamp,
  };
  const owner = {
    schemaVersion: 2,
    ownerId: OWNER_ID,
    pid: process.pid,
    processIdentity: { kind: 'windows-filetime', value: 'ctrl-c-parent' },
    bootIdentity: digest('boot'),
    hostId: digest('host'),
    workspaceIdentity: protocol.workspaceIdentity,
    startedAt: timestamp,
    command: 'run',
  };
  const contract = {
    rules: [],
    semantic: { version: 'read-only-v1' },
    version: 'read-only-v1',
  };
  const baseline = {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    operationId: OPERATION_ID,
    workspaceIdentity: protocol.workspaceIdentity,
    contract,
    contractDigest: digest(JSON.stringify(contract)),
    entries: [],
    capturedAt: timestamp,
    manifestDigest: digest('manifest'),
  };
  const baselineBytes = Buffer.from(JSON.stringify(baseline), 'utf8');
  const prepared = {
    schemaVersion: 2,
    ownerId: OWNER_ID,
    operationId: OPERATION_ID,
    state: 'prepared-bound',
    kind: 'final-review',
    delegation: 'read-only-v1',
    platform: 'windows-job-v1',
    helperDigest,
    delegatedBaselineDigest: digest(baselineBytes),
    delegationContractDigest: baseline.contractDigest,
    startedAt: timestamp,
    updatedAt: timestamp,
    supervisorPid: bound.supervisorPid,
    supervisorIdentity: bound.supervisorIdentity,
    signalIsolation: 'windows-new-process-group-ctrl-c-ignore-v1',
  };
  const operationPath = join(workspace, 'engine.lock', 'lease', 'operation');
  mkdirSync(operationPath, { recursive: true });
  writeFileSync(join(workspace, 'workspace-safety.json'), JSON.stringify(marker));
  writeFileSync(join(workspace, 'engine.lock', 'protocol.json'), protocolBytes);
  writeFileSync(join(workspace, 'engine.lock', 'lease', 'owner.json'), JSON.stringify(owner));
  writeFileSync(join(operationPath, 'delegated-baseline.json'), baselineBytes);
  const activePath = join(operationPath, 'active-child.json');
  writeFileSync(activePath, JSON.stringify(prepared));
  return { operationPath, activePath, prepared };
}

async function main() {
  const [assetRootInput, workspaceInput, driverReady, outcomePath] = process.argv.slice(2);
  if (!assetRootInput || !workspaceInput || !driverReady || !outcomePath) {
    throw new Error('ctrl-c parent arguments are incomplete');
  }
  const assetRoot = realpathSync(assetRootInput);
  const workspace = realpathSync(workspaceInput);
  const helperDigest = digest(helperBundle(assetRoot));
  const supervisor = join(assetRoot, SUPERVISOR_EXECUTABLE);
  const timeouts = Buffer.from(
    JSON.stringify({
      handshakeMs: 10_000,
      naturalDrainMs: 5000,
      terminateMs: 10_000,
      ackMs: 10_000,
      pollMs: 20,
    }),
    'utf8',
  ).toString('base64');
  const helper = spawn(
    supervisor,
    ['--expected-helper-digest', helperDigest, '--timeouts-base64', timeouts],
    {
      cwd: assetRoot,
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const events = new Events(helper);
  const bound = await events.next('BOUND');
  if (bound.supervisorPid !== helper.pid) {
    throw new Error('BOUND pid does not identify the directly spawned supervisor');
  }
  const authority = installPrepared(workspace, helperDigest, bound);
  const targetReady = join(workspace, 'target-ready.txt');
  const targetSawCtrl = join(workspace, 'target-saw-ctrl-c.txt');
  const targetProgram = fileURLToPath(new URL('./windows-ctrl-c-target.mjs', import.meta.url));
  send(
    helper,
    'DATA',
    {
      schemaVersion: 1,
      type: 'DATA',
      operationId: OPERATION_ID,
      target: {
        executable: realpathSync(process.execPath),
        args: [targetProgram, targetSawCtrl, targetReady],
        cwd: workspace,
        environment: [],
      },
    },
    { workspacePath: workspace },
  );
  const armedEvent = await events.next('ARMED');
  const armed = {
    ...authority.prepared,
    state: 'armed',
    containment: armedEvent.containment,
    containmentDigest: digest(JSON.stringify(armedEvent.containment)),
  };
  const armedBytes = Buffer.from(JSON.stringify(armed), 'utf8');
  writeFileSync(authority.activePath, armedBytes);
  send(helper, 'START', {
    schemaVersion: 1,
    type: 'START',
    operationId: OPERATION_ID,
    activeChildDigest: digest(armedBytes),
  });
  await events.next('STARTED');
  await waitForFile(targetReady);

  let resolveInterrupt;
  const interrupted = new Promise((resolve) => {
    resolveInterrupt = resolve;
  });
  process.on('SIGINT', () => resolveInterrupt());
  writeFileSync(driverReady, 'ready');
  await interrupted;
  send(helper, 'TERMINATE', {
    schemaVersion: 1,
    type: 'TERMINATE',
    operationId: OPERATION_ID,
    reason: 'user-interrupt',
  });
  await events.next('RESULT');
  const drained = await events.next('DRAINED');
  const drainedMessage = JSON.parse(Buffer.from(drained.messageBase64, 'base64').toString('utf8'));
  const receiptPath = join(authority.operationPath, 'drained-receipt.json');
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (
    receipt.drainReason !== 'user-interrupt' ||
    receipt.proof !== 'windows-job-zero-and-pipes-eof-v1' ||
    drainedMessage.receiptDigest !== digest(receiptBytes) ||
    existsSync(targetSawCtrl)
  ) {
    throw new Error('Ctrl+C did not remain isolated to the parent control path');
  }
  send(helper, 'ACK', {
    schemaVersion: 1,
    type: 'ACK',
    operationId: OPERATION_ID,
    receiptDigest: drainedMessage.receiptDigest,
  });
  const helperExit = await events.exit;
  if (helperExit.code !== 0 || helperExit.signal !== null) {
    throw new Error('Windows Job supervisor did not exit cleanly after ACK');
  }
  writeFileSync(
    outcomePath,
    JSON.stringify({
      parentExitCode: 130,
      supervisorPid: bound.supervisorPid,
      targetPid: armedEvent.containment.targetPid,
      drainReason: receipt.drainReason,
      proof: receipt.proof,
      receiptDigest: drainedMessage.receiptDigest,
      targetSawCtrlC: false,
    }),
  );
}

try {
  await main();
  process.exit(130);
} catch (error) {
  const outcomePath = process.argv[5];
  if (outcomePath) {
    writeFileSync(
      outcomePath,
      JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }),
    );
  }
  process.exit(2);
}

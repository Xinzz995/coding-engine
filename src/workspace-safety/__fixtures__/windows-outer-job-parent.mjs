import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const SUPERVISOR_EXECUTABLE = 'coding-x-windows-supervisor.exe';
const SUPERVISOR_DOMAIN = Buffer.from('coding-x-windows-supervisor-exe-v1\0', 'utf8');
const OPERATION_ID = '12345678-1234-4234-8234-123456789abc';
const OWNER_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function helperBundle(assetRoot) {
  return Buffer.concat([SUPERVISOR_DOMAIN, readFileSync(join(assetRoot, SUPERVISOR_EXECUTABLE))]);
}

class Events {
  constructor(child) {
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
      if (event.type === 'FAILURE' && expected !== 'FAILURE') {
        throw new Error(`helper failure: ${event.message}`);
      }
      if (event.type === expected) return event;
    }
  }
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

async function waitForFile(path) {
  const deadline = Date.now() + 30_000;
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
    workspaceIdentity: digest('outer-job-workspace'),
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
    processIdentity: { kind: 'windows-filetime', value: 'outer-job-parent' },
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
  const [assetRootInput, workspaceInput, readyPath, continuePath, outcomePath, mode] =
    process.argv.slice(2);
  if (
    !assetRootInput ||
    !workspaceInput ||
    !readyPath ||
    !continuePath ||
    !outcomePath ||
    !['compatible', 'incompatible'].includes(mode)
  ) {
    throw new Error('outer-Job parent arguments are incomplete');
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
  writeFileSync(readyPath, 'ready');
  await waitForFile(continuePath);

  const authority = installPrepared(workspace, helperDigest, bound);
  const targetMarker = join(workspace, 'outer-job-target-ran.txt');
  const data = {
    schemaVersion: 1,
    type: 'DATA',
    operationId: OPERATION_ID,
    target: {
      executable: realpathSync(process.execPath),
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(targetMarker)},'ran')`],
      cwd: workspace,
      environment: [
        { name: 'SystemRoot', value: process.env.SystemRoot },
        { name: 'TEMP', value: process.env.TEMP },
        { name: 'TMP', value: process.env.TMP },
      ],
    },
  };
  send(helper, 'DATA', data, { workspacePath: workspace });
  if (mode === 'incompatible') {
    const failure = await events.next('FAILURE');
    if (!String(failure.message).includes('CreateProcessW')) {
      throw new Error(
        `outer Job did not reject target creation atomically: ${JSON.stringify(failure)}`,
      );
    }
    const helperExit = await events.exit;
    const receiptPath = join(authority.operationPath, 'drained-receipt.json');
    const result = {
      mode,
      helperExitCode: helperExit.code,
      targetExecuted: existsSync(targetMarker),
      receiptCreated: existsSync(receiptPath),
      failureStage: 'CreateProcessW',
    };
    writeFileSync(outcomePath, JSON.stringify(result));
    if (
      helperExit.code !== 2 ||
      helperExit.signal !== null ||
      result.targetExecuted ||
      result.receiptCreated
    ) {
      throw new Error(`outer-Job failure contract was not preserved: ${JSON.stringify(result)}`);
    }
    return;
  }

  const armedEvent = await events.next('ARMED');
  const armedBytes = Buffer.from(
    JSON.stringify({
      ...authority.prepared,
      state: 'armed',
      containment: armedEvent.containment,
      containmentDigest: digest(jsonBytes(armedEvent.containment)),
    }),
    'utf8',
  );
  writeFileSync(authority.activePath, armedBytes);
  send(helper, 'START', {
    schemaVersion: 1,
    type: 'START',
    operationId: OPERATION_ID,
    activeChildDigest: digest(armedBytes),
  });
  await events.next('STARTED');
  const targetResult = await events.next('RESULT');
  const drained = await events.next('DRAINED');
  const drainedMessage = JSON.parse(Buffer.from(drained.messageBase64, 'base64').toString('utf8'));
  const receiptPath = join(authority.operationPath, 'drained-receipt.json');
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (
    targetResult.code !== 0 ||
    drainedMessage.receiptDigest !== digest(receiptBytes) ||
    receipt.proof !== 'windows-job-zero-pipes-eof-output-settled-v2' ||
    !existsSync(targetMarker)
  ) {
    throw new Error(
      `compatible outer Job did not preserve the drain contract: ${JSON.stringify({
        targetResult,
        drainedMessage,
        receipt,
      })}`,
    );
  }
  send(helper, 'ACK', {
    schemaVersion: 1,
    type: 'ACK',
    operationId: OPERATION_ID,
    receiptDigest: drainedMessage.receiptDigest,
  });
  const helperExit = await events.exit;
  const result = {
    mode,
    helperExitCode: helperExit.code,
    targetExecuted: existsSync(targetMarker),
    receiptCreated: existsSync(receiptPath),
    proof: receipt.proof,
  };
  writeFileSync(outcomePath, JSON.stringify(result));
  if (
    helperExit.code !== 0 ||
    helperExit.signal !== null ||
    !result.targetExecuted ||
    !result.receiptCreated
  ) {
    throw new Error(`compatible outer-Job contract was not preserved: ${JSON.stringify(result)}`);
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  const outcomePath = process.argv[6];
  if (outcomePath) {
    writeFileSync(
      outcomePath,
      JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }),
    );
  }
  process.exit(2);
}

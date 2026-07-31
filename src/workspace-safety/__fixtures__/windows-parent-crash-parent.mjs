import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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

function writeCommittedJson(path, value) {
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

class Events {
  constructor(child) {
    this.iterator = createInterface({ input: child.stdout, crlfDelay: Infinity })[
      Symbol.asyncIterator
    ]();
    this.stderr = '';
    this.outputTail = { stdout: '', stderr: '' };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
  }

  async next(expected) {
    while (true) {
      const step = await Promise.race([
        this.iterator.next(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `timed out waiting for ${expected}; helper stderr: ${this.stderr}; target stdout: ${this.outputTail.stdout}; target stderr: ${this.outputTail.stderr}`,
                ),
              ),
            45_000,
          ),
        ),
      ]);
      if (step.done) throw new Error(`helper exited before ${expected}: ${this.stderr}`);
      const event = JSON.parse(step.value);
      if (event.type === 'FAILURE') throw new Error(`helper failure: ${event.message}`);
      if (event.type === 'OUTPUT' && (event.stream === 'stdout' || event.stream === 'stderr')) {
        const output = Buffer.from(String(event.data), 'base64').toString('utf8');
        this.outputTail[event.stream] = `${this.outputTail[event.stream]}${output}`.slice(-8192);
      }
      if (event.type === expected) return event;
    }
  }
}

async function waitForFile(path, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
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
    workspaceIdentity: digest('parent-crash-workspace'),
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
    processIdentity: { kind: 'windows-filetime', value: 'parent-crash-parent' },
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
  return { activePath, prepared };
}

async function inspectSuspendedTarget({
  executable,
  role,
  pid,
  identity,
  outputPath,
  workspace,
  cleanupState,
  persistCleanupState,
}) {
  const inspectorIdentityPath = `${outputPath}.inspector.json`;
  cleanupState.inspectorIdentityPath = inspectorIdentityPath;
  delete cleanupState.inspectorIdentity;
  persistCleanupState();
  const inspector = spawn(
    executable,
    ['inspect', role, String(pid), identity, outputPath, inspectorIdentityPath],
    {
      cwd: workspace,
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  if (!inspector.pid) throw new Error(`${role} inspector did not expose a process id`);
  cleanupState.inspectorPid = inspector.pid;
  persistCleanupState();
  let stderr = '';
  inspector.stderr.setEncoding('utf8');
  inspector.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  let exited = false;
  try {
    const exitPromise = new Promise((resolve, reject) => {
      inspector.once('error', (error) => {
        reject(error);
      });
      inspector.once('exit', (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
    });
    const handshake = await Promise.race([
      waitForFile(inspectorIdentityPath, 5_000).then(() => 'identity'),
      exitPromise.then(() => 'exit'),
    ]);
    if (handshake === 'exit' && !existsSync(inspectorIdentityPath)) {
      throw new Error(`${role} inspector exited before binding its identity: ${stderr}`);
    }
    const inspectorIdentity = JSON.parse(readFileSync(inspectorIdentityPath, 'utf8'));
    if (
      inspectorIdentity.pid !== inspector.pid ||
      typeof inspectorIdentity.processIdentity !== 'string' ||
      !/^[0-9]+$/u.test(inspectorIdentity.processIdentity)
    ) {
      throw new Error(`${role} inspector identity handshake is invalid`);
    }
    cleanupState.inspectorIdentity = inspectorIdentity.processIdentity;
    persistCleanupState();
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 5000));
    const first = await Promise.race([exitPromise, timeout]);
    if (first.timedOut === true) {
      inspector.kill('SIGKILL');
      await Promise.race([
        exitPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${role} inspector could not be stopped`)), 5000),
        ),
      ]);
      throw new Error(`${role} inspector timed out`);
    }
    const exit = first;
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `${role} inspector failed with code ${String(exit.code)} and signal ${String(exit.signal)}: ${stderr}`,
      );
    }
    if (!existsSync(outputPath)) throw new Error(`${role} inspector did not write its snapshot`);
  } finally {
    if (exited) {
      delete cleanupState.inspectorPid;
      delete cleanupState.inspectorIdentity;
      delete cleanupState.inspectorIdentityPath;
      persistCleanupState();
    }
  }
}

async function main() {
  const [assetRootInput, workspaceInput, parentReadyPath, cleanupStatePath, handleExecutableInput] =
    process.argv.slice(2);
  if (
    !assetRootInput ||
    !workspaceInput ||
    !parentReadyPath ||
    !cleanupStatePath ||
    !handleExecutableInput
  ) {
    throw new Error('parent-crash fixture arguments are incomplete');
  }
  const assetRoot = realpathSync(assetRootInput);
  const workspace = realpathSync(workspaceInput);
  const handleExecutable = realpathSync(handleExecutableInput);
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
  if (!helper.pid) throw new Error('supervisor did not expose a process id');
  const cleanupState = {
    parentPid: process.pid,
    supervisorPid: helper.pid,
    supervisorIdentity: null,
  };
  const persistCleanupState = () => writeCommittedJson(cleanupStatePath, cleanupState);
  persistCleanupState();
  const events = new Events(helper);
  const bound = await events.next('BOUND');
  if (bound.supervisorPid !== helper.pid) {
    throw new Error('BOUND pid does not identify the directly spawned supervisor');
  }
  if (typeof bound.supervisorIdentity !== 'string' || !/^[0-9]+$/u.test(bound.supervisorIdentity)) {
    throw new Error('BOUND did not bind the supervisor identity');
  }
  cleanupState.supervisorIdentity = bound.supervisorIdentity;
  persistCleanupState();
  const authority = installPrepared(workspace, helperDigest, bound);
  const rootInventoryPath = join(workspace, 'root-handle-inventory.json');
  const rootRuntimeInventoryPath = join(workspace, 'root-runtime-handles.json');
  const descendantInventoryPath = join(workspace, 'descendant-handle-inventory.json');
  const descendantRuntimeInventoryPath = join(workspace, 'descendant-runtime-handles.json');
  const descendantCreatedPath = join(workspace, 'descendant-created.json');
  const descendantProceedPath = join(workspace, 'descendant-proceed');
  const targetReadyPath = join(workspace, 'handle-target-ready.json');
  send(
    helper,
    'DATA',
    {
      schemaVersion: 1,
      type: 'DATA',
      operationId: OPERATION_ID,
      target: {
        executable: handleExecutable,
        args: [
          'root',
          handleExecutable,
          rootRuntimeInventoryPath,
          descendantCreatedPath,
          descendantRuntimeInventoryPath,
          descendantProceedPath,
          targetReadyPath,
        ],
        cwd: workspace,
        environment: [
          { name: 'SystemRoot', value: process.env.SystemRoot },
          { name: 'TEMP', value: process.env.TEMP },
          { name: 'TMP', value: process.env.TMP },
        ],
      },
    },
    { workspacePath: workspace },
  );
  const armedEvent = await events.next('ARMED');
  const rootPid = Number(armedEvent.containment.targetPid);
  const rootIdentity = armedEvent.containment.targetIdentity;
  if (
    !Number.isSafeInteger(rootPid) ||
    rootPid <= 0 ||
    typeof rootIdentity !== 'string' ||
    !/^[0-9]+$/u.test(rootIdentity)
  ) {
    throw new Error('ARMED did not bind the suspended root identity');
  }
  cleanupState.rootPid = rootPid;
  cleanupState.rootIdentity = rootIdentity;
  persistCleanupState();
  await inspectSuspendedTarget({
    executable: handleExecutable,
    role: 'root-prestart',
    pid: rootPid,
    identity: rootIdentity,
    outputPath: rootInventoryPath,
    workspace,
    cleanupState,
    persistCleanupState,
  });
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
  const targetResult = events.next('RESULT').then((result) => {
    throw new Error(
      `handle inventory target exited before ready with code ${String(result.code)}; stdout: ${events.outputTail.stdout}; stderr: ${events.outputTail.stderr}`,
    );
  });
  await Promise.race([waitForFile(descendantCreatedPath), targetResult]);
  const descendantCreated = JSON.parse(readFileSync(descendantCreatedPath, 'utf8'));
  const descendantPid = Number(descendantCreated.descendantPid);
  if (
    !Number.isSafeInteger(descendantPid) ||
    descendantPid <= 0 ||
    descendantPid === rootPid ||
    typeof descendantCreated.descendantIdentity !== 'string'
  ) {
    throw new Error('root did not bind the suspended descendant identity');
  }
  cleanupState.descendantPid = descendantPid;
  cleanupState.descendantIdentity = descendantCreated.descendantIdentity;
  persistCleanupState();
  await inspectSuspendedTarget({
    executable: handleExecutable,
    role: 'descendant-prestart',
    pid: descendantPid,
    identity: descendantCreated.descendantIdentity,
    outputPath: descendantInventoryPath,
    workspace,
    cleanupState,
    persistCleanupState,
  });
  writeFileSync(descendantProceedPath, 'inspected');
  await Promise.race([waitForFile(targetReadyPath), targetResult]);
  const targetReady = JSON.parse(readFileSync(targetReadyPath, 'utf8'));
  if (targetReady.rootPid !== rootPid || targetReady.descendantPid !== descendantPid) {
    throw new Error('target ready identities do not match the inspected process tree');
  }
  persistCleanupState();
  writeCommittedJson(parentReadyPath, {
    parentPid: process.pid,
    supervisorPid: bound.supervisorPid,
    supervisorIdentity: bound.supervisorIdentity,
    rootPid: targetReady.rootPid,
    descendantPid: targetReady.descendantPid,
    rootIdentity,
    descendantIdentity: descendantCreated.descendantIdentity,
    rootInventoryPath,
    rootRuntimeInventoryPath,
    descendantInventoryPath,
    descendantRuntimeInventoryPath,
  });
  await new Promise(() => {});
}

try {
  await main();
  process.exit(0);
} catch (error) {
  const parentReadyPath = process.argv[4];
  if (parentReadyPath) {
    writeCommittedJson(parentReadyPath, {
      error: error instanceof Error ? error.stack : String(error),
    });
  }
  process.exit(2);
}

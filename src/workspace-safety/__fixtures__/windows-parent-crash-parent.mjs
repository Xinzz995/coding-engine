import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { createInterface } from 'node:readline';

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

async function waitForFile(path) {
  const deadline = Date.now() + 45_000;
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

async function main() {
  const [
    assetRootInput,
    workspaceInput,
    parentReadyPath,
    handleTargetInput,
    handleSourceInput,
    handleAssemblyInput = '',
  ] = process.argv.slice(2);
  if (
    !assetRootInput ||
    !workspaceInput ||
    !parentReadyPath ||
    !handleTargetInput ||
    !handleSourceInput
  ) {
    throw new Error('parent-crash fixture arguments are incomplete');
  }
  const assetRoot = realpathSync(assetRootInput);
  const workspace = realpathSync(workspaceInput);
  const handleTarget = realpathSync(handleTargetInput);
  const handleSource = realpathSync(handleSourceInput);
  const handleAssembly = handleAssemblyInput ? realpathSync(handleAssemblyInput) : '';
  const helperDigest = digest(helperBundle(assetRoot));
  const supervisor = join(assetRoot, SUPERVISOR_EXECUTABLE);
  const powershell = win32.join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
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
  const rootInventoryPath = join(workspace, 'root-handle-inventory.json');
  const descendantInventoryPath = join(workspace, 'descendant-handle-inventory.json');
  const targetReadyPath = join(workspace, 'handle-target-ready.json');
  send(
    helper,
    'DATA',
    {
      schemaVersion: 1,
      type: 'DATA',
      operationId: OPERATION_ID,
      target: {
        executable: powershell,
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          handleTarget,
          '-Mode',
          'root',
          '-SourcePath',
          handleSource,
          '-AssemblyPath',
          handleAssembly,
          '-PowerShellPath',
          powershell,
          '-ScriptPath',
          handleTarget,
          '-RootInventoryPath',
          rootInventoryPath,
          '-DescendantInventoryPath',
          descendantInventoryPath,
          '-ReadyPath',
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
  const armedBytes = Buffer.from(
    JSON.stringify({
      ...authority.prepared,
      state: 'armed',
      containment: armedEvent.containment,
      containmentDigest: digest(JSON.stringify(armedEvent.containment)),
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
  await Promise.race([
    waitForFile(targetReadyPath),
    events.next('RESULT').then((result) => {
      throw new Error(
        `handle inventory target exited before ready with code ${String(result.code)}; stdout: ${events.outputTail.stdout}; stderr: ${events.outputTail.stderr}`,
      );
    }),
  ]);
  const targetReady = JSON.parse(readFileSync(targetReadyPath, 'utf8'));
  writeFileSync(
    parentReadyPath,
    JSON.stringify({
      parentPid: process.pid,
      supervisorPid: bound.supervisorPid,
      rootPid: targetReady.rootPid,
      descendantPid: targetReady.descendantPid,
      rootInventoryPath,
      descendantInventoryPath,
    }),
  );
  await new Promise(() => {});
}

try {
  await main();
  process.exit(0);
} catch (error) {
  const parentReadyPath = process.argv[4];
  if (parentReadyPath) {
    writeFileSync(
      parentReadyPath,
      JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }),
    );
  }
  process.exit(2);
}

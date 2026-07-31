import { createHash } from 'node:crypto';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { canonicalJson } from './baseline-contract.js';
import { digestBytes, jsonBytes } from './filesystem.js';
import { createWindowsSupervisorLaunch, spawnWindowsJobSupervisor } from './windows-supervisor.js';

export const ASSET_ROOT = realpathSync(
  fileURLToPath(new URL('../../assets/workspace-safety', import.meta.url)),
);
export const CTRL_C_PARENT = fileURLToPath(
  new URL('./__fixtures__/windows-ctrl-c-parent.mjs', import.meta.url),
);
export const CTRL_C_DRIVER = fileURLToPath(
  new URL('./__fixtures__/windows-ctrl-c-driver.ps1', import.meta.url),
);
export const CTRL_C_DRIVER_SOURCE = fileURLToPath(
  new URL('./__fixtures__/WindowsCtrlCDriver.cs', import.meta.url),
);
export const OUTER_JOB_PARENT = fileURLToPath(
  new URL('./__fixtures__/windows-outer-job-parent.mjs', import.meta.url),
);
export const OUTER_JOB_DRIVER = fileURLToPath(
  new URL('./__fixtures__/windows-outer-job-driver.ps1', import.meta.url),
);
export const BREAKAWAY_TARGET = fileURLToPath(
  new URL('./__fixtures__/windows-breakaway-target.ps1', import.meta.url),
);
export const BREAKAWAY_SOURCE = fileURLToPath(
  new URL('./__fixtures__/WindowsBreakawayAttempt.cs', import.meta.url),
);
export const HANDLE_INVENTORY_SOURCE = fileURLToPath(
  new URL('./__fixtures__/WindowsHandleInventory.cs', import.meta.url),
);
export const PARENT_CRASH_PARENT = fileURLToPath(
  new URL('./__fixtures__/windows-parent-crash-parent.mjs', import.meta.url),
);

export const DIGEST = (value: string | Buffer): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const containmentDigestFor = (value: unknown): string => digestBytes(jsonBytes(value));
export const OPERATION_ID = '12345678-1234-4234-8234-123456789abc';
const OWNER_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
export const created: string[] = [];
const activeChildren = new Set<ChildProcess>();

export function trackActiveChild<T extends ChildProcess>(child: T): T {
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
  return child;
}

export async function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 5000,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`child process ${String(child.pid)} remained alive`));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

afterEach(async () => {
  await Promise.all(
    [...activeChildren].map(
      (child) =>
        new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.off('exit', finish);
            resolve();
          };
          const timer = setTimeout(finish, 5_000);
          child.once('exit', finish);
          if (child.exitCode !== null || child.signalCode !== null) return finish();
          child.kill('SIGKILL');
        }),
    ),
  );
  activeChildren.clear();
  for (const path of created.splice(0)) {
    rmSync(path, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
  }
});

export function createWindowsWorkspace(label: string): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), `coding-x-windows-${label}-`)));
  created.push(workspace);
  return workspace;
}

export function windowsEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Windows\\Temp',
    TMP: 'C:\\Windows\\Temp',
    ...extra,
  };
}

export interface ProtocolEvent {
  readonly schemaVersion: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

export class EventReader {
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly errors: string[] = [];
  readonly outputBytes = { stdout: 0, stderr: 0 };
  readonly outputTail = { stdout: '', stderr: '' };
  #iterator: AsyncIterator<string>;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly eventTimeoutMs = 15_000,
  ) {
    activeChildren.add(child);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#iterator = lines[Symbol.asyncIterator]();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.errors.push(chunk));
    this.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        activeChildren.delete(child);
        resolve({ code, signal });
      });
    });
  }

  async next(expected: string): Promise<ProtocolEvent> {
    while (true) {
      const step = await Promise.race([
        this.#iterator.next(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `timed out waiting for ${expected}; helper stderr: ${this.errors.join('')}; target stdout: ${this.outputTail.stdout}; target stderr: ${this.outputTail.stderr}`,
                ),
              ),
            this.eventTimeoutMs,
          ),
        ),
      ]);
      if (step.done)
        throw new Error(`supervisor exited before ${expected}: ${this.errors.join('')}`);
      const event = JSON.parse(step.value) as ProtocolEvent;
      if (event.type === 'FAILURE') throw new Error(`supervisor failure: ${String(event.message)}`);
      if (event.type === 'OUTPUT' && (event.stream === 'stdout' || event.stream === 'stderr')) {
        const output = Buffer.from(String(event.data), 'base64');
        this.outputBytes[event.stream] += output.length;
        this.outputTail[event.stream] =
          `${this.outputTail[event.stream]}${output.toString('utf8')}`.slice(-8_192);
      }
      if (event.type === expected) return event;
    }
  }
}

export function sendEmbedded(
  child: ChildProcessWithoutNullStreams,
  type: string,
  message: Record<string, unknown>,
): void {
  child.stdin.write(
    `${JSON.stringify({
      schemaVersion: 1,
      type,
      messageBase64: Buffer.from(JSON.stringify(message), 'utf8').toString('base64'),
    })}\n`,
  );
}

export type PreparedSemanticFixture =
  | {
      readonly kind: 'builder';
      readonly delegation: 'builder-v1';
      readonly semantic: {
        readonly version: 'builder-state-v1';
        readonly storyId: string;
        readonly acceptanceHash: string;
        readonly checkCount: number;
      };
    }
  | {
      readonly kind: 'validator';
      readonly delegation: 'validator-v1';
      readonly semantic: {
        readonly version: 'validator-result-v1';
        readonly requestId: string;
        readonly storyId: string;
        readonly acceptanceHash: string;
        readonly checkCount: number;
        readonly gitHead: string;
      };
    }
  | {
      readonly kind: 'final-review';
      readonly delegation: 'read-only-v1';
      readonly semantic: { readonly version: 'read-only-v1' };
    };

export function installPreparedAuthority(
  workspace: string,
  helperDigest: string,
  bound: ProtocolEvent,
  fixture: PreparedSemanticFixture = {
    kind: 'final-review',
    delegation: 'read-only-v1',
    semantic: { version: 'read-only-v1' },
  },
  baselineEntries: readonly unknown[] = [],
): {
  readonly activePath: string;
  readonly baselineBytes: Buffer;
  readonly prepared: Record<string, unknown>;
} {
  const timestamp = new Date().toISOString();
  const protocol = {
    schemaVersion: 1,
    protocol: 'coding-x-workspace-lease-v1',
    workspaceIdentity: DIGEST('workspace-identity'),
    createdBy: '0.34.0',
    createdAt: timestamp,
  };
  const protocolBytes = Buffer.from(JSON.stringify(protocol), 'utf8');
  const marker = {
    schemaVersion: 2,
    initializedBy: '0.34.0',
    workspaceIdentity: protocol.workspaceIdentity,
    protocolDigest: DIGEST(protocolBytes),
    initializedAt: timestamp,
  };
  const owner = {
    schemaVersion: 2,
    ownerId: OWNER_ID,
    pid: process.pid,
    processIdentity: { kind: 'windows-filetime', value: 'test-owner' },
    bootIdentity: DIGEST('boot'),
    hostId: DIGEST('host'),
    workspaceIdentity: protocol.workspaceIdentity,
    startedAt: timestamp,
    command: 'run',
  };
  const contract = {
    version: fixture.delegation,
    semantic: fixture.semantic,
    rules: [],
  };
  const baseline = {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    operationId: OPERATION_ID,
    workspaceIdentity: protocol.workspaceIdentity,
    contract,
    contractDigest: DIGEST(canonicalJson(contract)),
    entries: baselineEntries,
    capturedAt: timestamp,
    manifestDigest: DIGEST('manifest'),
  };
  const baselineBytes = Buffer.from(JSON.stringify(baseline), 'utf8');
  const prepared = {
    schemaVersion: 2,
    ownerId: OWNER_ID,
    operationId: OPERATION_ID,
    state: 'prepared-bound',
    kind: fixture.kind,
    delegation: fixture.delegation,
    platform: 'windows-job-v1',
    helperDigest,
    delegatedBaselineDigest: DIGEST(baselineBytes),
    delegationContractDigest: baseline.contractDigest,
    startedAt: timestamp,
    updatedAt: timestamp,
    supervisorPid: bound.supervisorPid,
    supervisorIdentity: bound.supervisorIdentity,
    signalIsolation: 'windows-new-process-group-ctrl-c-ignore-v1',
  };
  const operation = join(workspace, 'engine.lock', 'lease', 'operation');
  mkdirSync(operation, { recursive: true });
  writeFileSync(join(workspace, 'workspace-safety.json'), JSON.stringify(marker));
  writeFileSync(join(workspace, 'engine.lock', 'protocol.json'), protocolBytes);
  writeFileSync(join(workspace, 'engine.lock', 'lease', 'owner.json'), JSON.stringify(owner));
  writeFileSync(join(operation, 'delegated-baseline.json'), baselineBytes);
  const activePath = join(operation, 'active-child.json');
  writeFileSync(activePath, JSON.stringify(prepared));
  return { activePath, baselineBytes, prepared };
}

export function sendData(
  child: ChildProcessWithoutNullStreams,
  workspace: string,
  executable: string,
  args: readonly string[],
  environment: readonly {
    readonly name: string;
    readonly value: string;
  }[],
): void {
  const message = {
    schemaVersion: 1,
    type: 'DATA',
    operationId: OPERATION_ID,
    target: { executable, args, cwd: workspace, environment },
  };
  child.stdin.write(
    `${JSON.stringify({
      schemaVersion: 1,
      type: 'DATA',
      workspacePath: workspace,
      messageBase64: Buffer.from(JSON.stringify(message), 'utf8').toString('base64'),
    })}\n`,
  );
}

export function installArmedAuthority(
  authority: { readonly activePath: string; readonly prepared: Record<string, unknown> },
  containment: Record<string, unknown>,
): Buffer {
  const armedBytes = Buffer.from(
    JSON.stringify({
      ...authority.prepared,
      state: 'armed',
      containment,
      containmentDigest: containmentDigestFor(containment),
    }),
    'utf8',
  );
  writeFileSync(authority.activePath, armedBytes);
  return armedBytes;
}

export async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

export async function waitForProcessGone(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} remained alive`);
}

export async function runOuterJobScenario(mode: 'compatible' | 'incompatible'): Promise<{
  readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  readonly stderr: string;
  readonly result: Record<string, unknown>;
}> {
  const workspace = createWindowsWorkspace(`outer-${mode}`);
  const ready = join(workspace, 'outer-job-ready.txt');
  const proceed = join(workspace, 'outer-job-continue.txt');
  const outcome = join(workspace, 'outer-job-outcome.json');
  const powershell = win32.join(
    process.env.SystemRoot!,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const driver = spawn(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      OUTER_JOB_DRIVER,
      '-SourcePath',
      CTRL_C_DRIVER_SOURCE,
      '-AssemblyPath',
      process.env.CODING_X_WINDOWS_CTRL_C_DRIVER_ASSEMBLY ?? '',
      '-NodePath',
      realpathSync(process.execPath),
      '-WorkerPath',
      OUTER_JOB_PARENT,
      '-AssetRoot',
      ASSET_ROOT,
      '-Workspace',
      workspace,
      '-ReadyPath',
      ready,
      '-ContinuePath',
      proceed,
      '-OutcomePath',
      outcome,
      '-Mode',
      mode,
    ],
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
  let stderr = '';
  driver.stderr.setEncoding('utf8');
  driver.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => driver.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const result = existsSync(outcome)
    ? (JSON.parse(readFileSync(outcome, 'utf8')) as Record<string, unknown>)
    : {};
  return { exit, stderr, result };
}

export function createSupervisor() {
  const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
  const child = spawnWindowsJobSupervisor(launch);
  return { launch, child, events: new EventReader(child) };
}

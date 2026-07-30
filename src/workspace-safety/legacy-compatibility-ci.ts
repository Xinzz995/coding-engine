import { strict as assert } from 'node:assert';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { readQualityContract } from '../quality/contract.js';
import { bootstrapWorkspace } from './bootstrap.js';
import { acquireWorkspaceLease } from './lease.js';
import { ACTIVE_LEASE_DIR, PROTOCOL_ROOT_DIR, WORKSPACE_MARKER_FILE } from './types.js';

const LEGACY_VERSION = '0.33.3';
const LEGACY_PACKAGE = `coding-x@${LEGACY_VERSION}`;
const LEGACY_TARBALL = `coding-x-${LEGACY_VERSION}.tgz`;
const LEGACY_INTEGRITY =
  'sha512-qpKCXqc7Vk6Irj+/+aozapYYBqtggkQt4vvORjFRleF2kWkbOQj7/tCLOulSwZbwTzeDQsnCwNj0ZlR/AZY66g==';
const LEGACY_DEPENDENCY_VERSION = '3.15.0';
const LEGACY_DEPENDENCY_PACKAGE = `jsonrepair@${LEGACY_DEPENDENCY_VERSION}`;
const LEGACY_DEPENDENCY_TARBALL = `jsonrepair-${LEGACY_DEPENDENCY_VERSION}.tgz`;
const LEGACY_DEPENDENCY_INTEGRITY =
  'sha512-wy8OTjwsJwQRnQJkKnMJJ9vcytRdBPAgIF/Hy6+s1dAj42BHMKiyL8JzEieIl3JY7idt8eyHwBWTO8mh/+mtwA==';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;

interface CommandResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

interface RunningLegacyCommand {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly result: Promise<CommandResult>;
}

function boundedAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(-MAX_CAPTURE_BYTES);
}

function exactTemporaryRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-legacy-0333-')));
}

function npmCliPath(): string {
  const value = process.env.npm_execpath;
  assert.ok(
    value && isAbsolute(value) && existsSync(value),
    'npm_execpath must identify npm-cli.js',
  );
  return value;
}

function runNpm(args: readonly string[], cwd: string): void {
  const result = spawnSync(process.execPath, [npmCliPath(), ...args], {
    cwd,
    env: { ...process.env },
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURE_BYTES,
    timeout: 120_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `npm ${args[0] ?? 'command'} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function downloadFrozenTarball(
  root: string,
  download: string,
  packageSpec: string,
  filename: string,
  expectedIntegrity: string,
): string {
  runNpm(
    [
      'pack',
      packageSpec,
      '--ignore-scripts',
      '--pack-destination',
      download,
      `--registry=${NPM_REGISTRY}`,
    ],
    root,
  );
  const tarball = join(download, filename);
  assert.ok(existsSync(tarball), `npm did not download ${filename}`);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  assert.equal(integrity, expectedIntegrity, `${packageSpec} tarball integrity changed`);
  return tarball;
}

function installFrozenLegacyPackage(root: string): string {
  const download = join(root, 'download');
  const install = join(root, 'install');
  mkdirSync(download);
  mkdirSync(install);
  writeFileSync(
    join(install, 'package.json'),
    `${JSON.stringify({ private: true, dependencies: { jsonrepair: LEGACY_DEPENDENCY_VERSION } })}\n`,
  );

  const tarball = downloadFrozenTarball(
    root,
    download,
    LEGACY_PACKAGE,
    LEGACY_TARBALL,
    LEGACY_INTEGRITY,
  );
  const dependencyTarball = downloadFrozenTarball(
    root,
    download,
    LEGACY_DEPENDENCY_PACKAGE,
    LEGACY_DEPENDENCY_TARBALL,
    LEGACY_DEPENDENCY_INTEGRITY,
  );

  runNpm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-save',
      `--registry=${NPM_REGISTRY}`,
      '--prefix',
      install,
      tarball,
      dependencyTarball,
    ],
    root,
  );
  const packageRoot = join(install, 'node_modules', 'coding-x');
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    name?: unknown;
    version?: unknown;
    dependencies?: Record<string, unknown>;
  };
  assert.deepEqual(
    { name: packageJson.name, version: packageJson.version },
    { name: 'coding-x', version: LEGACY_VERSION },
  );
  assert.equal(packageJson.dependencies?.jsonrepair, '^3.15.0');
  const dependencyRoot = join(install, 'node_modules', 'jsonrepair');
  const dependencyJson = JSON.parse(readFileSync(join(dependencyRoot, 'package.json'), 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  assert.deepEqual(
    { name: dependencyJson.name, version: dependencyJson.version },
    { name: 'jsonrepair', version: LEGACY_DEPENDENCY_VERSION },
  );
  assert.equal(
    existsSync(join(packageRoot, 'node_modules', 'jsonrepair')),
    false,
    'legacy package resolved an unfrozen nested jsonrepair dependency',
  );
  const cli = join(packageRoot, 'dist', 'cli.js');
  assert.ok(existsSync(cli), 'installed 0.33.3 package has no dist/cli.js');
  return cli;
}

function treeSnapshot(root: string): string {
  const rows: Array<Record<string, unknown>> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll('\\', '/');
      const info = lstatSync(absolute);
      assert.equal(info.isSymbolicLink(), false, `snapshot path is a symlink: ${path}`);
      if (entry.isDirectory()) {
        rows.push({ path, type: 'directory' });
        walk(absolute);
      } else {
        assert.equal(entry.isFile(), true, `snapshot path is not an ordinary file: ${path}`);
        const bytes = readFileSync(absolute);
        rows.push({
          path,
          type: 'file',
          bytes: bytes.length,
          digest: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  };
  walk(root);
  return JSON.stringify(rows);
}

function safetySnapshot(workspace: string): string {
  const marker = join(workspace, WORKSPACE_MARKER_FILE);
  const root = join(workspace, PROTOCOL_ROOT_DIR);
  assert.ok(existsSync(marker), 'new workspace marker is missing');
  assert.ok(existsSync(root), 'new protocol root is missing');
  const markerBytes = readFileSync(marker);
  return JSON.stringify({
    markerDigest: createHash('sha256').update(markerBytes).digest('hex'),
    protocolTree: treeSnapshot(root),
  });
}

function runLegacySync(
  cli: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly environment?: NodeJS.ProcessEnv },
): CommandResult {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.environment },
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURE_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function runLegacyAsync(
  cli: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
): RunningLegacyCommand {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.environment },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = boundedAppend(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = boundedAppend(stderr, chunk);
  });
  const result = new Promise<CommandResult>((resolveResult) => {
    child.once('error', (error) => {
      resolveResult({ status: null, signal: null, stdout, stderr, error });
    });
    child.once('close', (status, signal) => {
      resolveResult({ status, signal, stdout, stderr });
    });
  });
  return { child, result };
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForPath(path: string, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < COMMAND_TIMEOUT_MS) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`${label} did not appear`);
}

function assertRejectedWithoutWrite(
  cli: string,
  projectRoot: string,
  workspace: string,
  command: 'run' | 'repair',
): void {
  const before = treeSnapshot(workspace);
  const args =
    command === 'run'
      ? ['claude', '--workspace', workspace, '--max-iter', '1', '--no-open', '--port', '0']
      : ['repair', '--workspace', workspace];
  const result = runLegacySync(cli, args, { cwd: projectRoot });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${command} terminated by ${String(result.signal)}`);
  assert.equal(
    result.status,
    2,
    `legacy ${command} did not reject the directory fence\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(treeSnapshot(workspace), before, `legacy ${command} changed workspace bytes`);
}

function minimalReportPrd(): Record<string, unknown> {
  return {
    project: 'legacy compatibility proof',
    branchName: 'compat/legacy-0333',
    sourcePrd: 'frozen fixture',
    userStories: [
      {
        id: 'US-001',
        title: 'Keep the compatibility boundary honest',
        description: 'A frozen fixture used only by the three-platform compatibility proof.',
        acceptanceCriteria: ['The fixture remains deterministic.'],
        priority: 1,
        passes: false,
        notes: '',
      },
    ],
  };
}

async function proveReadyAndActiveAcquire(
  root: string,
  cli: string,
  projectRoot: string,
): Promise<void> {
  const ready = join(root, 'ready-workspace');
  await bootstrapWorkspace({ workspacePath: ready });
  assert.equal(existsSync(join(ready, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR)), false);
  assertRejectedWithoutWrite(cli, projectRoot, ready, 'run');
  assertRejectedWithoutWrite(cli, projectRoot, ready, 'repair');

  const active = join(root, 'active-workspace');
  await bootstrapWorkspace({ workspacePath: active });
  const lease = await acquireWorkspaceLease({
    workspacePath: active,
    command: 'run',
  });
  try {
    assert.ok(existsSync(join(active, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR)));
    assertRejectedWithoutWrite(cli, projectRoot, active, 'run');
    assertRejectedWithoutWrite(cli, projectRoot, active, 'repair');
  } finally {
    await lease.release();
  }
}

async function proveReportBypass(root: string, cli: string, projectRoot: string): Promise<void> {
  const workspace = join(root, 'report-workspace');
  await bootstrapWorkspace({
    workspacePath: workspace,
  });
  writeFileSync(join(workspace, 'prd.json'), `${JSON.stringify(minimalReportPrd(), null, 2)}\n`);
  const before = safetySnapshot(workspace);
  const result = runLegacySync(cli, ['report', '--workspace', workspace], { cwd: projectRoot });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `legacy report did not preserve the documented bypass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.ok(existsSync(join(workspace, 'report.html')), 'legacy report did not write report.html');
  assert.match(readFileSync(join(workspace, 'report.html'), 'utf8'), /coding-x report/u);
  assert.equal(safetySnapshot(workspace), before, 'legacy report changed new safety records');
}

function writeInFlightPrd(workspace: string, projectRoot: string): void {
  const quality = readQualityContract(projectRoot);
  assert.equal(quality.status, 'ready', `quality contract is not ready: ${quality.status}`);
  if (quality.status !== 'ready') return;
  const prd = {
    ...minimalReportPrd(),
    qualityContractDigest: quality.digest,
    qualityChecks: quality.contract.checks,
  };
  writeFileSync(join(workspace, 'prd.json'), `${JSON.stringify(prd, null, 2)}\n`);
}

function moveWorkspaceAside(workspace: string, holding: string): Record<string, unknown> {
  mkdirSync(holding);
  for (const entry of readdirSync(workspace).sort()) {
    renameSync(join(workspace, entry), join(holding, entry));
  }
  const oldLock = join(holding, PROTOCOL_ROOT_DIR);
  assert.equal(lstatSync(oldLock).isFile(), true, 'old run did not own the legacy file lock');
  return JSON.parse(readFileSync(oldLock, 'utf8')) as Record<string, unknown>;
}

function restoreBusinessFiles(workspace: string, holding: string): void {
  for (const entry of readdirSync(holding).sort()) {
    if (entry === PROTOCOL_ROOT_DIR || entry === WORKSPACE_MARKER_FILE) continue;
    renameSync(join(holding, entry), join(workspace, entry));
  }
}

async function proveInFlightOldHandleCannotBeFenced(
  root: string,
  cli: string,
  projectRoot: string,
): Promise<void> {
  const workspace = join(root, 'in-flight-workspace');
  const control = join(root, 'in-flight-control');
  const holding = join(root, 'in-flight-holding');
  mkdirSync(workspace);
  mkdirSync(control);
  writeInFlightPrd(workspace, projectRoot);

  const modelConfig = join(control, 'model-config.json');
  writeFileSync(
    modelConfig,
    `${JSON.stringify({ version: 1, models: { claude: [{ id: 'compat-model' }] } }, null, 2)}\n`,
  );
  // 0.33.3 splits the override on spaces. Use a PATH-resolved executable and a
  // repository-relative fixed fixture so Program Files paths never enter that
  // frozen parser; the downloaded package and its behavior remain unchanged.
  const agentCommand = 'node src/workspace-safety/__fixtures__/legacy-compatibility-agent.mjs';

  const command = runLegacyAsync(
    cli,
    [
      'claude',
      '--workspace',
      workspace,
      '--max-iter',
      '2',
      '--stall-limit',
      '2',
      '--dev-timeout',
      '1',
      '--val-timeout',
      '1',
      '--builder-model',
      'compat-model',
      '--validator-model',
      'compat-model',
      '--review-model',
      'compat-model',
      '--no-open',
      '--port',
      '0',
    ],
    {
      cwd: projectRoot,
      environment: {
        CODING_X_CLAUDE_BIN: agentCommand,
        CODING_X_CONFIG: modelConfig,
        CODING_X_LEGACY_COMPAT_CONTROL: control,
      },
    },
  );

  const continuePath = join(control, 'agent-continue');
  try {
    await waitForPath(join(control, 'agent-started'), 'first legacy Builder invocation');
    const oldOwner = moveWorkspaceAside(workspace, holding);
    assert.equal(
      oldOwner.pid,
      command.child.pid,
      'legacy lock was not owned by the tested process',
    );

    await bootstrapWorkspace({
      workspacePath: workspace,
    });
    restoreBusinessFiles(workspace, holding);
    const beforeResume = safetySnapshot(workspace);
    writeFileSync(continuePath, 'continue');

    const result = await withTimeout(command.result, 'in-flight legacy run');
    assert.ifError(result.error);
    assert.equal(
      result.status,
      1,
      `in-flight legacy run returned an unexpected result\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(
      readFileSync(join(control, 'agent-count'), 'utf8'),
      '2',
      'legacy verify unexpectedly fenced the already-running writer before its second iteration',
    );
    assert.equal(
      safetySnapshot(workspace),
      beforeResume,
      'legacy verify or release removed or changed the new protocol directory',
    );
  } finally {
    writeFileSync(continuePath, 'continue');
    if (command.child.exitCode === null && command.child.signalCode === null) command.child.kill();
    await Promise.race([
      command.result,
      new Promise<void>((resolveWait) => setTimeout(resolveWait, 5000)),
    ]);
  }
}

async function main(): Promise<void> {
  const projectRoot = realpathSync(resolve(process.cwd()));
  const root = exactTemporaryRoot();
  try {
    const cli = installFrozenLegacyPackage(root);
    await proveReadyAndActiveAcquire(root, cli, projectRoot);
    await proveReportBypass(root, cli, projectRoot);
    await proveInFlightOldHandleCannotBeFenced(root, cli, projectRoot);
    console.log(
      JSON.stringify(
        {
          status: 'passed',
          platform: process.platform,
          node: process.version,
          package: LEGACY_PACKAGE,
          integrity: LEGACY_INTEGRITY,
          dependency: LEGACY_DEPENDENCY_PACKAGE,
          dependencyIntegrity: LEGACY_DEPENDENCY_INTEGRITY,
          proved: [
            'ready-and-active-run-repair-reject-without-write',
            'report-remains-an-explicit-unlocked-write-bypass',
            'in-flight-old-verify-continues-but-verify-release-cannot-remove-new-directory',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

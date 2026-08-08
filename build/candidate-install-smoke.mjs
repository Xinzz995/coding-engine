#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_NAME = 'coding-x';
const CANDIDATE_WORKFLOW = '.github/workflows/build-candidate.yml';
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9]\d*$/u;
const SHA_256 = /^[0-9a-f]{64}$/u;
const SUPPORTED_OS = ['darwin', 'linux', 'win32'];
const POSIX_HELPERS = [
  'posix-launcher-helper.mjs',
  'posix-supervisor-core.mjs',
  'posix-supervisor-helper.mjs',
];
const WINDOWS_HELPERS = ['coding-x-windows-path-inspector.exe', 'coding-x-windows-supervisor.exe'];
const PLATFORM_TO_NODE = {
  linux: 'linux',
  macos: 'darwin',
  windows: 'win32',
};
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_FILE_BYTES = 64 * 1024 * 1024;
const WINDOWS_SYSTEM_COMMAND_PROCESSOR = 'C:\\Windows\\System32\\cmd.exe';
const WINDOWS_COMMAND_TOKEN = /^[A-Za-z0-9_ .:\\/\-]+$/u;

function fail(message) {
  throw new Error(`candidate install smoke failed: ${message}`);
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function readStableCandidateFile(
  path,
  { label = 'candidate file', maxBytes = MAX_CANDIDATE_FILE_BYTES, afterOpen } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail(`${label} size limit is invalid`);
  let descriptor;
  try {
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    const nonBlock = process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0);
    descriptor = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size < 1n ||
      opened.size > BigInt(maxBytes)
    ) {
      fail(`${label} must be a non-empty bounded single-link regular file`);
    }
    afterOpen?.();
    const openedPath = lstatSync(path, { bigint: true });
    if (
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      openedPath.nlink !== 1n ||
      !sameFileSnapshot(opened, openedPath)
    ) {
      fail(`${label} identity changed after it was opened`);
    }
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const trailing = Buffer.allocUnsafe(1);
    const hasTrailingByte = readSync(descriptor, trailing, 0, 1, null) !== 0;
    const afterHandle = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      offset !== bytes.length ||
      hasTrailingByte ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink !== 1n ||
      !sameFileSnapshot(opened, afterHandle) ||
      !sameFileSnapshot(afterHandle, afterPath) ||
      BigInt(bytes.length) !== afterHandle.size
    ) {
      fail(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(
      readStableCandidateFile(path, { label })
        .toString('utf8')
        .replace(/^\uFEFF/u, ''),
    );
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactString(value, expected, label) {
  if (value !== expected)
    fail(`${label} mismatch: expected ${expected}, received ${String(value)}`);
}

function requiredPath(value, label) {
  if (typeof value !== 'string' || value === '') fail(`${label} is required`);
  return resolve(value);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`invalid argument pair near ${String(flag)}`);
    }
    const name = flag.slice(2);
    if (Object.hasOwn(values, name)) fail(`duplicate argument --${name}`);
    values[name] = value;
  }
  const allowed = new Set([
    'evidence',
    'tarball',
    'expected-version',
    'expected-commit',
    'candidate-workflow-run-id',
    'expected-platform',
    'project-root',
    'temp-root',
  ]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) fail(`unknown argument --${name}`);
  }
  for (const name of allowed) {
    if (!Object.hasOwn(values, name)) fail(`missing --${name}`);
  }
  return {
    evidencePath: values.evidence,
    tarballPath: values.tarball,
    expectedVersion: values['expected-version'],
    expectedCommit: values['expected-commit'],
    expectedRunId: values['candidate-workflow-run-id'],
    expectedPlatform: values['expected-platform'],
    projectRoot: values['project-root'],
    tempRoot: values['temp-root'],
  };
}

export function candidatePlatform(platform) {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  fail(`unsupported Node platform ${String(platform)}`);
}

export function validateCandidateIdentity(options) {
  const {
    evidence,
    tarballPath,
    expectedVersion,
    expectedCommit,
    expectedRunId,
    expectedPlatform,
    actualPlatform,
  } = options;
  if (!EXACT_VERSION.test(expectedVersion)) fail(`invalid expected version ${expectedVersion}`);
  if (!GIT_SHA.test(expectedCommit)) fail(`invalid expected commit ${expectedCommit}`);
  if (!RUN_ID.test(expectedRunId)) fail(`invalid candidate workflow run ID ${expectedRunId}`);
  if (!Object.hasOwn(PLATFORM_TO_NODE, expectedPlatform)) {
    fail(`invalid expected platform ${String(expectedPlatform)}`);
  }
  exactString(
    actualPlatform,
    PLATFORM_TO_NODE[expectedPlatform],
    `runner platform for ${expectedPlatform}`,
  );
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('packed evidence must be an object');
  }
  if (evidence.schemaVersion !== 2) fail('packed evidence schemaVersion must be 2');
  exactString(evidence.status, 'packed', 'packed evidence status');
  exactString(evidence.packageName, PACKAGE_NAME, 'packed evidence package name');
  exactString(evidence.sourceRef, 'refs/heads/main', 'packed evidence source ref');
  exactString(evidence.sourceWorkflow, CANDIDATE_WORKFLOW, 'packed evidence source workflow');
  exactString(evidence.version, expectedVersion, 'packed evidence version');
  exactString(evidence.commit, expectedCommit, 'packed evidence commit');
  exactString(
    evidence.candidateWorkflowRunId,
    expectedRunId,
    'packed evidence candidate workflow run ID',
  );
  if (
    !evidence.tarball ||
    typeof evidence.tarball !== 'object' ||
    Array.isArray(evidence.tarball)
  ) {
    fail('packed evidence tarball identity is missing');
  }
  exactString(
    evidence.tarball.filename,
    `${PACKAGE_NAME}-${expectedVersion}.tgz`,
    'packed evidence tarball filename',
  );
  exactString(basename(tarballPath), evidence.tarball.filename, 'downloaded tarball filename');
  if (
    !Number.isSafeInteger(evidence.tarball.size) ||
    evidence.tarball.size < 1 ||
    evidence.tarball.size > MAX_CANDIDATE_FILE_BYTES
  ) {
    fail('packed evidence tarball size is invalid');
  }
  const tarballBytes = readStableCandidateFile(tarballPath, {
    label: 'downloaded tarball',
    maxBytes: evidence.tarball.size,
  });
  if (evidence.tarball.size !== tarballBytes.byteLength) {
    fail(
      `downloaded tarball size mismatch: expected ${String(evidence.tarball.size)}, received ${String(tarballBytes.byteLength)}`,
    );
  }
  if (!SHA_256.test(evidence.tarball.sha256 ?? '')) fail('packed evidence SHA-256 is invalid');
  const actualSha256 = sha256(tarballBytes);
  exactString(actualSha256, evidence.tarball.sha256, 'downloaded tarball SHA-256');
  return {
    version: expectedVersion,
    commit: expectedCommit,
    candidateWorkflowRunId: expectedRunId,
    platform: expectedPlatform,
    sha256: actualSha256,
    tarballBytes,
  };
}

function assertProjectHead(projectRoot, expectedCommit) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
  });
  if (result.error) fail(`cannot read checkout HEAD: ${result.error.message}`);
  if (result.status !== 0 || result.signal !== null) {
    fail(
      `cannot read checkout HEAD (exit=${String(result.status)}, signal=${String(result.signal)})`,
    );
  }
  exactString(result.stdout.trim(), expectedCommit, 'checkout HEAD');
}

function equalStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    [...actual].sort().every((entry, index) => entry === [...expected].sort()[index])
  );
}

function installedFileBytes(path, label) {
  try {
    return readStableCandidateFile(path, { label });
  } catch (error) {
    fail(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertInstalledPlatformHelpers(packageRoot, expectedPlatform) {
  const helperRoot = join(packageRoot, 'dist', 'workspace-safety');
  if (expectedPlatform === 'windows') {
    for (const name of WINDOWS_HELPERS) {
      const path = join(helperRoot, name);
      const bytes = installedFileBytes(path, `installed Windows helper ${name}`);
      if (!bytes.subarray(0, 2).equals(Buffer.from('MZ'))) {
        fail(`installed Windows helper ${name} does not have an MZ executable header`);
      }
    }
    return;
  }
  for (const name of POSIX_HELPERS) {
    installedFileBytes(join(helperRoot, name), `installed POSIX helper ${name}`);
  }
}

export function assertInstalledCandidate(installRoot, expectedVersion, expectedPlatform) {
  const packageRoot = join(installRoot, 'node_modules', PACKAGE_NAME);
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = readJson(packageJsonPath, 'installed package.json');
  exactString(packageJson.name, PACKAGE_NAME, 'installed package name');
  exactString(packageJson.version, expectedVersion, 'installed package version');
  if (!equalStringSet(packageJson.os, SUPPORTED_OS)) {
    fail(`installed package os allowlist must be ${SUPPORTED_OS.join(', ')}`);
  }
  exactString(packageJson.bin?.[PACKAGE_NAME], 'dist/cli.js', 'installed package bin');
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  installedFileBytes(cliPath, 'installed dist CLI');
  assertInstalledPlatformHelpers(packageRoot, expectedPlatform);

  const binRoot = join(installRoot, 'node_modules', '.bin');
  if (expectedPlatform === 'windows') {
    const commandPath = join(binRoot, 'coding-x.cmd');
    const command = installedFileBytes(commandPath, 'npm Windows bin').toString('utf8');
    if (!/\.\.[\\/]coding-x[\\/]dist[\\/]cli\.js/iu.test(command)) {
      fail('npm Windows bin does not target coding-x/dist/cli.js');
    }
    return commandPath;
  }

  const commandPath = join(binRoot, PACKAGE_NAME);
  let commandInfo;
  try {
    commandInfo = lstatSync(commandPath);
  } catch {
    fail(`npm Unix bin is missing: ${commandPath}`);
  }
  if (!commandInfo.isSymbolicLink()) fail('npm Unix bin must be a symbolic link');
  if (realpathSync(commandPath) !== realpathSync(cliPath)) {
    fail('npm Unix bin does not resolve to coding-x/dist/cli.js');
  }
  return commandPath;
}

function npmInvocation() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((entry) => typeof entry === 'string' && entry !== '');
  const npmCli = candidates.find((entry) => existsSync(entry));
  if (npmCli) return npmCli;
  if (process.platform === 'win32') fail('cannot locate the setup-node npm CLI');
  return null;
}

function spawnOptions(options = {}) {
  return {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.environment ?? process.env,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  };
}

function runNpm(npmCli, args, options = {}) {
  const spawn = spawnOptions({
    cwd: options.cwd,
    environment: { ...process.env, ...(options.env ?? {}) },
  });
  if (npmCli === null) return spawnSync('npm', args, spawn);
  return spawnSync(process.execPath, [npmCli, ...args], spawn);
}

function commandFailure(label, result) {
  if (result.error) return `${label} did not complete: ${result.error.message}`;
  return `${label} failed (exit=${String(result.status)}, signal=${String(result.signal)}): ${String(result.stderr).trim()}`;
}

function requireExit(label, result, expectedExit) {
  if (result.error || result.status !== expectedExit || result.signal !== null) {
    fail(commandFailure(label, result));
  }
}

function windowsCommandToken(value) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.trim() !== value ||
    !WINDOWS_COMMAND_TOKEN.test(value)
  ) {
    fail('Windows command argument is outside the fixed safe character set');
  }
  return `"${value}"`;
}

export function buildWindowsCommandInvocation(commandPath, args) {
  const line = [commandPath, ...args].map(windowsCommandToken).join(' ');
  return {
    command: WINDOWS_SYSTEM_COMMAND_PROCESSOR,
    args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export function buildWindowsCommandEnvironment(
  sourceEnvironment = process.env,
  nodeExecutable = process.execPath,
) {
  const originalPath = Object.entries(sourceEnvironment).find(
    ([key, value]) => key.toLowerCase() === 'path' && typeof value === 'string' && value !== '',
  )?.[1];
  const environment = Object.fromEntries(
    Object.entries(sourceEnvironment).filter(
      ([key]) =>
        !['comspec', 'path', 'pathext', 'nodefaultcurrentdirectoryinexepath'].includes(
          key.toLowerCase(),
        ),
    ),
  );
  return {
    ...environment,
    ComSpec: WINDOWS_SYSTEM_COMMAND_PROCESSOR,
    PATH: [win32.dirname(nodeExecutable), originalPath].filter(Boolean).join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    NoDefaultCurrentDirectoryInExePath: '1',
  };
}

function runInstalledCommand(commandPath, args, cwd, platform) {
  if (platform === 'windows') {
    const invocation = buildWindowsCommandInvocation(commandPath, args);
    return spawnSync(WINDOWS_SYSTEM_COMMAND_PROCESSOR, invocation.args, {
      ...spawnOptions({
        cwd,
        environment: buildWindowsCommandEnvironment(),
      }),
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  }
  return spawnSync(commandPath, args, spawnOptions({ cwd }));
}

function parseSingleJson(result, label) {
  if (String(result.stderr).trim() !== '')
    fail(`${label} wrote to stderr: ${result.stderr.trim()}`);
  try {
    return JSON.parse(String(result.stdout).replace(/^\uFEFF/u, ''));
  } catch (error) {
    fail(
      `${label} stdout is not one JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertNoReportedIssues(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoReportedIssues(entry, `${path}[${String(index)}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (key === 'issues') {
      if (!Array.isArray(entry)) fail(`${entryPath} must be an array`);
      if (entry.length !== 0) fail(`${entryPath} reported ${String(entry.length)} issue(s)`);
    }
    assertNoReportedIssues(entry, entryPath);
  }
}

export function validateDoctorResult(result, expectedVersion) {
  requireExit('coding-x doctor --shadow --local --json', result, 7);
  const report = parseSingleJson(result, 'coding-x doctor --shadow --local --json');
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail('doctor report must be an object');
  }
  if (report.schemaVersion !== 1) fail('doctor schemaVersion must be 1');
  if (report.docsFound !== true) fail('doctor did not inspect the candidate repository docs');
  exactString(report.quality?.status, 'shadow', 'doctor quality status');
  exactString(report.quality?.actualVersion, expectedVersion, 'doctor quality actualVersion');
  exactString(report.delivery?.status, 'local-ready', 'doctor local delivery status');
  exactString(report.workspaceSafety?.status, 'ready', 'doctor workspace safety status');
  for (const section of [
    'frontmatter',
    'freshness',
    'agentsIndex',
    'links',
    'quality',
    'delivery',
    'tdd',
    'modelCatalog',
  ]) {
    if (!report[section] || !Array.isArray(report[section].issues)) {
      fail(`doctor ${section}.issues is missing`);
    }
  }
  assertNoReportedIssues(report);
  return report;
}

function validateWorkspaceInit(result, workspacePath) {
  requireExit('coding-x workspace init --json', result, 0);
  const report = parseSingleJson(result, 'coding-x workspace init --json');
  exactString(report.status, 'created', 'workspace init status');
  if (report.exitCode !== 0)
    fail(`workspace init exitCode must be 0, received ${String(report.exitCode)}`);
  if (typeof report.workspace !== 'string') fail('workspace init did not report its workspace');
  if (realpathSync(report.workspace) !== realpathSync(workspacePath)) {
    fail('workspace init reported a different workspace');
  }
}

export function runCandidateInstallSmoke(rawOptions) {
  const evidencePath = requiredPath(rawOptions.evidencePath, 'evidence path');
  const tarballPath = requiredPath(rawOptions.tarballPath, 'tarball path');
  const projectRoot = requiredPath(rawOptions.projectRoot, 'project root');
  const tempRoot = requiredPath(rawOptions.tempRoot, 'runner temp root');
  const evidence = readJson(evidencePath, 'packed evidence');
  const validatedIdentity = validateCandidateIdentity({
    evidence,
    tarballPath,
    expectedVersion: rawOptions.expectedVersion,
    expectedCommit: rawOptions.expectedCommit,
    expectedRunId: rawOptions.expectedRunId,
    expectedPlatform: rawOptions.expectedPlatform,
    actualPlatform: process.platform,
  });
  const { tarballBytes, ...identity } = validatedIdentity;
  assertProjectHead(projectRoot, identity.commit);

  const sandbox = mkdtempSync(join(tempRoot, 'coding-x-candidate-install-'));
  try {
    const installRoot = join(sandbox, 'npm-project');
    mkdirSync(installRoot);
    writeFileSync(
      join(installRoot, 'package.json'),
      `${JSON.stringify({ name: 'coding-x-candidate-install-smoke', version: '0.0.0', private: true }, null, 2)}\n`,
    );
    const verifiedTarballPath = join(sandbox, evidence.tarball.filename);
    writeFileSync(verifiedTarballPath, tarballBytes, { flag: 'wx', mode: 0o600 });
    const install = runNpm(
      npmInvocation(),
      [
        'install',
        verifiedTarballPath,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--omit=dev',
        '--no-save',
      ],
      { cwd: installRoot, env: { npm_config_update_notifier: 'false' } },
    );
    requireExit('fresh npm install', install, 0);

    const commandPath = assertInstalledCandidate(installRoot, identity.version, identity.platform);
    const help = runInstalledCommand(commandPath, ['--help'], projectRoot, identity.platform);
    requireExit('coding-x --help', help, 0);
    if (String(help.stderr).trim() !== '')
      fail(`coding-x --help wrote to stderr: ${help.stderr.trim()}`);
    if (!String(help.stdout).includes(PACKAGE_NAME))
      fail('coding-x --help did not identify coding-x');

    const workspacePath = join(sandbox, 'workspace');
    const workspaceInit = runInstalledCommand(
      commandPath,
      ['workspace', 'init', '--workspace', workspacePath, '--json'],
      projectRoot,
      identity.platform,
    );
    validateWorkspaceInit(workspaceInit, workspacePath);

    const doctor = runInstalledCommand(
      commandPath,
      ['doctor', '--shadow', '--local', '--workspace', workspacePath, '--json'],
      projectRoot,
      identity.platform,
    );
    validateDoctorResult(doctor, identity.version);
    return { status: 'verified', ...identity, doctorExitCode: 7 };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function main() {
  const result = runCandidateInstallSmoke(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export const CANDIDATE_INSTALL_SMOKE_SCRIPT = fileURLToPath(import.meta.url);

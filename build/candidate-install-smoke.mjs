#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

function fail(message) {
  throw new Error(`candidate install smoke failed: ${message}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function exactString(value, expected, label) {
  if (value !== expected)
    fail(`${label} mismatch: expected ${expected}, received ${String(value)}`);
}

function requiredPath(value, label) {
  if (typeof value !== 'string' || value === '') fail(`${label} is required`);
  const path = resolve(value);
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
  return path;
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
  const size = readFileSync(tarballPath).byteLength;
  if (evidence.tarball.size !== size) {
    fail(
      `downloaded tarball size mismatch: expected ${String(evidence.tarball.size)}, received ${String(size)}`,
    );
  }
  if (!SHA_256.test(evidence.tarball.sha256 ?? '')) fail('packed evidence SHA-256 is invalid');
  const actualSha256 = sha256(tarballPath);
  exactString(actualSha256, evidence.tarball.sha256, 'downloaded tarball SHA-256');
  return {
    version: expectedVersion,
    commit: expectedCommit,
    candidateWorkflowRunId: expectedRunId,
    platform: expectedPlatform,
    sha256: actualSha256,
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

function assertRegularNonEmptyFile(path, label) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) {
    fail(`${label} must be a non-empty regular file: ${path}`);
  }
}

function assertInstalledPlatformHelpers(packageRoot, expectedPlatform) {
  const helperRoot = join(packageRoot, 'dist', 'workspace-safety');
  if (expectedPlatform === 'windows') {
    for (const name of WINDOWS_HELPERS) {
      const path = join(helperRoot, name);
      assertRegularNonEmptyFile(path, `installed Windows helper ${name}`);
      if (!readFileSync(path).subarray(0, 2).equals(Buffer.from('MZ'))) {
        fail(`installed Windows helper ${name} does not have an MZ executable header`);
      }
    }
    return;
  }
  for (const name of POSIX_HELPERS) {
    assertRegularNonEmptyFile(join(helperRoot, name), `installed POSIX helper ${name}`);
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
  let cliInfo;
  try {
    cliInfo = lstatSync(cliPath);
  } catch {
    fail(`installed dist CLI is missing: ${cliPath}`);
  }
  if (!cliInfo.isFile() || cliInfo.isSymbolicLink())
    fail('installed dist CLI is not a regular file');
  assertInstalledPlatformHelpers(packageRoot, expectedPlatform);

  const binRoot = join(installRoot, 'node_modules', '.bin');
  if (expectedPlatform === 'windows') {
    const commandPath = join(binRoot, 'coding-x.cmd');
    let commandInfo;
    try {
      commandInfo = lstatSync(commandPath);
    } catch {
      fail(`npm Windows bin is missing: ${commandPath}`);
    }
    if (!commandInfo.isFile() || commandInfo.isSymbolicLink()) {
      fail('npm Windows bin must be a regular .cmd file');
    }
    const command = readFileSync(commandPath, 'utf8');
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
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((entry) => typeof entry === 'string' && entry !== '');
  const npmCli = candidates.find((entry) => existsSync(entry));
  if (npmCli) return { command: process.execPath, args: [npmCli] };
  if (process.platform === 'win32') fail('cannot locate the setup-node npm CLI');
  return { command: 'npm', args: [] };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
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

function quoteWindowsCommandArgument(value) {
  if (/["%\r\n\0]/u.test(value))
    fail('Windows command argument contains unsupported metacharacters');
  return `"${value}"`;
}

function runInstalledCommand(commandPath, args, cwd, platform) {
  if (platform === 'windows') {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    const line = [commandPath, ...args].map(quoteWindowsCommandArgument).join(' ');
    return run(comspec, ['/d', '/s', '/c', line], { cwd });
  }
  return run(commandPath, args, { cwd });
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
  const identity = validateCandidateIdentity({
    evidence,
    tarballPath,
    expectedVersion: rawOptions.expectedVersion,
    expectedCommit: rawOptions.expectedCommit,
    expectedRunId: rawOptions.expectedRunId,
    expectedPlatform: rawOptions.expectedPlatform,
    actualPlatform: process.platform,
  });
  assertProjectHead(projectRoot, identity.commit);

  const sandbox = mkdtempSync(join(tempRoot, 'coding-x-candidate-install-'));
  try {
    const installRoot = join(sandbox, 'npm-project');
    mkdirSync(installRoot);
    writeFileSync(
      join(installRoot, 'package.json'),
      `${JSON.stringify({ name: 'coding-x-candidate-install-smoke', version: '0.0.0', private: true }, null, 2)}\n`,
    );
    const npm = npmInvocation();
    const install = run(
      npm.command,
      [
        ...npm.args,
        'install',
        tarballPath,
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

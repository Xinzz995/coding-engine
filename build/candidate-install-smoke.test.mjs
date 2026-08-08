import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANDIDATE_INSTALL_SMOKE_SCRIPT,
  assertInstalledCandidate,
  candidatePlatform,
  runCandidateInstallSmoke,
  validateCandidateIdentity,
  validateDoctorResult,
} from './candidate-install-smoke.mjs';

const VERSION = '1.2.3';
const COMMIT = 'a'.repeat(40);
const RUN_ID = '123456';
const roots = [];

function temporaryRoot(prefix = 'candidate-install-smoke-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function tarballFixture(root, bytes = Buffer.from('candidate bytes')) {
  const path = join(root, `coding-x-${VERSION}.tgz`);
  writeFileSync(path, bytes);
  return path;
}

function evidenceFor(tarball, overrides = {}) {
  const bytes = readFileSync(tarball);
  return {
    schemaVersion: 2,
    status: 'packed',
    packageName: 'coding-x',
    version: VERSION,
    commit: COMMIT,
    sourceRef: 'refs/heads/main',
    sourceWorkflow: '.github/workflows/build-candidate.yml',
    candidateWorkflowRunId: RUN_ID,
    tarball: {
      filename: `coding-x-${VERSION}.tgz`,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    ...overrides,
  };
}

function identityOptions(tarball, evidence, overrides = {}) {
  return {
    evidence,
    tarballPath: tarball,
    expectedVersion: VERSION,
    expectedCommit: COMMIT,
    expectedRunId: RUN_ID,
    expectedPlatform: candidatePlatform(process.platform),
    actualPlatform: process.platform,
    ...overrides,
  };
}

function installedFixture(platform) {
  const root = temporaryRoot('candidate-installed-');
  const packageRoot = join(root, 'node_modules', 'coding-x');
  const binRoot = join(root, 'node_modules', '.bin');
  const cli = join(packageRoot, 'dist', 'cli.js');
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(join(packageRoot, 'dist', 'workspace-safety'), { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeJson(join(packageRoot, 'package.json'), {
    name: 'coding-x',
    version: VERSION,
    os: ['darwin', 'linux', 'win32'],
    bin: { 'coding-x': 'dist/cli.js' },
  });
  writeFileSync(cli, '#!/usr/bin/env node\n');
  if (platform === 'windows') {
    for (const name of ['coding-x-windows-path-inspector.exe', 'coding-x-windows-supervisor.exe']) {
      writeFileSync(join(packageRoot, 'dist', 'workspace-safety', name), Buffer.from('MZfixture'));
    }
    writeFileSync(
      join(binRoot, 'coding-x.cmd'),
      '@ECHO off\r\n"%~dp0\\..\\coding-x\\dist\\cli.js" %*\r\n',
    );
  } else {
    for (const name of [
      'posix-launcher-helper.mjs',
      'posix-supervisor-core.mjs',
      'posix-supervisor-helper.mjs',
    ]) {
      writeFileSync(
        join(packageRoot, 'dist', 'workspace-safety', name),
        'export const fixture = true;\n',
      );
    }
    symlinkSync(join('..', 'coding-x', 'dist', 'cli.js'), join(binRoot, 'coding-x'));
  }
  return { root, packageRoot, binRoot, cli };
}

function doctorResult(overrides = {}) {
  return {
    status: 7,
    signal: null,
    stdout: JSON.stringify({
      schemaVersion: 1,
      docsFound: true,
      frontmatter: { issues: [] },
      freshness: { issues: [] },
      agentsIndex: { issues: [] },
      links: { issues: [] },
      quality: {
        status: 'shadow',
        actualVersion: VERSION,
        issues: [],
      },
      delivery: { status: 'local-ready', issues: [] },
      tdd: { issues: [] },
      modelCatalog: { issues: [] },
      workspaceSafety: { status: 'ready' },
    }),
    stderr: '',
    ...overrides,
  };
}

function npmCli() {
  const path = process.env.npm_execpath;
  if (!path) throw new Error('candidate install test must be launched by npm');
  return [process.execPath, path];
}

function packFixture(root) {
  const packageRoot = join(root, 'package');
  const outputRoot = join(root, 'packed');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(outputRoot);
  writeJson(join(packageRoot, 'package.json'), {
    name: 'coding-x',
    version: VERSION,
    type: 'module',
    os: ['darwin', 'linux', 'win32'],
    bin: { 'coding-x': 'dist/cli.js' },
  });
  const cli = `#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('coding-x fixture help');
} else if (args[0] === 'workspace' && args[1] === 'init') {
  const workspace = resolve(args[args.indexOf('--workspace') + 1]);
  mkdirSync(workspace, { recursive: true });
  console.log(JSON.stringify({ status: 'created', exitCode: 0, workspace }));
} else if (args[0] === 'doctor') {
  console.log(JSON.stringify({
    schemaVersion: 1,
    docsFound: true,
    frontmatter: { issues: [] },
    freshness: { issues: [] },
    agentsIndex: { issues: [] },
    links: { issues: [] },
    quality: { status: 'shadow', actualVersion: '${VERSION}', issues: [] },
    delivery: { status: 'local-ready', issues: [] },
    tdd: { issues: [] },
    modelCatalog: { issues: [] },
    workspaceSafety: { status: 'ready' },
  }));
  process.exitCode = 7;
} else {
  console.error('unexpected fixture arguments: ' + JSON.stringify(args));
  process.exitCode = 9;
}
`;
  writeFileSync(join(packageRoot, 'dist', 'cli.js'), cli);
  chmodSync(join(packageRoot, 'dist', 'cli.js'), 0o755);
  const helperRoot = join(packageRoot, 'dist', 'workspace-safety');
  mkdirSync(helperRoot, { recursive: true });
  if (process.platform === 'win32') {
    for (const name of ['coding-x-windows-path-inspector.exe', 'coding-x-windows-supervisor.exe']) {
      writeFileSync(join(helperRoot, name), Buffer.from('MZfixture'));
    }
  } else {
    for (const name of [
      'posix-launcher-helper.mjs',
      'posix-supervisor-core.mjs',
      'posix-supervisor-helper.mjs',
    ]) {
      writeFileSync(join(helperRoot, name), 'export const fixture = true;\n');
    }
  }
  const [npm, npmScript] = npmCli();
  execFileSync(
    npm,
    [npmScript, 'pack', packageRoot, '--ignore-scripts', '--pack-destination', outputRoot],
    { cwd: root, stdio: 'ignore' },
  );
  return join(outputRoot, `coding-x-${VERSION}.tgz`);
}

function committedProject(root) {
  const project = join(root, 'project');
  mkdirSync(project);
  execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'candidate-test'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'candidate@test.local'], { cwd: project });
  writeFileSync(join(project, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: project, stdio: 'ignore' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: project,
    encoding: 'utf8',
  }).trim();
  return { project, commit };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('candidate install smoke identity', () => {
  it('installs the downloaded tarball directly without npm exec, npx, or repacking it', () => {
    const source = readFileSync(CANDIDATE_INSTALL_SMOKE_SCRIPT, 'utf8');
    expect(source).toContain("'install',\n        tarballPath,");
    expect(source).not.toMatch(/\bnpm\s+exec\b/iu);
    expect(source).not.toMatch(/\bnpx\b/iu);
    expect(source).not.toMatch(/['"](?:exec|pack)['"]\s*,/u);
  });

  it('binds the exact version, head, workflow run, platform and tarball SHA-256', () => {
    const root = temporaryRoot();
    const tarball = tarballFixture(root);
    const evidence = evidenceFor(tarball);

    expect(validateCandidateIdentity(identityOptions(tarball, evidence))).toMatchObject({
      version: VERSION,
      commit: COMMIT,
      candidateWorkflowRunId: RUN_ID,
      platform: candidatePlatform(process.platform),
      sha256: evidence.tarball.sha256,
    });

    for (const [label, changed] of [
      ['version', { expectedVersion: '1.2.4' }],
      ['commit', { expectedCommit: 'b'.repeat(40) }],
      ['workflow run', { expectedRunId: '654321' }],
      [
        'platform',
        {
          expectedPlatform: candidatePlatform(process.platform) === 'linux' ? 'windows' : 'linux',
        },
      ],
    ]) {
      expect(
        () => validateCandidateIdentity(identityOptions(tarball, evidence, changed)),
        label,
      ).toThrow();
    }

    writeFileSync(tarball, Buffer.alloc(readFileSync(tarball).byteLength, 0x78));
    expect(() => validateCandidateIdentity(identityOptions(tarball, evidence))).toThrow(/SHA-256/u);
  });

  it('rejects evidence that is not the packed candidate from the protected workflow', () => {
    const root = temporaryRoot();
    const tarball = tarballFixture(root);
    for (const changed of [
      { schemaVersion: 1 },
      { status: 'staged' },
      { packageName: 'other-package' },
      { sourceRef: 'refs/heads/feature' },
      { sourceWorkflow: '.github/workflows/other.yml' },
    ]) {
      expect(() =>
        validateCandidateIdentity(identityOptions(tarball, evidenceFor(tarball, changed))),
      ).toThrow();
    }
  });
});

describe('candidate installed command boundary', () => {
  it('accepts only npm-created Unix and Windows command entries bound to dist/cli.js', () => {
    const unix = installedFixture('linux');
    expect(assertInstalledCandidate(unix.root, VERSION, 'linux')).toBe(
      join(unix.binRoot, 'coding-x'),
    );
    expect(lstatSync(join(unix.binRoot, 'coding-x')).isSymbolicLink()).toBe(true);

    const windows = installedFixture('windows');
    expect(assertInstalledCandidate(windows.root, VERSION, 'windows')).toBe(
      join(windows.binRoot, 'coding-x.cmd'),
    );
    expect(readFileSync(join(windows.binRoot, 'coding-x.cmd'), 'utf8')).toContain(
      '..\\coding-x\\dist\\cli.js',
    );
  });

  it('rejects a missing, copied or redirected command entry', () => {
    const missing = installedFixture('linux');
    rmSync(join(missing.binRoot, 'coding-x'));
    expect(() => assertInstalledCandidate(missing.root, VERSION, 'linux')).toThrow(/bin/u);

    const copied = installedFixture('linux');
    rmSync(join(copied.binRoot, 'coding-x'));
    writeFileSync(join(copied.binRoot, 'coding-x'), '#!/usr/bin/env node\n');
    expect(() => assertInstalledCandidate(copied.root, VERSION, 'linux')).toThrow(/symbolic link/u);

    const redirected = installedFixture('windows');
    writeFileSync(join(redirected.binRoot, 'coding-x.cmd'), '@node other.js\r\n');
    expect(() => assertInstalledCandidate(redirected.root, VERSION, 'windows')).toThrow(/dist/u);
  });

  it('rejects missing POSIX helpers and damaged Windows executables', () => {
    const missingPosix = installedFixture('linux');
    rmSync(join(missingPosix.packageRoot, 'dist', 'workspace-safety', 'posix-supervisor-core.mjs'));
    expect(() => assertInstalledCandidate(missingPosix.root, VERSION, 'linux')).toThrow(
      /POSIX helper/u,
    );

    const damagedWindows = installedFixture('windows');
    writeFileSync(
      join(
        damagedWindows.packageRoot,
        'dist',
        'workspace-safety',
        'coding-x-windows-supervisor.exe',
      ),
      Buffer.from('not-an-executable'),
    );
    expect(() => assertInstalledCandidate(damagedWindows.root, VERSION, 'windows')).toThrow(
      /MZ executable header/u,
    );
  });
});

describe('candidate doctor proof', () => {
  it('accepts only exit 7, schema 1, shadow identity and zero reported issues', () => {
    expect(validateDoctorResult(doctorResult(), VERSION)).toMatchObject({
      schemaVersion: 1,
      quality: { status: 'shadow', actualVersion: VERSION, issues: [] },
    });

    expect(() => validateDoctorResult(doctorResult({ status: 0 }), VERSION)).toThrow(/exit/u);
    expect(() =>
      validateDoctorResult(
        doctorResult({
          stdout: JSON.stringify({
            schemaVersion: 2,
            docsFound: true,
            quality: { status: 'shadow', actualVersion: VERSION, issues: [] },
          }),
        }),
        VERSION,
      ),
    ).toThrow(/schemaVersion/u);
    expect(() =>
      validateDoctorResult(
        doctorResult({
          stdout: JSON.stringify({
            schemaVersion: 1,
            docsFound: true,
            quality: { status: 'ready', actualVersion: VERSION, issues: [] },
          }),
        }),
        VERSION,
      ),
    ).toThrow(/shadow/u);
    expect(() =>
      validateDoctorResult(
        doctorResult({
          stdout: JSON.stringify({
            schemaVersion: 1,
            docsFound: true,
            quality: { status: 'shadow', actualVersion: '9.9.9', issues: [] },
          }),
        }),
        VERSION,
      ),
    ).toThrow(/actualVersion/u);
    expect(() =>
      validateDoctorResult(
        doctorResult({
          stdout: JSON.stringify({
            schemaVersion: 1,
            docsFound: true,
            frontmatter: { issues: [] },
            freshness: { issues: [] },
            agentsIndex: { issues: [] },
            links: { issues: [] },
            quality: { status: 'shadow', actualVersion: VERSION, issues: [] },
            delivery: { status: 'local-ready', issues: [{ message: 'not ready' }] },
            tdd: { issues: [] },
            modelCatalog: { issues: [] },
            workspaceSafety: { status: 'ready' },
          }),
        }),
        VERSION,
      ),
    ).toThrow(/issues/u);
  });
});

describe('candidate install smoke end to end', () => {
  it('installs one local tarball in a disposable npm project and runs the real bin three times', () => {
    const root = temporaryRoot('candidate-install-e2e-');
    const tarball = packFixture(root);
    const { project, commit } = committedProject(root);
    const evidence = evidenceFor(tarball, { commit });
    const evidencePath = join(root, 'packed.json');
    writeJson(evidencePath, evidence);
    const smokeTemp = join(root, 'runner-temp');
    mkdirSync(smokeTemp);

    expect(
      runCandidateInstallSmoke({
        evidencePath,
        tarballPath: tarball,
        expectedVersion: VERSION,
        expectedCommit: commit,
        expectedRunId: RUN_ID,
        expectedPlatform: candidatePlatform(process.platform),
        projectRoot: project,
        tempRoot: smokeTemp,
      }),
    ).toMatchObject({
      status: 'verified',
      version: VERSION,
      commit,
      candidateWorkflowRunId: RUN_ID,
      platform: candidatePlatform(process.platform),
      doctorExitCode: 7,
    });
    expect(existsSync(smokeTemp)).toBe(true);
    expect(readdirSync(smokeTemp)).toEqual([]);
  }, 30_000);
});

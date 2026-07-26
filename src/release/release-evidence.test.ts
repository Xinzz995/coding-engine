import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('build/release-evidence.mjs');
const roots: string[] = [];

function json(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'release-evidence-'));
  roots.push(root);
  json(join(root, 'package.json'), { name: 'coding-x', version: '1.2.3' });
  json(join(root, 'package-lock.json'), {
    name: 'coding-x',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: { '': { name: 'coding-x', version: '1.2.3' } },
  });
  for (const path of [
    '.claude-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ])
    json(join(root, path), { version: '1.2.3' });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/version.ts'), "export const CODING_X_VERSION = '1.2.3';\n");
  return root;
}

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function digest(bytes: Buffer) {
  return {
    shasum: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('release evidence script', () => {
  it('reconstructs the staged directory without changing the packed bytes', () => {
    const root = rootFixture();
    const first = join(root, 'first-pack');
    const second = join(root, 'second-pack');
    const unpacked = join(root, 'unpacked');
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(unpacked);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['pack', root, '--ignore-scripts', '--pack-destination', first], {
      stdio: 'ignore',
    });
    const firstTarball = join(first, 'coding-x-1.2.3.tgz');
    execFileSync('tar', ['-xzf', firstTarball, '-C', unpacked]);
    mkdirSync(join(unpacked, 'package/.git'), { recursive: true });
    writeFileSync(join(unpacked, 'package/.git/HEAD'), `${'d'.repeat(40)}\n`);
    execFileSync(
      npm,
      ['pack', join(unpacked, 'package'), '--ignore-scripts', '--pack-destination', second],
      { stdio: 'ignore' },
    );
    expect(readFileSync(join(second, 'coding-x-1.2.3.tgz'))).toEqual(readFileSync(firstTarball));
  });

  it('fails closed on stale main but accepts an exact main commit and annotated tag', () => {
    const root = rootFixture();
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'release-test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'release@test.local'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'candidate'], { cwd: root });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', commit], { cwd: root });

    const source = run(
      [
        'verify-source',
        '--root',
        root,
        '--expected-version',
        '1.2.3',
        '--commit',
        commit,
        '--ref',
        'refs/heads/main',
        '--main-ref',
        'refs/remotes/origin/main',
      ],
      root,
    );
    expect(source.status, source.stderr).toBe(0);

    execFileSync(
      'git',
      [
        'tag',
        '-a',
        'v1.2.3',
        '-m',
        [
          'release 1.2.3',
          '',
          'Stage-Run-ID: 123',
          'Npm-Stage-ID: 123e4567-e89b-42d3-a456-426614174000',
          `Candidate-SHA256: ${'d'.repeat(64)}`,
        ].join('\n'),
      ],
      { cwd: root },
    );
    const tagOutput = join(root, 'tag.json');
    const tag = run(
      [
        'verify-tag',
        '--root',
        root,
        '--tag',
        'v1.2.3',
        '--commit',
        commit,
        '--main-ref',
        'refs/remotes/origin/main',
        '--output',
        tagOutput,
      ],
      root,
    );
    expect(tag.status, tag.stderr).toBe(0);
    expect(JSON.parse(readFileSync(tagOutput, 'utf8'))).toMatchObject({
      stageRunId: '123',
      stageId: '123e4567-e89b-42d3-a456-426614174000',
      tarballSha256: 'd'.repeat(64),
    });

    execFileSync('git', ['tag', '-d', 'v1.2.3'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['tag', '-a', 'v1.2.3', '-m', 'release without candidate identity'], {
      cwd: root,
    });
    const unboundTag = run(
      [
        'verify-tag',
        '--root',
        root,
        '--tag',
        'v1.2.3',
        '--commit',
        commit,
        '--main-ref',
        'refs/remotes/origin/main',
      ],
      root,
    );
    expect(unboundTag.status).toBe(1);
    expect(unboundTag.stderr).toContain('Stage-Run-ID');

    writeFileSync(join(root, 'README.md'), 'later\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'later'], { cwd: root });
    const later = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const stale = run(
      [
        'verify-source',
        '--root',
        root,
        '--expected-version',
        '1.2.3',
        '--commit',
        later,
        '--ref',
        'refs/heads/main',
        '--main-ref',
        'refs/remotes/origin/main',
      ],
      root,
    );
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('不是当前远端 main');
  });

  it('binds the exact packed bytes to the npm stage id and rejects mismatches', () => {
    const root = rootFixture();
    const bytes = Buffer.from('fixed candidate tarball bytes');
    const sums = digest(bytes);
    const tarball = join(root, 'coding-x-1.2.3.tgz');
    const packJson = join(root, 'pack.json');
    const packedEvidence = join(root, 'packed.json');
    const stagedEvidence = join(root, 'candidate.json');
    const stageJson = join(root, 'stage.json');
    writeFileSync(tarball, bytes);
    json(packJson, [
      {
        name: 'coding-x',
        version: '1.2.3',
        filename: 'coding-x-1.2.3.tgz',
        shasum: sums.shasum,
        integrity: sums.integrity,
      },
    ]);

    const packed = run(
      [
        'record-pack',
        '--root',
        root,
        '--expected-version',
        '1.2.3',
        '--commit',
        'a'.repeat(40),
        '--workflow-run-id',
        '123',
        '--pack-json',
        packJson,
        '--tarball',
        tarball,
        '--output',
        packedEvidence,
      ],
      root,
    );
    expect(packed.status, packed.stderr).toBe(0);
    expect(readFileSync(packedEvidence, 'utf8')).toContain(sums.sha256);

    json(stageJson, {
      name: 'coding-x',
      version: '1.2.3',
      stageId: '123e4567-e89b-42d3-a456-426614174000',
      shasum: '0'.repeat(40),
      integrity: sums.integrity,
    });
    const mismatch = run(
      [
        'record-stage',
        '--candidate',
        packedEvidence,
        '--stage-json',
        stageJson,
        '--commit',
        'a'.repeat(40),
        '--workflow-run-id',
        '123',
        '--output',
        stagedEvidence,
      ],
      root,
    );
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('不是同一字节内容');

    json(stageJson, {
      name: 'coding-x',
      version: '1.2.3',
      stageId: '123e4567-e89b-42d3-a456-426614174000',
      shasum: sums.shasum,
      integrity: sums.integrity,
    });
    const staged = run(
      [
        'record-stage',
        '--candidate',
        packedEvidence,
        '--stage-json',
        stageJson,
        '--commit',
        'a'.repeat(40),
        '--workflow-run-id',
        '123',
        '--output',
        stagedEvidence,
      ],
      root,
    );
    expect(staged.status, staged.stderr).toBe(0);
    const verified = run(
      ['verify-tarball', '--evidence', stagedEvidence, '--tarball', tarball],
      root,
    );
    expect(verified.status, verified.stderr).toBe(0);
  });

  it('verifies registry bytes, dist-tags, gitHead and SLSA provenance together', () => {
    const root = rootFixture();
    const bytes = Buffer.from('registry candidate bytes');
    const sums = digest(bytes);
    const commit = 'b'.repeat(40);
    const tarball = join(root, 'candidate.tgz');
    const evidencePath = join(root, 'candidate.json');
    const metadataPath = join(root, 'metadata.json');
    const tagsPath = join(root, 'tags.json');
    const attestationsPath = join(root, 'attestations.json');
    writeFileSync(tarball, bytes);
    json(evidencePath, {
      schemaVersion: 1,
      status: 'staged',
      packageName: 'coding-x',
      version: '1.2.3',
      commit,
      sourceRef: 'refs/heads/main',
      sourceWorkflow: '.github/workflows/stage-candidate.yml',
      sourceRepository: 'https://github.com/Xinzz995/coding-engine',
      workflowRunId: '123',
      requestedTag: 'next',
      stageId: '123e4567-e89b-42d3-a456-426614174000',
      stagedAt: '2026-07-26T00:00:00.000Z',
      stageToolchain: { node: '24.0.0', npm: '11.15.0' },
      tarball: {
        filename: 'coding-x-1.2.3.tgz',
        size: bytes.length,
        sha1: sums.shasum,
        sha256: sums.sha256,
        integrity: sums.integrity,
      },
      toolchain: { node: '24.0.0', npm: '11.15.0' },
    });
    json(metadataPath, {
      name: 'coding-x',
      version: '1.2.3',
      gitHead: commit,
      dist: { shasum: sums.shasum, integrity: sums.integrity },
    });
    json(tagsPath, { next: '1.2.3', latest: '1.2.3' });
    const statement = {
      subject: [
        {
          name: 'pkg:npm/coding-x@1.2.3',
          digest: { sha512: createHash('sha512').update(bytes).digest('hex') },
        },
      ],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: 'https://github.com/Xinzz995/coding-engine',
              path: '.github/workflows/stage-candidate.yml',
              ref: 'refs/heads/main',
            },
          },
          resolvedDependencies: [{ digest: { gitCommit: commit } }],
        },
      },
    };
    json(attestationsPath, {
      attestations: [
        {
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: {
            dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
          },
        },
      ],
    });

    const registryArgs = [
      'verify-registry',
      '--evidence',
      evidencePath,
      '--commit',
      commit,
      '--workflow-run-id',
      '123',
      '--stage-id',
      '123e4567-e89b-42d3-a456-426614174000',
      '--tarball-sha256',
      sums.sha256,
      '--metadata',
      metadataPath,
      '--dist-tags',
      tagsPath,
      '--attestations',
      attestationsPath,
      '--tarball',
      tarball,
    ];
    const valid = run(registryArgs, root);
    expect(valid.status, valid.stderr).toBe(0);

    const wrongRun = [...registryArgs];
    wrongRun[wrongRun.indexOf('123')] = '999';
    const unbound = run(wrongRun, root);
    expect(unbound.status).toBe(1);
    expect(unbound.stderr).toContain('选定的 stage workflow run 不一致');

    const wrongStageId = [...registryArgs];
    wrongStageId[wrongStageId.indexOf('123e4567-e89b-42d3-a456-426614174000')] =
      '223e4567-e89b-42d3-a456-426614174000';
    const wrongStage = run(wrongStageId, root);
    expect(wrongStage.status).toBe(1);
    expect(wrongStage.stderr).toContain('发布标签记录的 npm stage ID 不一致');

    const wrongSha = [...registryArgs];
    wrongSha[wrongSha.indexOf(sums.sha256)] = '0'.repeat(64);
    const wrongCandidate = run(wrongSha, root);
    expect(wrongCandidate.status).toBe(1);
    expect(wrongCandidate.stderr).toContain('发布标签记录的 tarball SHA-256 不一致');

    statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'c'.repeat(40);
    json(attestationsPath, {
      attestations: [
        {
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: {
            dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
          },
        },
      ],
    });
    const invalid = run(registryArgs, root);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('未绑定候选提交');
  });
});

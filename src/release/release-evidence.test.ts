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
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/cli.js'), '#!/usr/bin/env node\n');
  return root;
}

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function runNpm(args: string[], cwd: string): void {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('测试必须由 npm 启动，以取得跨平台 npm CLI 路径');
  execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'ignore' });
}

function digest(bytes: Buffer) {
  return {
    shasum: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

function objectDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function runtimeFor(root: string) {
  const files = ['dist/cli.js', 'package.json']
    .map((path) => {
      const bytes = readFileSync(join(root, path));
      return {
        path,
        size: bytes.byteLength,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    algorithm: 'sha256-path-size-bytes-v1',
    fileCount: files.length,
    treeDigest: objectDigest({
      domain: 'coding-x-candidate-runtime-tree-v1',
      algorithm: 'sha256-path-size-bytes-v1',
      files,
    }),
    files,
  };
}

function candidateIdentityDigest(evidence: {
  packageName: string;
  version: string;
  commit: string;
  candidateWorkflowRunId: string;
  tarball: { sha256: string };
  runtime: ReturnType<typeof runtimeFor>;
}): string {
  return objectDigest({
    schemaVersion: 1,
    domain: 'coding-x-candidate-identity-v1',
    packageName: evidence.packageName,
    version: evidence.version,
    commit: evidence.commit,
    candidateWorkflowRunId: evidence.candidateWorkflowRunId,
    tarballSha256: `sha256:${evidence.tarball.sha256}`,
    runtimeTreeDigest: evidence.runtime.treeDigest,
  });
}

function dogfoodSetFor(evidence: {
  candidateIdentityDigest: string;
  candidateWorkflowRunId: string;
  tarball: { sha256: string };
}) {
  const proofs = [
    ['engine', 'Xinzz995/coding-engine'],
    ['go', 'Xinzz995/coding-x-dogfood-go'],
    ['python', 'Xinzz995/coding-x-dogfood-python'],
  ].map(([role, repository], index) => ({
    role,
    repository,
    prNumber: index + 1,
    headSha: String(index + 1).repeat(40),
    proofDigest: `sha256:${String(index + 4).repeat(64)}`,
    commentId: index + 10,
    commentUrl: `https://github.com/${repository}/pull/${index + 1}#issuecomment-${index + 10}`,
    completedAt: `2026-08-15T00:0${index}:00.000Z`,
  }));
  const base = {
    schemaVersion: 1,
    status: 'verified',
    candidateIdentityDigest: evidence.candidateIdentityDigest,
    candidateWorkflowRunId: evidence.candidateWorkflowRunId,
    tarballSha256: `sha256:${evidence.tarball.sha256}`,
    proofs,
  };
  return {
    ...base,
    digest: objectDigest({ domain: 'coding-x-candidate-dogfood-set-v1', evidence: base }),
  };
}

function dogfoodCandidateFromJson(value: string): Parameters<typeof dogfoodSetFor>[0] {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('packed evidence fixture 必须是对象');
  }
  const root = parsed as Record<string, unknown>;
  const tarballValue = root.tarball;
  if (typeof tarballValue !== 'object' || tarballValue === null || Array.isArray(tarballValue)) {
    throw new Error('packed evidence fixture tarball 必须是对象');
  }
  const tarball = tarballValue as Record<string, unknown>;
  if (
    typeof root.candidateIdentityDigest !== 'string' ||
    typeof root.candidateWorkflowRunId !== 'string' ||
    typeof tarball.sha256 !== 'string'
  ) {
    throw new Error('packed evidence fixture 缺少 Dogfood 身份字段');
  }
  return {
    candidateIdentityDigest: root.candidateIdentityDigest,
    candidateWorkflowRunId: root.candidateWorkflowRunId,
    tarball: { sha256: tarball.sha256 },
  };
}

function dogfoodProofFor(
  candidate: {
    packageName: string;
    version: string;
    commit: string;
    candidateWorkflowRunId: string;
    candidateIdentityDigest: string;
    tarball: { sha256: string };
    runtime: { treeDigest: string };
  },
  repository: string,
  prNumber: number,
  headSha: string,
) {
  const proof = {
    schemaVersion: 1,
    status: 'passed',
    repository: { provider: 'github', fullName: repository, defaultBranch: 'main' },
    candidate: {
      schemaVersion: 1,
      packageName: candidate.packageName,
      version: candidate.version,
      commit: candidate.commit,
      candidateWorkflowRunId: candidate.candidateWorkflowRunId,
      tarballSha256: `sha256:${candidate.tarball.sha256}`,
      runtimeTreeDigest: candidate.runtime.treeDigest,
      digest: candidate.candidateIdentityDigest,
    },
    review: {
      prNumber,
      baseSha: 'e'.repeat(40),
      headSha,
      bindingDigest: `sha256:${'a'.repeat(64)}`,
      storyValidationDigest: `sha256:${'b'.repeat(64)}`,
      storyValidationEnvironmentDigest: `sha256:${'c'.repeat(64)}`,
      remoteStatus: 'ready',
      remoteCheckedAt: '2026-08-15T00:00:00.000Z',
      checks: [
        {
          name: 'quality-gate',
          status: 'completed',
          conclusion: 'success',
          appId: 15_368,
          appSlug: 'github-actions',
        },
      ],
    },
    completedAt: '2026-08-15T00:01:00.000Z',
  };
  return {
    ...proof,
    proofDigest: objectDigest({ domain: 'coding-x-candidate-dogfood-proof-v1', proof }),
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
    runNpm(['pack', root, '--ignore-scripts', '--pack-destination', first], root);
    const firstTarball = join(first, 'coding-x-1.2.3.tgz');
    execFileSync('tar', ['-xzf', firstTarball, '-C', unpacked]);
    mkdirSync(join(unpacked, 'package/.git'), { recursive: true });
    writeFileSync(join(unpacked, 'package/.git/HEAD'), `${'d'.repeat(40)}\n`);
    runNpm(
      ['pack', join(unpacked, 'package'), '--ignore-scripts', '--pack-destination', second],
      root,
    );
    expect(readFileSync(join(second, 'coding-x-1.2.3.tgz'))).toEqual(readFileSync(firstTarball));
  });

  it('records an empty runtime file through the stable candidate reader', () => {
    const root = rootFixture();
    const emptyPath = 'dist/empty-runtime.txt';
    writeFileSync(join(root, emptyPath), '');
    const bytes = Buffer.from('candidate with empty runtime file');
    const sums = digest(bytes);
    const tarball = join(root, 'coding-x-1.2.3.tgz');
    const packJson = join(root, 'pack.json');
    const evidencePath = join(root, 'packed.json');
    writeFileSync(tarball, bytes);
    json(packJson, [
      {
        name: 'coding-x',
        version: '1.2.3',
        filename: 'coding-x-1.2.3.tgz',
        shasum: sums.shasum,
        integrity: sums.integrity,
        files: [
          ...runtimeFor(root).files.map(({ path, size }) => ({ path, size, mode: 0o644 })),
          { path: emptyPath, size: 0, mode: 0o644 },
        ],
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
        '--candidate-workflow-run-id',
        '123',
        '--min-npm',
        '0.0.0',
        '--pack-json',
        packJson,
        '--tarball',
        tarball,
        '--output',
        evidencePath,
      ],
      root,
    );
    expect(packed.status, packed.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      runtime: { files: Array<{ path: string; size: number; sha256: string }> };
    };
    expect(evidence.runtime.files.find((file) => file.path === emptyPath)).toEqual({
      path: emptyPath,
      size: 0,
      sha256: `sha256:${createHash('sha256').update('').digest('hex')}`,
    });
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
        '--min-npm',
        '0.0.0',
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

  it('accepts only the selected successful completed candidate run from current main', () => {
    const root = rootFixture();
    const runJson = join(root, 'candidate-run.json');
    const commit = 'a'.repeat(40);
    const selectedRunId = '123456';
    const validRun = {
      id: Number(selectedRunId),
      head_sha: commit,
      head_branch: 'main',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/build-candidate.yml',
    };
    const args = [
      'verify-candidate-run',
      '--run-json',
      runJson,
      '--candidate-workflow-run-id',
      selectedRunId,
      '--commit',
      commit,
    ];

    json(runJson, validRun);
    const verified = run(args, root);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      status: 'verified',
      candidateWorkflowRunId: selectedRunId,
      commit,
      branch: 'main',
      workflow: '.github/workflows/build-candidate.yml',
    });

    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      json(runJson, { ...validRun, conclusion });
      const rejected = run(args, root);
      expect(rejected.status, `conclusion=${String(conclusion)}`).toBe(1);
      expect(rejected.stderr).toContain('未成功完成');
    }

    for (const [label, changed] of [
      ['run id', { id: 654321 }],
      ['head', { head_sha: 'b'.repeat(40) }],
      ['main', { head_branch: 'feature' }],
      ['event', { event: 'push' }],
      ['status', { status: 'in_progress' }],
      ['path', { path: '.github/workflows/other.yml' }],
    ] as const) {
      json(runJson, { ...validRun, ...changed });
      const rejected = run(args, root);
      expect(rejected.status, label).toBe(1);
    }
  });

  it('accepts exactly one owner-published proof from each fixed dogfood repository', () => {
    const root = rootFixture();
    const bytes = Buffer.from('candidate with dogfood proofs');
    const sums = digest(bytes);
    const tarball = join(root, 'coding-x-1.2.3.tgz');
    const packJson = join(root, 'pack.json');
    const candidatePath = join(root, 'packed.json');
    const policyPath = join(root, 'dogfood-policy.json');
    const observationsPath = join(root, 'observations.json');
    const outputPath = join(root, 'dogfood.json');
    writeFileSync(tarball, bytes);
    json(packJson, [
      {
        name: 'coding-x',
        version: '1.2.3',
        filename: 'coding-x-1.2.3.tgz',
        shasum: sums.shasum,
        integrity: sums.integrity,
        files: runtimeFor(root).files.map(({ path, size }) => ({ path, size, mode: 0o644 })),
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
        '--candidate-workflow-run-id',
        '123',
        '--min-npm',
        '0.0.0',
        '--pack-json',
        packJson,
        '--tarball',
        tarball,
        '--output',
        candidatePath,
      ],
      root,
    );
    expect(packed.status, packed.stderr).toBe(0);
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as unknown as Parameters<
      typeof dogfoodProofFor
    >[0];
    const repositories = [
      { role: 'engine', fullName: 'Xinzz995/coding-engine', defaultBranch: 'main' },
      { role: 'go', fullName: 'Xinzz995/coding-x-dogfood-go', defaultBranch: 'main' },
      { role: 'python', fullName: 'Xinzz995/coding-x-dogfood-python', defaultBranch: 'main' },
    ];
    json(policyPath, {
      schemaVersion: 1,
      proofMarker: '<!-- coding-x-candidate-proof-v1 -->',
      trustedAuthors: ['Xinzz995'],
      repositories,
    });
    const entries = repositories.map((repository, index) => {
      const prNumber = index + 11;
      const headSha = String(index + 1).repeat(40);
      const proof = dogfoodProofFor(candidate, repository.fullName, prNumber, headSha);
      return {
        role: repository.role,
        repository: repository.fullName,
        pr: {
          number: prNumber,
          state: 'open',
          draft: false,
          base: { ref: 'main', sha: 'e'.repeat(40) },
          head: { sha: headSha },
          mergeable: true,
          mergeable_state: 'clean',
        },
        checkRuns: [
          {
            id: index + 201,
            name: 'quality-gate',
            head_sha: headSha,
            status: 'completed',
            conclusion: 'success',
            app: { id: 15_368, slug: 'github-actions' },
          },
        ],
        comments: [
          {
            id: index + 101,
            html_url: `https://github.com/${repository.fullName}/pull/${prNumber}#issuecomment-${index + 101}`,
            user: { login: 'Xinzz995' },
            author_association: 'OWNER',
            body: `<!-- coding-x-candidate-proof-v1 -->\n\`\`\`json\n${JSON.stringify(proof)}\n\`\`\``,
          },
        ],
      };
    });
    json(observationsPath, { schemaVersion: 1, entries });
    const args = [
      'verify-dogfood',
      '--candidate',
      candidatePath,
      '--policy',
      policyPath,
      '--observations',
      observationsPath,
      '--output',
      outputPath,
    ];
    const verified = run(args, root);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
      status: 'verified',
      candidateIdentityDigest: candidate.candidateIdentityDigest,
      proofs: repositories.map(({ role, fullName }) => ({ role, repository: fullName })),
    });

    json(observationsPath, { schemaVersion: 1, entries: entries.slice(0, 2) });
    const missing = run(args, root);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('observations 格式非法');

    const wrongAuthor = structuredClone(entries);
    wrongAuthor[2].comments[0].user.login = 'attacker';
    json(observationsPath, { schemaVersion: 1, entries: wrongAuthor });
    const untrusted = run(args, root);
    expect(untrusted.status).toBe(1);
    expect(untrusted.stderr).toContain('owner 发布');

    const staleBase = structuredClone(entries);
    staleBase[0].pr.base.sha = 'f'.repeat(40);
    json(observationsPath, { schemaVersion: 1, entries: staleBase });
    const stale = run(args, root);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('Review/PR 绑定非法');

    const rerunFailed = structuredClone(entries);
    rerunFailed[1].checkRuns.push({
      ...rerunFailed[1].checkRuns[0],
      id: 999,
      conclusion: 'failure',
    });
    json(observationsPath, { schemaVersion: 1, entries: rerunFailed });
    const failedCurrentCheck = run(args, root);
    expect(failedCurrentCheck.status).toBe(1);
    expect(failedCurrentCheck.stderr).toContain('当前检查 quality-gate 未保持成功');

    const blocked = structuredClone(entries);
    blocked[2].pr.mergeable_state = 'blocked';
    json(observationsPath, { schemaVersion: 1, entries: blocked });
    const notMergeable = run(args, root);
    expect(notMergeable.status).toBe(1);
    expect(notMergeable.stderr).toContain('PR 尚未 ready');
  });

  it('binds the exact packed bytes to the npm stage id and rejects mismatches', () => {
    const root = rootFixture();
    const bytes = Buffer.from('fixed candidate tarball bytes');
    const sums = digest(bytes);
    const tarball = join(root, 'coding-x-1.2.3.tgz');
    const packJson = join(root, 'pack.json');
    const packedEvidence = join(root, 'packed.json');
    const dogfoodEvidence = join(root, 'dogfood.json');
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
        files: runtimeFor(root).files.map(({ path, size }) => ({ path, size, mode: 0o644 })),
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
        '--candidate-workflow-run-id',
        '123',
        '--min-npm',
        '0.0.0',
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
    json(
      dogfoodEvidence,
      dogfoodSetFor(dogfoodCandidateFromJson(readFileSync(packedEvidence, 'utf8'))),
    );

    const legacyEvidence = join(root, 'legacy-packed.json');
    json(legacyEvidence, {
      ...JSON.parse(readFileSync(packedEvidence, 'utf8')),
      schemaVersion: 2,
    });
    const legacy = run(
      ['verify-tarball', '--evidence', legacyEvidence, '--tarball', tarball],
      root,
    );
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toContain('候选证据格式或包身份非法');

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
        '--dogfood',
        dogfoodEvidence,
        '--commit',
        'a'.repeat(40),
        '--candidate-workflow-run-id',
        '123',
        '--stage-workflow-run-id',
        '456',
        '--min-npm',
        '0.0.0',
        '--output',
        stagedEvidence,
      ],
      root,
    );
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('不是同一字节内容');

    const wrongCandidateRun = run(
      [
        'record-stage',
        '--candidate',
        packedEvidence,
        '--stage-json',
        stageJson,
        '--dogfood',
        dogfoodEvidence,
        '--commit',
        'a'.repeat(40),
        '--candidate-workflow-run-id',
        '999',
        '--stage-workflow-run-id',
        '456',
        '--min-npm',
        '0.0.0',
        '--output',
        stagedEvidence,
      ],
      root,
    );
    expect(wrongCandidateRun.status).toBe(1);
    expect(wrongCandidateRun.stderr).toContain('candidate workflow run ID 不一致');

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
        '--dogfood',
        dogfoodEvidence,
        '--commit',
        'a'.repeat(40),
        '--candidate-workflow-run-id',
        '123',
        '--stage-workflow-run-id',
        '456',
        '--min-npm',
        '0.0.0',
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
    const evidence = {
      schemaVersion: 3,
      status: 'staged',
      packageName: 'coding-x',
      version: '1.2.3',
      commit,
      sourceRef: 'refs/heads/main',
      sourceWorkflow: '.github/workflows/build-candidate.yml',
      sourceRepository: 'https://github.com/Xinzz995/coding-engine',
      candidateWorkflowRunId: '123',
      requestedTag: 'next',
      stageWorkflow: '.github/workflows/stage-candidate.yml',
      stageWorkflowRunId: '456',
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
      runtime: runtimeFor(root),
      toolchain: { node: '24.0.0', npm: '11.15.0' },
    };
    const identifiedEvidence = {
      ...evidence,
      candidateIdentityDigest: candidateIdentityDigest(evidence),
    };
    json(evidencePath, {
      ...identifiedEvidence,
      dogfood: dogfoodSetFor(identifiedEvidence),
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
      '--stage-workflow-run-id',
      '456',
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
    wrongRun[wrongRun.indexOf('456')] = '999';
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

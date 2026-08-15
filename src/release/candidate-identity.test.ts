import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANDIDATE_RUNTIME_TREE_ALGORITHM,
  candidateIdentityDigest,
  candidateRuntimeTreeDigest,
  verifyCandidateRuntime,
  type CandidateIdentityFields,
  type CandidateRuntimeFileIdentity,
} from './candidate-identity.js';

const roots: string[] = [];

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fixture(): {
  root: string;
  packageRoot: string;
  evidencePath: string;
  identity: CandidateIdentityFields;
} {
  const root = mkdtempSync(join(tmpdir(), 'candidate-runtime-'));
  roots.push(root);
  const packageRoot = join(root, 'package');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  const contents = new Map([
    ['dist/cli.js', Buffer.from('console.log("candidate")\n')],
    [
      'package.json',
      Buffer.from(
        `${JSON.stringify({ name: 'coding-x', version: '1.2.3', dependencies: { jsonrepair: '3.15.0' } }, null, 2)}\n`,
      ),
    ],
  ]);
  for (const [path, bytes] of contents) writeFileSync(join(packageRoot, path), bytes);
  const files: CandidateRuntimeFileIdentity[] = [...contents]
    .map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const runtimeTreeDigest = candidateRuntimeTreeDigest(files);
  const identity: CandidateIdentityFields = {
    packageName: 'coding-x',
    version: '1.2.3',
    commit: 'a'.repeat(40),
    candidateWorkflowRunId: '123',
    tarballSha256: `sha256:${'b'.repeat(64)}`,
    runtimeTreeDigest,
  };
  const evidencePath = join(root, 'packed.json');
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schemaVersion: 3,
        status: 'packed',
        packageName: 'coding-x',
        version: '1.2.3',
        commit: 'a'.repeat(40),
        sourceRef: 'refs/heads/main',
        sourceWorkflow: '.github/workflows/build-candidate.yml',
        sourceRepository: 'https://github.com/Xinzz995/coding-engine',
        candidateWorkflowRunId: '123',
        tarball: { sha256: 'b'.repeat(64) },
        runtime: {
          algorithm: CANDIDATE_RUNTIME_TREE_ALGORITHM,
          fileCount: files.length,
          treeDigest: runtimeTreeDigest,
          files,
        },
        candidateIdentityDigest: candidateIdentityDigest(identity),
      },
      null,
      2,
    )}\n`,
  );
  return { root, packageRoot, evidencePath, identity };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('candidate runtime identity', () => {
  it('keeps the only runtime library inside the candidate file tree', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { dev?: boolean; version?: string }>;
    };
    const buildConfig = readFileSync(join(process.cwd(), 'tsup.config.ts'), 'utf8');
    expect(manifest.dependencies?.jsonrepair).toBeUndefined();
    expect(manifest.devDependencies?.jsonrepair).toBe('3.15.0');
    expect(lock.packages?.['node_modules/jsonrepair']).toMatchObject({
      dev: true,
      version: '3.15.0',
    });
    expect(buildConfig).toContain("noExternal: ['jsonrepair']");
  });

  it('binds the declared tarball to the actual installed package files', () => {
    const target = fixture();
    expect(
      verifyCandidateRuntime({
        evidencePath: target.evidencePath,
        packageRoot: target.packageRoot,
        expectedVersion: '1.2.3',
      }),
    ).toMatchObject({ ...target.identity, digest: candidateIdentityDigest(target.identity) });
  });

  it('rejects a replaced CLI even when the caller keeps the original candidate digest', () => {
    const target = fixture();
    writeFileSync(join(target.packageRoot, 'dist/cli.js'), 'console.log("replacement")\n');
    expect(() =>
      verifyCandidateRuntime({
        evidencePath: target.evidencePath,
        packageRoot: target.packageRoot,
        expectedVersion: '1.2.3',
      }),
    ).toThrow('候选运行文件不可读取');
  });

  it('rejects a symlinked runtime file instead of following it', () => {
    const target = fixture();
    const cli = join(target.packageRoot, 'dist/cli.js');
    const replacement = join(target.root, 'replacement.js');
    writeFileSync(replacement, 'console.log("candidate")\n');
    rmSync(cli);
    symlinkSync(replacement, cli);
    expect(() =>
      verifyCandidateRuntime({
        evidencePath: target.evidencePath,
        packageRoot: target.packageRoot,
        expectedVersion: '1.2.3',
      }),
    ).toThrow('候选包包含链接');
  });

  it('rejects a candidate identity digest copied from another tarball', () => {
    const target = fixture();
    const evidence = JSON.parse(readFileSync(target.evidencePath, 'utf8')) as Record<
      string,
      unknown
    >;
    evidence.candidateIdentityDigest = `sha256:${'c'.repeat(64)}`;
    writeFileSync(target.evidencePath, `${JSON.stringify(evidence)}\n`);
    expect(() =>
      verifyCandidateRuntime({
        evidencePath: target.evidencePath,
        packageRoot: target.packageRoot,
        expectedVersion: '1.2.3',
      }),
    ).toThrow('candidateIdentityDigest 与候选内容不一致');
  });

  it('rejects files added after npm extracted the candidate', () => {
    const target = fixture();
    writeFileSync(join(target.packageRoot, 'dist/injected.js'), 'unexpected\n');
    expect(() =>
      verifyCandidateRuntime({
        evidencePath: target.evidencePath,
        packageRoot: target.packageRoot,
        expectedVersion: '1.2.3',
      }),
    ).toThrow('多出：dist/injected.js');
  });
});

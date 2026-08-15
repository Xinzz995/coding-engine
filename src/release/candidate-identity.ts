import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CODING_X_VERSION } from '../version.js';
import { readStableFile } from '../workspace-safety/stable-file.js';

export const CANDIDATE_EVIDENCE_SCHEMA_VERSION = 3 as const;
export const CANDIDATE_RUNTIME_TREE_ALGORITHM = 'sha256-path-size-bytes-v1' as const;
export const CANDIDATE_IDENTITY_DOMAIN = 'coding-x-candidate-identity-v1' as const;
export const CANDIDATE_RUNTIME_TREE_DOMAIN = 'coding-x-candidate-runtime-tree-v1' as const;

const PACKAGE_NAME = 'coding-x';
const CANDIDATE_WORKFLOW = '.github/workflows/build-candidate.yml';
const SOURCE_REPOSITORY = 'https://github.com/Xinzz995/coding-engine';
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9]\d*$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const RAW_SHA256 = /^[0-9a-f]{64}$/u;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_FILES = 4096;
const MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024;

export interface CandidateRuntimeFileIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CandidateRuntimeTreeIdentity {
  readonly algorithm: typeof CANDIDATE_RUNTIME_TREE_ALGORITHM;
  readonly fileCount: number;
  readonly treeDigest: string;
  readonly files: readonly CandidateRuntimeFileIdentity[];
}

export interface CandidateIdentityFields {
  readonly packageName: typeof PACKAGE_NAME;
  readonly version: string;
  readonly commit: string;
  readonly candidateWorkflowRunId: string;
  readonly tarballSha256: string;
  readonly runtimeTreeDigest: string;
}

export interface VerifiedCandidateIdentity extends CandidateIdentityFields {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly evidencePath: string;
}

interface CandidateEvidence {
  readonly schemaVersion: typeof CANDIDATE_EVIDENCE_SCHEMA_VERSION;
  readonly status: 'packed' | 'staged';
  readonly packageName: typeof PACKAGE_NAME;
  readonly version: string;
  readonly commit: string;
  readonly sourceRef: 'refs/heads/main';
  readonly sourceWorkflow: typeof CANDIDATE_WORKFLOW;
  readonly sourceRepository: typeof SOURCE_REPOSITORY;
  readonly candidateWorkflowRunId: string;
  readonly tarball: { readonly sha256: string };
  readonly runtime: CandidateRuntimeTreeIdentity;
  readonly candidateIdentityDigest: string;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function candidateRuntimeTreeDigest(files: readonly CandidateRuntimeFileIdentity[]): string {
  return digest({
    domain: CANDIDATE_RUNTIME_TREE_DOMAIN,
    algorithm: CANDIDATE_RUNTIME_TREE_ALGORITHM,
    files,
  });
}

export function candidateIdentityDigest(identity: CandidateIdentityFields): string {
  return digest({
    schemaVersion: 1,
    domain: CANDIDATE_IDENTITY_DOMAIN,
    packageName: identity.packageName,
    version: identity.version,
    commit: identity.commit,
    candidateWorkflowRunId: identity.candidateWorkflowRunId,
    tarballSha256: identity.tarballSha256,
    runtimeTreeDigest: identity.runtimeTreeDigest,
  });
}

function fail(message: string): never {
  throw new Error(`候选身份不可验证：${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail(`${label} 不匹配`);
}

function runtimePath(value: unknown, index: number): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`runtime.files[${index}].path 非法`);
  }
  return value;
}

function parseRuntime(value: unknown): CandidateRuntimeTreeIdentity {
  const item = record(value, 'runtime');
  exactString(item.algorithm, CANDIDATE_RUNTIME_TREE_ALGORITHM, 'runtime.algorithm');
  if (
    !Array.isArray(item.files) ||
    item.files.length < 2 ||
    item.files.length > MAX_RUNTIME_FILES
  ) {
    fail('runtime.files 数量非法');
  }
  const files = item.files.map((entry, index) => {
    const file = record(entry, `runtime.files[${index}]`);
    const path = runtimePath(file.path, index);
    if (
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      (file.size as number) > MAX_RUNTIME_FILE_BYTES
    ) {
      fail(`runtime.files[${index}].size 非法`);
    }
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
      fail(`runtime.files[${index}].sha256 非法`);
    }
    return { path, size: file.size as number, sha256: file.sha256 };
  });
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) fail('runtime.files 路径重复');
  if (paths.some((path, index) => path !== [...paths].sort()[index])) {
    fail('runtime.files 必须按路径排序');
  }
  if (!paths.includes('package.json') || !paths.includes('dist/cli.js')) {
    fail('runtime.files 缺少 package.json 或 dist/cli.js');
  }
  if (item.fileCount !== files.length) fail('runtime.fileCount 与文件列表不一致');
  if (typeof item.treeDigest !== 'string' || !SHA256.test(item.treeDigest)) {
    fail('runtime.treeDigest 非法');
  }
  const expectedDigest = candidateRuntimeTreeDigest(files);
  if (item.treeDigest !== expectedDigest) fail('runtime.treeDigest 与文件列表不一致');
  return {
    algorithm: CANDIDATE_RUNTIME_TREE_ALGORITHM,
    fileCount: files.length,
    treeDigest: expectedDigest,
    files,
  };
}

function parseEvidence(value: unknown): CandidateEvidence {
  const evidence = record(value, 'packed.json');
  if (evidence.schemaVersion !== CANDIDATE_EVIDENCE_SCHEMA_VERSION) {
    fail(`packed.json schemaVersion 必须是 ${CANDIDATE_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (evidence.status !== 'packed' && evidence.status !== 'staged') fail('status 非法');
  exactString(evidence.packageName, PACKAGE_NAME, 'packageName');
  if (typeof evidence.version !== 'string' || !EXACT_VERSION.test(evidence.version)) {
    fail('version 非法');
  }
  if (typeof evidence.commit !== 'string' || !GIT_SHA.test(evidence.commit)) {
    fail('commit 非法');
  }
  exactString(evidence.sourceRef, 'refs/heads/main', 'sourceRef');
  exactString(evidence.sourceWorkflow, CANDIDATE_WORKFLOW, 'sourceWorkflow');
  exactString(evidence.sourceRepository, SOURCE_REPOSITORY, 'sourceRepository');
  if (
    typeof evidence.candidateWorkflowRunId !== 'string' ||
    !RUN_ID.test(evidence.candidateWorkflowRunId)
  ) {
    fail('candidateWorkflowRunId 非法');
  }
  const tarball = record(evidence.tarball, 'tarball');
  if (typeof tarball.sha256 !== 'string' || !RAW_SHA256.test(tarball.sha256)) {
    fail('tarball.sha256 非法');
  }
  const runtime = parseRuntime(evidence.runtime);
  if (
    typeof evidence.candidateIdentityDigest !== 'string' ||
    !SHA256.test(evidence.candidateIdentityDigest)
  ) {
    fail('candidateIdentityDigest 非法');
  }
  return {
    schemaVersion: CANDIDATE_EVIDENCE_SCHEMA_VERSION,
    status: evidence.status,
    packageName: PACKAGE_NAME,
    version: evidence.version,
    commit: evidence.commit,
    sourceRef: 'refs/heads/main',
    sourceWorkflow: CANDIDATE_WORKFLOW,
    sourceRepository: SOURCE_REPOSITORY,
    candidateWorkflowRunId: evidence.candidateWorkflowRunId,
    tarball: { sha256: tarball.sha256 },
    runtime,
    candidateIdentityDigest: evidence.candidateIdentityDigest,
  };
}

function readEvidence(path: string): CandidateEvidence {
  const file = readStableFile(path, { label: '候选证据', maxBytes: MAX_EVIDENCE_BYTES });
  if (file.status !== 'ready') {
    fail(file.status === 'missing' ? '候选证据不存在' : file.diagnostic);
  }
  try {
    return parseEvidence(JSON.parse(file.bytes.toString('utf8')) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('候选身份不可验证：')) throw error;
    fail(`候选证据不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function installedPackageFiles(packageRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch {
      fail(`无法枚举候选包目录：${prefix || '.'}`);
    }
    for (const name of names) {
      const path = resolve(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        fail(`无法检查候选包路径：${relativePath}`);
      }
      if (stat.isSymbolicLink()) fail(`候选包包含链接：${relativePath}`);
      if (realpathSync(path) !== path) fail(`候选包路径经过链接目录：${relativePath}`);
      if (stat.isDirectory()) {
        visit(path, relativePath);
      } else if (stat.isFile()) {
        files.push(relativePath);
      } else {
        fail(`候选包包含非常规路径：${relativePath}`);
      }
    }
  };
  visit(packageRoot, '');
  return files;
}

function assertExactInstalledFileSet(packageRoot: string, expected: readonly string[]): void {
  const observed = installedPackageFiles(packageRoot);
  if (
    observed.length !== expected.length ||
    observed.some((path, index) => path !== expected[index])
  ) {
    const expectedSet = new Set(expected);
    const observedSet = new Set(observed);
    const missing = expected.filter((path) => !observedSet.has(path));
    const extra = observed.filter((path) => !expectedSet.has(path));
    fail(
      `安装包文件集合与打包证据不一致` +
        `${missing.length === 0 ? '' : `；缺少：${missing.join('、')}`}` +
        `${extra.length === 0 ? '' : `；多出：${extra.join('、')}`}`,
    );
  }
}

export function verifyCandidateRuntime(options: {
  readonly evidencePath: string;
  readonly packageRoot: string;
  readonly expectedVersion?: string;
}): VerifiedCandidateIdentity {
  const evidencePath = realpathSync(resolve(options.evidencePath));
  const packageRoot = realpathSync(resolve(options.packageRoot));
  const evidence = readEvidence(evidencePath);
  const expectedVersion = options.expectedVersion ?? CODING_X_VERSION;
  if (evidence.version !== expectedVersion) {
    fail(`候选版本 ${evidence.version} 与当前 CLI ${expectedVersion} 不一致`);
  }

  const expectedPaths = evidence.runtime.files.map((file) => file.path);
  assertExactInstalledFileSet(packageRoot, expectedPaths);
  const observedFiles = evidence.runtime.files.map((expected) => {
    const path = resolve(packageRoot, ...expected.path.split('/'));
    const relationToRoot = relative(packageRoot, path);
    if (
      relationToRoot === '' ||
      relationToRoot === '..' ||
      relationToRoot.startsWith(`..${sep}`) ||
      isAbsolute(relationToRoot)
    ) {
      fail(`runtime 文件解析到包根之外：${expected.path}`);
    }
    try {
      if (realpathSync(path) !== path) fail(`候选运行文件经过链接目录：${expected.path}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('候选身份不可验证：')) throw error;
      fail(`候选运行文件无法解析：${expected.path}`);
    }
    const file = readStableFile(path, {
      label: `候选运行文件 ${expected.path}`,
      maxBytes: expected.size,
    });
    if (file.status !== 'ready') {
      fail(
        file.status === 'missing'
          ? `候选运行文件缺失：${expected.path}`
          : `候选运行文件不可读取：${expected.path}（${file.diagnostic}）`,
      );
    }
    if (file.bytes.byteLength !== expected.size || file.fingerprint !== expected.sha256) {
      fail(`候选运行文件与打包证据不一致：${expected.path}`);
    }
    return expected;
  });
  assertExactInstalledFileSet(packageRoot, expectedPaths);
  const runtimeTreeDigest = candidateRuntimeTreeDigest(observedFiles);
  if (runtimeTreeDigest !== evidence.runtime.treeDigest) fail('实际运行文件树摘要不一致');

  const identity: CandidateIdentityFields = {
    packageName: PACKAGE_NAME,
    version: evidence.version,
    commit: evidence.commit,
    candidateWorkflowRunId: evidence.candidateWorkflowRunId,
    tarballSha256: `sha256:${evidence.tarball.sha256}`,
    runtimeTreeDigest,
  };
  const identityDigest = candidateIdentityDigest(identity);
  if (identityDigest !== evidence.candidateIdentityDigest) {
    fail('candidateIdentityDigest 与候选内容不一致');
  }
  return {
    schemaVersion: 1,
    ...identity,
    digest: identityDigest,
    evidencePath,
  };
}

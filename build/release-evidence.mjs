#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_MANIFESTS, RUNTIME_VERSION_SOURCE } from './sync-plugin-versions.mjs';

const SCHEMA_VERSION = 2;
const PACKAGE_NAME = 'coding-x';
const STAGE_TAG = 'next';
const STABLE_TAG = 'latest';
const CANDIDATE_WORKFLOW = '.github/workflows/build-candidate.yml';
const STAGE_WORKFLOW = '.github/workflows/stage-candidate.yml';
const SOURCE_REPOSITORY = 'https://github.com/Xinzz995/coding-engine';
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(values) {
  const args = {};
  for (let index = 0; index < values.length; index++) {
    const token = values[index];
    if (!token.startsWith('--')) fail(`未知参数 ${token}`);
    const name = token.slice(2);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) fail(`参数 --${name} 缺少值`);
    if (Object.hasOwn(args, name)) fail(`重复参数 --${name}`);
    args[name] = value;
    index++;
  }
  return args;
}

function required(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value === '') fail(`缺少 --${name}`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, args, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : String(error);
    fail(`git ${args.join(' ')} 失败：${detail}`);
  }
}

function versionTuple(value, name) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) fail(`${name} 不是可比较版本：${value}`);
  return match.slice(1).map(Number);
}

function compareVersion(actual, expected, name) {
  const left = versionTuple(actual, name);
  const right = versionTuple(expected, name);
  for (let index = 0; index < 3; index++) {
    if (left[index] > right[index]) return;
    if (left[index] < right[index]) fail(`${name} ${actual} 低于最低要求 ${expected}`);
  }
}

function npmVersion() {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
      encoding: 'utf8',
    }).trim();
  }
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm --version'], {
      encoding: 'utf8',
    }).trim();
  }
  return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
}

function releaseToolchain(args) {
  const node = process.versions.node;
  const npm = npmVersion();
  if (args['require-node-major']) {
    const expectedMajor = Number(args['require-node-major']);
    if (Number(node.split('.')[0]) !== expectedMajor) {
      fail(`发布任务必须使用 Node ${expectedMajor}，实际为 ${node}`);
    }
  }
  compareVersion(npm, args['min-npm'] ?? '11.15.0', 'npm');
  return { node, npm };
}

function versionEntries(root) {
  const lock = readJson(join(root, 'package-lock.json'));
  const entries = {
    'package.json': readJson(join(root, 'package.json')).version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    [RUNTIME_VERSION_SOURCE]: readFileSync(join(root, RUNTIME_VERSION_SOURCE), 'utf8').match(
      /CODING_X_VERSION\s*=\s*'([^']+)'/,
    )?.[1],
  };
  for (const relativePath of PLUGIN_MANIFESTS) {
    entries[relativePath] = readJson(join(root, relativePath)).version;
  }
  return entries;
}

function verifyVersions(root, expectedVersion) {
  if (!EXACT_VERSION.test(expectedVersion)) fail(`候选版本必须是精确稳定版本：${expectedVersion}`);
  const entries = versionEntries(root);
  for (const [name, version] of Object.entries(entries)) {
    if (version !== expectedVersion)
      fail(`${name} 的版本 ${String(version)} 与候选版本 ${expectedVersion} 不一致`);
  }
}

function hashes(path) {
  const bytes = readFileSync(path);
  return {
    size: bytes.length,
    sha1: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

function onePackEntry(value) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
    fail('npm pack --json 必须返回唯一候选包');
  }
  return value[0];
}

function stageEntry(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.stageId === 'string'
  ) {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidates = Object.values(value).filter(
      (entry) => entry && typeof entry === 'object' && typeof entry.stageId === 'string',
    );
    if (candidates.length === 1) return candidates[0];
  }
  fail('npm stage publish --json 未返回唯一 stageId');
}

function verifyEvidenceIdentity(evidence) {
  if (
    !evidence ||
    evidence.schemaVersion !== SCHEMA_VERSION ||
    evidence.packageName !== PACKAGE_NAME ||
    !EXACT_VERSION.test(evidence.version ?? '')
  ) {
    fail('候选证据格式或包身份非法');
  }
  if (!GIT_SHA.test(evidence.commit ?? '')) fail('候选证据没有合法的 Git commit');
  if (
    evidence.sourceRef !== 'refs/heads/main' ||
    evidence.sourceWorkflow !== CANDIDATE_WORKFLOW ||
    evidence.sourceRepository !== SOURCE_REPOSITORY
  ) {
    fail('候选证据的仓库、工作流或来源分支非法');
  }
  if (!/^\d+$/.test(evidence.candidateWorkflowRunId ?? '')) {
    fail('候选证据没有合法的 candidate workflow run ID');
  }
  if (!['packed', 'staged'].includes(evidence.status)) fail('候选证据状态非法');
  if (evidence.requestedTag !== STAGE_TAG) fail('候选证据没有绑定 next 标签');
  if (
    evidence.tarball?.filename !== `${PACKAGE_NAME}-${evidence.version}.tgz` ||
    !Number.isInteger(evidence.tarball?.size) ||
    evidence.tarball.size < 1 ||
    !/^[0-9a-f]{40}$/.test(evidence.tarball?.sha1 ?? '') ||
    !/^[0-9a-f]{64}$/.test(evidence.tarball?.sha256 ?? '') ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(evidence.tarball?.integrity ?? '')
  ) {
    fail('候选证据的 tarball 身份或摘要格式非法');
  }
  if (typeof evidence.toolchain?.node !== 'string' || typeof evidence.toolchain?.npm !== 'string') {
    fail('候选证据缺少工具链身份');
  }
  if (
    evidence.status === 'staged' &&
    (typeof evidence.stageToolchain?.node !== 'string' ||
      typeof evidence.stageToolchain?.npm !== 'string' ||
      evidence.stageWorkflow !== STAGE_WORKFLOW ||
      !/^\d+$/.test(evidence.stageWorkflowRunId ?? '') ||
      !UUID.test(evidence.stageId ?? '') ||
      Number.isNaN(Date.parse(evidence.stagedAt ?? '')))
  ) {
    fail('候选证据缺少合法的暂存身份或暂存工具链');
  }
}

function verifyTarballAgainstEvidence(evidence, tarballPath) {
  verifyEvidenceIdentity(evidence);
  const actual = hashes(tarballPath);
  for (const name of ['size', 'sha1', 'sha256', 'integrity']) {
    if (actual[name] !== evidence.tarball?.[name]) {
      fail(`候选 tarball 的 ${name} 与证据不一致`);
    }
  }
  return actual;
}

function commandVerifySource(args) {
  const root = resolve(args.root ?? process.cwd());
  const version = required(args, 'expected-version');
  const commit = required(args, 'commit');
  const selectedRef = required(args, 'ref');
  const mainRef = required(args, 'main-ref');
  if (!GIT_SHA.test(commit)) fail(`候选 commit 非法：${commit}`);
  if (selectedRef !== 'refs/heads/main')
    fail(`候选构建只能从 refs/heads/main 运行，实际为 ${selectedRef}`);
  verifyVersions(root, version);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (head !== commit) fail(`工作树 HEAD ${head} 与候选提交 ${commit} 不一致`);
  const main = git(root, ['rev-parse', mainRef]);
  if (main !== commit) fail(`候选提交 ${commit} 不是当前远端 main ${main}`);
  if (args['require-node-major']) {
    const expectedMajor = Number(args['require-node-major']);
    const actualMajor = Number(process.versions.node.split('.')[0]);
    if (actualMajor !== expectedMajor) fail(`Node 主版本为 ${actualMajor}，要求 ${expectedMajor}`);
  }
  const actualNpmVersion = npmVersion();
  compareVersion(actualNpmVersion, args['min-npm'] ?? '11.15.0', 'npm');
  process.stdout.write(
    `${JSON.stringify({ packageName: PACKAGE_NAME, version, commit, npmVersion: actualNpmVersion })}\n`,
  );
}

function commandRecordPack(args) {
  const root = resolve(args.root ?? process.cwd());
  const version = required(args, 'expected-version');
  const commit = required(args, 'commit');
  const candidateWorkflowRunId = required(args, 'candidate-workflow-run-id');
  if (!GIT_SHA.test(commit)) fail(`候选 commit 非法：${commit}`);
  if (!/^\d+$/.test(candidateWorkflowRunId)) {
    fail(`candidate workflow run ID 非法：${candidateWorkflowRunId}`);
  }
  const pack = onePackEntry(readJson(required(args, 'pack-json')));
  const tarballPath = resolve(required(args, 'tarball'));
  verifyVersions(root, version);
  if (pack.name !== PACKAGE_NAME || pack.version !== version) fail('npm pack 返回了错误的包或版本');
  const actual = hashes(tarballPath);
  if (pack.filename !== basename(tarballPath)) fail('npm pack 文件名与实际 tarball 不一致');
  if (pack.shasum !== actual.sha1 || String(pack.integrity) !== actual.integrity) {
    fail('npm pack 摘要与实际 tarball 不一致');
  }
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    status: 'packed',
    packageName: PACKAGE_NAME,
    version,
    commit,
    sourceRef: 'refs/heads/main',
    sourceWorkflow: CANDIDATE_WORKFLOW,
    sourceRepository: SOURCE_REPOSITORY,
    candidateWorkflowRunId,
    requestedTag: STAGE_TAG,
    tarball: { filename: basename(tarballPath), ...actual },
    toolchain: releaseToolchain(args),
  };
  writeJson(required(args, 'output'), evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

function commandRecordStage(args) {
  const packed = readJson(required(args, 'candidate'));
  const staged = stageEntry(readJson(required(args, 'stage-json')));
  verifyEvidenceIdentity(packed);
  if (packed.status !== 'packed') fail('暂存前候选证据不是 packed 状态');
  const commit = required(args, 'commit');
  if (packed.commit !== commit || !GIT_SHA.test(commit)) fail('暂存任务与候选 commit 不一致');
  const candidateWorkflowRunId = required(args, 'candidate-workflow-run-id');
  if (
    packed.candidateWorkflowRunId !== candidateWorkflowRunId ||
    !/^\d+$/.test(candidateWorkflowRunId)
  ) {
    fail('暂存任务与候选 candidate workflow run ID 不一致');
  }
  const stageWorkflowRunId = required(args, 'stage-workflow-run-id');
  if (!/^\d+$/.test(stageWorkflowRunId)) {
    fail(`stage workflow run ID 非法：${stageWorkflowRunId}`);
  }
  if (!UUID.test(staged.stageId)) fail(`npm 返回非法 stageId：${String(staged.stageId)}`);
  if (staged.name !== packed.packageName || staged.version !== packed.version) {
    fail('npm staged package 与候选包身份不一致');
  }
  if (
    staged.shasum !== packed.tarball.sha1 ||
    String(staged.integrity) !== packed.tarball.integrity
  ) {
    fail('npm staged package 与预先保存的候选 tarball 不是同一字节内容');
  }
  const evidence = {
    ...packed,
    status: 'staged',
    stageWorkflow: STAGE_WORKFLOW,
    stageWorkflowRunId,
    stageId: staged.stageId,
    stagedAt: new Date().toISOString(),
    stageToolchain: releaseToolchain(args),
  };
  writeJson(required(args, 'output'), evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

function commandVerifyTarball(args) {
  const evidence = readJson(required(args, 'evidence'));
  const actual = verifyTarballAgainstEvidence(evidence, resolve(required(args, 'tarball')));
  process.stdout.write(
    `${JSON.stringify({ status: 'verified', version: evidence.version, ...actual })}\n`,
  );
}

function decodeProvenance(attestations) {
  const entries = Array.isArray(attestations?.attestations) ? attestations.attestations : [];
  const provenance = entries.find(
    (entry) => entry?.predicateType === 'https://slsa.dev/provenance/v1',
  );
  const payload = provenance?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== 'string') fail('npm 未返回 SLSA provenance');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

function commandVerifyRegistry(args) {
  const evidence = readJson(required(args, 'evidence'));
  if (evidence.status !== 'staged' || !UUID.test(evidence.stageId ?? '')) {
    fail('候选证据没有有效的 staged 身份');
  }
  if (evidence.commit !== required(args, 'commit')) fail('发布标签与候选 commit 不一致');
  if (evidence.stageWorkflowRunId !== required(args, 'stage-workflow-run-id')) {
    fail('下载候选与选定的 stage workflow run 不一致');
  }
  if (evidence.stageId !== required(args, 'stage-id')) {
    fail('下载候选与发布标签记录的 npm stage ID 不一致');
  }
  if (evidence.tarball.sha256 !== required(args, 'tarball-sha256')) {
    fail('下载候选与发布标签记录的 tarball SHA-256 不一致');
  }
  const metadata = readJson(required(args, 'metadata'));
  const distTags = readJson(required(args, 'dist-tags'));
  const attestations = readJson(required(args, 'attestations'));
  verifyTarballAgainstEvidence(evidence, resolve(required(args, 'tarball')));
  if (metadata.name !== PACKAGE_NAME || metadata.version !== evidence.version) {
    fail('npm registry 返回了错误的包或版本');
  }
  if (metadata.gitHead !== evidence.commit) fail('npm gitHead 与候选提交不一致');
  if (
    metadata.dist?.shasum !== evidence.tarball.sha1 ||
    metadata.dist?.integrity !== evidence.tarball.integrity
  ) {
    fail('npm registry tarball 摘要与 staged 候选不一致');
  }
  if (distTags[STAGE_TAG] !== evidence.version || distTags[STABLE_TAG] !== evidence.version) {
    fail(`npm dist-tag 未同时把 ${STAGE_TAG} 与 ${STABLE_TAG} 指向候选版本`);
  }

  const statement = decodeProvenance(attestations);
  const expectedSha512 = Buffer.from(
    evidence.tarball.integrity.slice('sha512-'.length),
    'base64',
  ).toString('hex');
  const subject = Array.isArray(statement.subject)
    ? statement.subject.find(
        (entry) => entry?.name === `pkg:npm/${PACKAGE_NAME}@${evidence.version}`,
      )
    : null;
  if (subject?.digest?.sha512 !== expectedSha512) fail('npm provenance 主体摘要与候选包不一致');
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (
    workflow?.repository !== SOURCE_REPOSITORY ||
    workflow?.path !== STAGE_WORKFLOW ||
    workflow?.ref !== 'refs/heads/main'
  ) {
    fail('npm provenance 的仓库、工作流或来源分支不正确');
  }
  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies;
  if (
    !Array.isArray(dependencies) ||
    !dependencies.some((entry) => entry?.digest?.gitCommit === evidence.commit)
  ) {
    fail('npm provenance 未绑定候选提交');
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'verified',
      packageName: PACKAGE_NAME,
      version: evidence.version,
      commit: evidence.commit,
      stageId: evidence.stageId,
    })}\n`,
  );
}

function uniqueTagField(message, name, pattern) {
  const prefix = `${name}:`;
  const values = message
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
  if (values.length !== 1 || !pattern.test(values[0])) {
    fail(`发布标签必须包含唯一合法的 ${name}`);
  }
  return values[0];
}

function commandVerifyTag(args) {
  const root = resolve(args.root ?? process.cwd());
  const tag = required(args, 'tag');
  const commit = required(args, 'commit');
  if (!GIT_SHA.test(commit)) fail(`发布 commit 非法：${commit}`);
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    fail(`发布标签格式非法：${tag}`);
  }
  const version = tag.slice(1);
  verifyVersions(root, version);
  const objectType = git(root, ['cat-file', '-t', `refs/tags/${tag}`]);
  if (objectType !== 'tag') fail(`发布标签 ${tag} 必须是 annotated tag`);
  const taggedCommit = git(root, ['rev-parse', `${tag}^{commit}`]);
  if (taggedCommit !== commit) fail(`发布标签指向 ${taggedCommit}，预期 ${commit}`);
  const mainRef = required(args, 'main-ref');
  if (git(root, ['merge-base', '--is-ancestor', commit, mainRef], true) === null) {
    fail(`发布提交 ${commit} 不属于受保护的 main 历史`);
  }
  const message = git(root, ['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`]);
  const stageRunId = uniqueTagField(message, 'Stage-Run-ID', /^\d+$/);
  const stageId = uniqueTagField(message, 'Npm-Stage-ID', UUID);
  const tarballSha256 = uniqueTagField(message, 'Candidate-SHA256', /^[0-9a-f]{64}$/);
  const result = {
    packageName: PACKAGE_NAME,
    version,
    commit,
    tag,
    stageRunId,
    stageId,
    tarballSha256,
  };
  if (args.output) writeJson(resolve(args.output), result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const [command, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
const commands = {
  'verify-source': commandVerifySource,
  'record-pack': commandRecordPack,
  'record-stage': commandRecordStage,
  'verify-tarball': commandVerifyTarball,
  'verify-registry': commandVerifyRegistry,
  'verify-tag': commandVerifyTag,
};

try {
  if (!command || !commands[command]) fail(`未知命令 ${String(command)}`);
  commands[command](args);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

export const RELEASE_EVIDENCE_SCRIPT = fileURLToPath(import.meta.url);

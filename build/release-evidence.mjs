#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStableCandidateFile } from './candidate-install-smoke.mjs';
import { PLUGIN_MANIFESTS, RUNTIME_VERSION_SOURCE } from './sync-plugin-versions.mjs';

const SCHEMA_VERSION = 3;
const PACKAGE_NAME = 'coding-x';
const STAGE_TAG = 'next';
const STABLE_TAG = 'latest';
const CANDIDATE_WORKFLOW = '.github/workflows/build-candidate.yml';
const STAGE_WORKFLOW = '.github/workflows/stage-candidate.yml';
const SOURCE_REPOSITORY = 'https://github.com/Xinzz995/coding-engine';
const SOURCE_REPOSITORY_FULL_NAME = 'Xinzz995/coding-engine';
const STAGE_ENVIRONMENT = 'npm-staging';
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_TREE_ALGORITHM = 'sha256-path-size-bytes-v1';
const RUNTIME_TREE_DOMAIN = 'coding-x-candidate-runtime-tree-v1';
const CANDIDATE_IDENTITY_DOMAIN = 'coding-x-candidate-identity-v1';
const CANDIDATE_PROOF_DOMAIN = 'coding-x-candidate-dogfood-proof-v1';
const DOGFOOD_SET_DOMAIN = 'coding-x-candidate-dogfood-set-v1';
const GITHUB_ACTIONS_APP_ID = 15_368;
const MAX_RUNTIME_FILES = 4096;
const MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024;

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

function sha256Digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function candidateRuntimeTreeDigest(files) {
  return sha256Digest({
    domain: RUNTIME_TREE_DOMAIN,
    algorithm: RUNTIME_TREE_ALGORITHM,
    files,
  });
}

function candidateIdentityDigest(evidence) {
  return sha256Digest({
    schemaVersion: 1,
    domain: CANDIDATE_IDENTITY_DOMAIN,
    packageName: evidence.packageName,
    version: evidence.version,
    commit: evidence.commit,
    candidateWorkflowRunId: evidence.candidateWorkflowRunId,
    tarballSha256: `sha256:${evidence.tarball.sha256}`,
    runtimeTreeDigest: evidence.runtime.treeDigest,
  });
}

function runtimePath(value, index) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`npm pack files[${index}].path 非法`);
  }
  return value;
}

function runtimeTreeFromPack(root, pack) {
  if (
    !Array.isArray(pack.files) ||
    pack.files.length < 2 ||
    pack.files.length > MAX_RUNTIME_FILES
  ) {
    fail('npm pack 没有返回有界的完整文件清单');
  }
  const canonicalRoot = realpathSync(root);
  const files = pack.files
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail(`npm pack files[${index}] 非法`);
      }
      const path = runtimePath(entry.path, index);
      const target = resolve(canonicalRoot, ...path.split('/'));
      const relation = relative(canonicalRoot, target);
      if (
        relation === '' ||
        relation === '..' ||
        relation.startsWith(`..${sep}`) ||
        isAbsolute(relation)
      ) {
        fail(`npm pack 文件解析到项目根之外：${path}`);
      }
      const bytes = readStableCandidateFile(target, {
        label: `npm pack 文件 ${path}`,
        minBytes: 0,
        maxBytes: MAX_RUNTIME_FILE_BYTES,
        afterOpen: () => {
          if (realpathSync(target) !== target) fail(`npm pack 文件经过链接目录：${path}`);
        },
      });
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_RUNTIME_FILE_BYTES ||
        entry.size !== bytes.byteLength
      ) {
        fail(`npm pack 文件大小与源文件不一致：${path}`);
      }
      return {
        path,
        size: bytes.byteLength,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) fail('npm pack 文件清单含重复路径');
  if (!paths.includes('package.json') || !paths.includes('dist/cli.js')) {
    fail('npm pack 文件清单缺少 package.json 或 dist/cli.js');
  }
  return {
    algorithm: RUNTIME_TREE_ALGORITHM,
    fileCount: files.length,
    treeDigest: candidateRuntimeTreeDigest(files),
    files,
  };
}

function verifyRuntimeTree(runtime) {
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    Array.isArray(runtime) ||
    runtime.algorithm !== RUNTIME_TREE_ALGORITHM ||
    !Array.isArray(runtime.files) ||
    runtime.files.length < 2 ||
    runtime.files.length > MAX_RUNTIME_FILES ||
    runtime.fileCount !== runtime.files.length
  ) {
    fail('候选证据缺少合法的运行文件树');
  }
  const paths = [];
  for (const [index, entry] of runtime.files.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`候选运行文件 ${index} 非法`);
    }
    const path = runtimePath(entry.path, index);
    paths.push(path);
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_RUNTIME_FILE_BYTES ||
      !SHA256_DIGEST.test(entry.sha256 ?? '')
    ) {
      fail(`候选运行文件身份非法：${path}`);
    }
  }
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => path !== [...paths].sort()[index]) ||
    !paths.includes('package.json') ||
    !paths.includes('dist/cli.js')
  ) {
    fail('候选运行文件路径集合非法');
  }
  const expected = candidateRuntimeTreeDigest(runtime.files);
  if (!SHA256_DIGEST.test(runtime.treeDigest ?? '') || runtime.treeDigest !== expected) {
    fail('候选运行文件树摘要非法');
  }
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
  verifyRuntimeTree(evidence.runtime);
  if (
    !SHA256_DIGEST.test(evidence.candidateIdentityDigest ?? '') ||
    evidence.candidateIdentityDigest !== candidateIdentityDigest(evidence)
  ) {
    fail('候选证据的候选身份摘要非法');
  }
  if (evidence.status === 'staged') verifyDogfoodSet(evidence.dogfood, evidence);
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

function verifyDogfoodSet(value, candidate) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.status !== 'verified' ||
    value.candidateIdentityDigest !== candidate.candidateIdentityDigest ||
    value.candidateWorkflowRunId !== candidate.candidateWorkflowRunId ||
    value.tarballSha256 !== `sha256:${candidate.tarball.sha256}` ||
    !Array.isArray(value.proofs) ||
    value.proofs.length !== 3
  ) {
    fail('三仓 Dogfood 汇总证据与候选身份不一致');
  }
  const roles = value.proofs.map((proof) => proof?.role);
  const repositories = value.proofs.map((proof) => proof?.repository);
  if (
    !['engine', 'go', 'python'].every((role) => roles.includes(role)) ||
    new Set(roles).size !== 3 ||
    new Set(repositories).size !== 3
  ) {
    fail('三仓 Dogfood 汇总缺少唯一的 engine/go/python 证明');
  }
  for (const [index, proof] of value.proofs.entries()) {
    if (
      !proof ||
      typeof proof !== 'object' ||
      Array.isArray(proof) ||
      typeof proof.repository !== 'string' ||
      !Number.isSafeInteger(proof.prNumber) ||
      proof.prNumber < 1 ||
      !GIT_SHA.test(proof.headSha ?? '') ||
      !SHA256_DIGEST.test(proof.proofDigest ?? '') ||
      !Number.isSafeInteger(proof.commentId) ||
      proof.commentId < 1 ||
      typeof proof.commentUrl !== 'string' ||
      Number.isNaN(Date.parse(proof.completedAt ?? ''))
    ) {
      fail(`三仓 Dogfood proofs[${index}] 非法`);
    }
  }
  const base = {
    schemaVersion: 1,
    status: 'verified',
    candidateIdentityDigest: value.candidateIdentityDigest,
    candidateWorkflowRunId: value.candidateWorkflowRunId,
    tarballSha256: value.tarballSha256,
    proofs: value.proofs,
  };
  const expected = sha256Digest({ domain: DOGFOOD_SET_DOMAIN, evidence: base });
  if (!SHA256_DIGEST.test(value.digest ?? '') || value.digest !== expected) {
    fail('三仓 Dogfood 汇总摘要非法');
  }
  return { ...base, digest: expected };
}

function oneOf(value, values, label) {
  if (!values.includes(value)) fail(`${label} 非法`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    fail(`${label} 必须是非空字符串`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} 必须是正整数`);
  return value;
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象`);
  return value;
}

function exactObject(value, keys, label) {
  const object = jsonObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} 字段必须精确为 ${expected.join(', ')}`);
  }
  return object;
}

function parseNpmStagingPolicy(value) {
  const policy = exactObject(
    value,
    [
      'schemaVersion',
      'repository',
      'environment',
      'canAdminsBypass',
      'requiredReviewers',
      'deploymentBranchPolicy',
      'branchPolicies',
    ],
    'npm staging policy',
  );
  if (
    policy.schemaVersion !== 1 ||
    policy.repository !== SOURCE_REPOSITORY_FULL_NAME ||
    policy.environment !== STAGE_ENVIRONMENT ||
    policy.canAdminsBypass !== false
  ) {
    fail('npm staging policy 必须固定当前仓库、npm-staging 且禁止管理员绕过');
  }
  const reviewers = exactObject(
    policy.requiredReviewers,
    ['minimumCount', 'preventSelfReview'],
    'npm staging policy requiredReviewers',
  );
  if (reviewers.minimumCount !== 1 || reviewers.preventSelfReview !== false) {
    fail('npm staging policy 必须要求至少一个批准人并允许单人自审');
  }
  const deployment = exactObject(
    policy.deploymentBranchPolicy,
    ['protectedBranches', 'customBranchPolicies'],
    'npm staging policy deploymentBranchPolicy',
  );
  if (deployment.protectedBranches !== false || deployment.customBranchPolicies !== true) {
    fail('npm staging policy 必须使用显式分支政策，不能使用旧 protected branches 模式');
  }
  if (!Array.isArray(policy.branchPolicies) || policy.branchPolicies.length !== 1) {
    fail('npm staging policy 必须精确声明一个分支政策');
  }
  const branch = exactObject(policy.branchPolicies[0], ['name', 'type'], 'npm staging branch policy');
  if (branch.name !== 'main' || branch.type !== 'branch') {
    fail('npm staging policy 必须只允许 main 分支，不能允许标签或通配符');
  }
  return {
    repository: policy.repository,
    environment: policy.environment,
    canAdminsBypass: policy.canAdminsBypass,
    requiredReviewers: reviewers,
    deploymentBranchPolicy: deployment,
    branchPolicies: [branch],
  };
}

function verifyNpmStagingEnvironment(policy, environmentValue, branchPoliciesValue) {
  const environment = jsonObject(environmentValue, 'GitHub npm-staging environment');
  if (environment.name !== policy.environment) {
    fail(`GitHub environment 不是 ${policy.environment}`);
  }
  if (environment.can_admins_bypass !== policy.canAdminsBypass) {
    fail('GitHub npm-staging 必须禁止管理员绕过批准');
  }
  if (!Array.isArray(environment.protection_rules)) {
    fail('GitHub npm-staging 缺少保护规则');
  }
  const reviewerRules = environment.protection_rules.filter(
    (entry) => jsonObject(entry, 'GitHub environment protection rule').type === 'required_reviewers',
  );
  const branchRules = environment.protection_rules.filter(
    (entry) => jsonObject(entry, 'GitHub environment protection rule').type === 'branch_policy',
  );
  if (reviewerRules.length !== 1 || branchRules.length !== 1) {
    fail('GitHub npm-staging 必须各有且仅有一条批准人规则和分支规则');
  }
  const reviewerRule = reviewerRules[0];
  if (reviewerRule.prevent_self_review !== policy.requiredReviewers.preventSelfReview) {
    fail('GitHub npm-staging 必须允许单人管理员批准自己的运行');
  }
  if (
    !Array.isArray(reviewerRule.reviewers) ||
    reviewerRule.reviewers.length < policy.requiredReviewers.minimumCount
  ) {
    fail('GitHub npm-staging 必须至少配置一个批准人');
  }
  for (const [index, value] of reviewerRule.reviewers.entries()) {
    const reviewerEntry = jsonObject(value, `GitHub environment reviewer[${index}]`);
    const reviewer = jsonObject(
      reviewerEntry.reviewer,
      `GitHub environment reviewer[${index}] identity`,
    );
    if (
      !['User', 'Team'].includes(reviewerEntry.type) ||
      !Number.isSafeInteger(reviewer.id) ||
      reviewer.id < 1
    ) {
      fail(`GitHub npm-staging reviewer[${index}] 身份非法`);
    }
  }
  const deployment = jsonObject(
    environment.deployment_branch_policy,
    'GitHub environment deployment branch policy',
  );
  if (
    deployment.protected_branches !== policy.deploymentBranchPolicy.protectedBranches ||
    deployment.custom_branch_policies !== policy.deploymentBranchPolicy.customBranchPolicies
  ) {
    fail('GitHub npm-staging 必须启用显式分支政策并关闭旧 protected branches 模式');
  }
  const branchPolicies = jsonObject(branchPoliciesValue, 'GitHub deployment branch policies');
  if (
    branchPolicies.total_count !== policy.branchPolicies.length ||
    !Array.isArray(branchPolicies.branch_policies) ||
    branchPolicies.branch_policies.length !== policy.branchPolicies.length
  ) {
    fail('GitHub npm-staging 必须精确配置一个部署分支政策');
  }
  const actualBranch = jsonObject(branchPolicies.branch_policies[0], 'GitHub deployment branch policy');
  const expectedBranch = policy.branchPolicies[0];
  if (actualBranch.name !== expectedBranch.name || actualBranch.type !== expectedBranch.type) {
    fail('GitHub npm-staging 必须只允许 main 分支，不能允许标签或通配符');
  }
  return {
    status: 'verified',
    repository: policy.repository,
    environment: policy.environment,
    canAdminsBypass: policy.canAdminsBypass,
    reviewerCount: reviewerRule.reviewers.length,
    preventSelfReview: policy.requiredReviewers.preventSelfReview,
    branches: policy.branchPolicies.map((entry) => entry.name),
  };
}

function timestamp(value, label) {
  const text = nonEmptyString(value, label);
  if (Number.isNaN(Date.parse(text))) fail(`${label} 必须是合法时间`);
  return text;
}

function candidateProofDigest(proof) {
  return sha256Digest({ domain: CANDIDATE_PROOF_DOMAIN, proof });
}

function parseDogfoodPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    fail('三仓 Dogfood policy 格式非法');
  }
  const marker = nonEmptyString(value.proofMarker, 'dogfood policy proofMarker');
  if (!Array.isArray(value.trustedAuthors) || value.trustedAuthors.length < 1) {
    fail('三仓 Dogfood policy 缺少 trustedAuthors');
  }
  const trustedAuthors = value.trustedAuthors.map((author, index) =>
    nonEmptyString(author, `dogfood policy trustedAuthors[${index}]`),
  );
  if (new Set(trustedAuthors).size !== trustedAuthors.length) {
    fail('三仓 Dogfood policy trustedAuthors 重复');
  }
  if (!Array.isArray(value.repositories) || value.repositories.length !== 3) {
    fail('三仓 Dogfood policy 必须精确声明三个仓库');
  }
  const repositories = value.repositories.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`dogfood policy repositories[${index}] 非法`);
    }
    return {
      role: oneOf(entry.role, ['engine', 'go', 'python'], `repositories[${index}].role`),
      fullName: nonEmptyString(entry.fullName, `repositories[${index}].fullName`),
      defaultBranch: nonEmptyString(entry.defaultBranch, `repositories[${index}].defaultBranch`),
    };
  });
  if (
    new Set(repositories.map((entry) => entry.role)).size !== 3 ||
    new Set(repositories.map((entry) => entry.fullName.toLowerCase())).size !== 3
  ) {
    fail('三仓 Dogfood policy 的 role 或仓库重复');
  }
  return { schemaVersion: 1, marker, trustedAuthors, repositories };
}

function proofJsonFromComment(body, marker) {
  if (typeof body !== 'string') return null;
  const first = body.indexOf(marker);
  if (first < 0 || body.indexOf(marker, first + marker.length) >= 0) return null;
  const encoded = body.slice(first + marker.length).trim();
  const match = /^```json\s*\n([\s\S]+)\n```\s*$/u.exec(encoded);
  if (!match) fail('候选证明评论的 JSON 围栏格式非法');
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    fail(`候选证明评论不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeCandidateChecks(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} 必须是非空数组`);
  const checks = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${label}[${index}] 非法`);
    }
    if (
      entry.status !== 'completed' ||
      entry.conclusion !== 'success' ||
      entry.appId !== GITHUB_ACTIONS_APP_ID
    ) {
      fail(`${label}[${index}] 不是 GitHub Actions 成功检查`);
    }
    return {
      name: nonEmptyString(entry.name, `${label}[${index}].name`),
      status: 'completed',
      conclusion: 'success',
      appId: GITHUB_ACTIONS_APP_ID,
      appSlug: nonEmptyString(entry.appSlug, `${label}[${index}].appSlug`),
    };
  });
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    fail(`${label} 含重复检查名`);
  }
  return checks.sort((left, right) => left.name.localeCompare(right.name));
}

function verifyCurrentCandidateChecks(value, expected, headSha, label) {
  if (!Array.isArray(value)) fail(`${label} 当前 check runs 必须是数组`);
  for (const check of expected) {
    const matches = value
      .filter(
        (run) =>
          run &&
          typeof run === 'object' &&
          !Array.isArray(run) &&
          run.name === check.name &&
          run.app?.id === check.appId,
      )
      .map((run, index) => ({
        id: positiveInteger(run.id, `${label} ${check.name} run[${index}].id`),
        headSha: nonEmptyString(run.head_sha, `${label} ${check.name} head_sha`),
        status: nonEmptyString(run.status, `${label} ${check.name} status`),
        conclusion: run.conclusion,
        appSlug: nonEmptyString(run.app?.slug, `${label} ${check.name} app.slug`),
      }))
      .sort((left, right) => right.id - left.id);
    const latest = matches[0];
    if (
      !latest ||
      latest.headSha !== headSha ||
      latest.status !== 'completed' ||
      latest.conclusion !== 'success' ||
      latest.appSlug !== check.appSlug
    ) {
      fail(`${label} 当前检查 ${check.name} 未保持成功`);
    }
  }
}

function normalizeProof(
  value,
  expectedEvidence,
  policyRepository,
  prNumber,
  headSha,
  baseSha,
  checkRuns,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${policyRepository.role} 候选证明必须是对象`);
  }
  if (value.schemaVersion !== 1 || value.status !== 'passed') {
    fail(`${policyRepository.role} 候选证明状态非法`);
  }
  const repository = value.repository;
  if (
    !repository ||
    typeof repository !== 'object' ||
    Array.isArray(repository) ||
    repository.provider !== 'github' ||
    repository.fullName !== policyRepository.fullName ||
    repository.defaultBranch !== policyRepository.defaultBranch
  ) {
    fail(`${policyRepository.role} 候选证明仓库身份非法`);
  }
  const candidate = value.candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail(`${policyRepository.role} 候选证明缺少 candidate`);
  }
  const expectedIdentity = {
    schemaVersion: 1,
    packageName: expectedEvidence.packageName,
    version: expectedEvidence.version,
    commit: expectedEvidence.commit,
    candidateWorkflowRunId: expectedEvidence.candidateWorkflowRunId,
    tarballSha256: `sha256:${expectedEvidence.tarball.sha256}`,
    runtimeTreeDigest: expectedEvidence.runtime.treeDigest,
    digest: expectedEvidence.candidateIdentityDigest,
  };
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (candidate[key] !== expected) {
      fail(`${policyRepository.role} 候选证明的 candidate.${key} 与选定候选不一致`);
    }
  }
  const review = value.review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    fail(`${policyRepository.role} 候选证明缺少 review`);
  }
  if (
    review.prNumber !== prNumber ||
    review.headSha !== headSha ||
    review.baseSha !== baseSha ||
    !SHA256_DIGEST.test(review.bindingDigest ?? '') ||
    !SHA256_DIGEST.test(review.storyValidationDigest ?? '') ||
    !SHA256_DIGEST.test(review.storyValidationEnvironmentDigest ?? '') ||
    review.remoteStatus !== 'ready'
  ) {
    fail(`${policyRepository.role} 候选证明的 Review/PR 绑定非法`);
  }
  const checks = normalizeCandidateChecks(
    review.checks,
    `${policyRepository.role} 候选证明 checks`,
  );
  const normalized = {
    schemaVersion: 1,
    status: 'passed',
    repository: {
      provider: 'github',
      fullName: policyRepository.fullName,
      defaultBranch: policyRepository.defaultBranch,
    },
    candidate: expectedIdentity,
    review: {
      prNumber,
      baseSha: review.baseSha,
      headSha,
      bindingDigest: review.bindingDigest,
      storyValidationDigest: review.storyValidationDigest,
      storyValidationEnvironmentDigest: review.storyValidationEnvironmentDigest,
      remoteStatus: 'ready',
      remoteCheckedAt: timestamp(
        review.remoteCheckedAt,
        `${policyRepository.role} remoteCheckedAt`,
      ),
      checks,
    },
    completedAt: timestamp(value.completedAt, `${policyRepository.role} completedAt`),
  };
  if (
    !SHA256_DIGEST.test(value.proofDigest ?? '') ||
    value.proofDigest !== candidateProofDigest(normalized)
  ) {
    fail(`${policyRepository.role} 候选证明摘要非法`);
  }
  verifyCurrentCandidateChecks(checkRuns, checks, headSha, `${policyRepository.role} 候选证明`);
  return { ...normalized, proofDigest: value.proofDigest };
}

function commandVerifyDogfood(args) {
  const candidate = readJson(required(args, 'candidate'));
  verifyEvidenceIdentity(candidate);
  if (candidate.status !== 'packed') fail('三仓验证必须消费未暂存的 packed 候选');
  const policy = parseDogfoodPolicy(readJson(required(args, 'policy')));
  const observations = readJson(required(args, 'observations'));
  if (
    !observations ||
    typeof observations !== 'object' ||
    Array.isArray(observations) ||
    observations.schemaVersion !== 1 ||
    !Array.isArray(observations.entries) ||
    observations.entries.length !== 3
  ) {
    fail('三仓 Dogfood observations 格式非法');
  }
  const verified = policy.repositories.map((repository) => {
    const matches = observations.entries.filter(
      (entry) => entry?.role === repository.role && entry?.repository === repository.fullName,
    );
    if (matches.length !== 1) fail(`${repository.role} 必须有且只有一份远端观察`);
    const observation = matches[0];
    const pr = observation.pr;
    if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
      fail(`${repository.role} 缺少 PR 观察`);
    }
    const prNumber = positiveInteger(pr.number, `${repository.role} PR number`);
    if (
      pr.state !== 'open' ||
      pr.draft !== false ||
      pr.base?.ref !== repository.defaultBranch ||
      !GIT_SHA.test(pr.base?.sha ?? '') ||
      pr.mergeable !== true ||
      pr.mergeable_state !== 'clean' ||
      !GIT_SHA.test(pr.head?.sha ?? '')
    ) {
      fail(`${repository.role} PR 尚未 ready 或没有绑定当前 head/default branch`);
    }
    if (!Array.isArray(observation.checkRuns)) {
      fail(`${repository.role} 当前 check runs 必须是数组`);
    }
    if (!Array.isArray(observation.comments)) fail(`${repository.role} comments 必须是数组`);
    const trusted = observation.comments.flatMap((comment) => {
      if (
        !comment ||
        typeof comment !== 'object' ||
        Array.isArray(comment) ||
        !policy.trustedAuthors.includes(comment.user?.login) ||
        comment.author_association !== 'OWNER'
      ) {
        return [];
      }
      const proof = proofJsonFromComment(comment.body, policy.marker);
      return proof === null ? [] : [{ comment, proof }];
    });
    if (trusted.length !== 1) {
      fail(`${repository.role} 必须有且只有一条 owner 发布的候选证明评论`);
    }
    const normalized = normalizeProof(
      trusted[0].proof,
      candidate,
      repository,
      prNumber,
      pr.head.sha,
      pr.base.sha,
      observation.checkRuns,
    );
    return {
      role: repository.role,
      repository: repository.fullName,
      prNumber,
      headSha: pr.head.sha,
      proofDigest: normalized.proofDigest,
      commentId: positiveInteger(trusted[0].comment.id, `${repository.role} comment id`),
      commentUrl: nonEmptyString(trusted[0].comment.html_url, `${repository.role} comment URL`),
      completedAt: normalized.completedAt,
    };
  });
  const base = {
    schemaVersion: 1,
    status: 'verified',
    candidateIdentityDigest: candidate.candidateIdentityDigest,
    candidateWorkflowRunId: candidate.candidateWorkflowRunId,
    tarballSha256: `sha256:${candidate.tarball.sha256}`,
    proofs: verified,
  };
  const result = { ...base, digest: sha256Digest({ domain: DOGFOOD_SET_DOMAIN, evidence: base }) };
  writeJson(required(args, 'output'), result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function commandVerifyDogfoodSet(args) {
  const candidate = readJson(required(args, 'candidate'));
  verifyEvidenceIdentity(candidate);
  if (candidate.status !== 'packed') fail('三仓汇总复核必须消费 packed 候选');
  const dogfood = verifyDogfoodSet(readJson(required(args, 'dogfood')), candidate);
  process.stdout.write(
    `${JSON.stringify({
      status: 'verified',
      candidateIdentityDigest: candidate.candidateIdentityDigest,
      dogfoodDigest: dogfood.digest,
    })}\n`,
  );
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

function commandVerifyStageEnvironment(args) {
  const policy = parseNpmStagingPolicy(readJson(resolve(required(args, 'policy'))));
  const repository = required(args, 'repository');
  if (repository !== policy.repository) {
    fail(`workflow 仓库 ${repository} 与 npm staging policy 不一致`);
  }
  const result = verifyNpmStagingEnvironment(
    policy,
    readJson(resolve(required(args, 'environment-json'))),
    readJson(resolve(required(args, 'branch-policies-json'))),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
  const runtime = runtimeTreeFromPack(root, pack);
  const baseEvidence = {
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
    runtime,
    toolchain: releaseToolchain(args),
  };
  const evidence = {
    ...baseEvidence,
    candidateIdentityDigest: candidateIdentityDigest(baseEvidence),
  };
  writeJson(required(args, 'output'), evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

function commandRecordStage(args) {
  const packed = readJson(required(args, 'candidate'));
  const dogfood = readJson(required(args, 'dogfood'));
  const staged = stageEntry(readJson(required(args, 'stage-json')));
  verifyEvidenceIdentity(packed);
  if (packed.status !== 'packed') fail('暂存前候选证据不是 packed 状态');
  const verifiedDogfood = verifyDogfoodSet(dogfood, packed);
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
    dogfood: verifiedDogfood,
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

function commandVerifyCandidateRun(args) {
  const run = readJson(required(args, 'run-json'));
  const candidateWorkflowRunId = required(args, 'candidate-workflow-run-id');
  const commit = required(args, 'commit');
  if (!/^[1-9]\d*$/.test(candidateWorkflowRunId)) {
    fail(`candidate workflow run ID 非法：${candidateWorkflowRunId}`);
  }
  if (!GIT_SHA.test(commit)) fail(`候选 commit 非法：${commit}`);
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    fail('GitHub candidate workflow run 必须是对象');
  }
  if (!Number.isSafeInteger(run.id) || String(run.id) !== candidateWorkflowRunId) {
    fail('GitHub candidate workflow run ID 与选定 run 不一致');
  }
  if (run.head_sha !== commit) fail('GitHub candidate workflow run head 与当前 main 不一致');
  if (run.head_branch !== 'main') fail('GitHub candidate workflow run 不是 main 分支');
  if (run.event !== 'workflow_dispatch') {
    fail('GitHub candidate workflow run 不是 workflow_dispatch 事件');
  }
  if (run.status !== 'completed') fail('GitHub candidate workflow run 尚未 completed');
  if (run.conclusion !== 'success') fail('GitHub candidate workflow run 未成功完成');
  if (run.path !== CANDIDATE_WORKFLOW) {
    fail('GitHub candidate workflow run 路径不是受信任的候选工作流');
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'verified',
      candidateWorkflowRunId,
      commit,
      branch: 'main',
      workflow: CANDIDATE_WORKFLOW,
    })}\n`,
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
  'verify-stage-environment': commandVerifyStageEnvironment,
  'verify-candidate-run': commandVerifyCandidateRun,
  'verify-dogfood': commandVerifyDogfood,
  'verify-dogfood-set': commandVerifyDogfoodSet,
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

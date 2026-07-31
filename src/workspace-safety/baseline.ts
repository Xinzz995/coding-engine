import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  delegatedSemanticFilePaths,
  evaluateDelegatedSemantic,
} from '../contracts/delegated-operation-contract.js';
import {
  DELEGATION_LIMITS,
  DIRECTORY_DIGEST,
  SHA256_PREFIX,
  assertBaselineEntryLimit,
  asStrictRecord,
  canonicalJson,
  compareCanonicalStrings,
  digestBytes,
  invalid,
  isProtocolPath,
  parseStrictJson,
  projectionDigest,
  requireDigest,
  requireExactKeys,
  requireTimestamp,
  requireUuid,
  resolveScanLimits,
  validateContract,
  validateRelativePath,
  workspacePathCollisionKey,
  type BaselineEntry,
  type BaselineScanHooks,
  type BaselineScanLimits,
  type BigStatShape,
  type DelegatedBaseline,
  type DelegatedChange,
  type DelegationContract,
  type DelegationRule,
  type DeltaEvaluation,
  type DeltaEvaluationOptions,
  type ScanObservation,
  type ScanSnapshot,
  type StatSignature,
} from './baseline-contract.js';
import { workspaceDirectoryIdentity } from './filesystem.js';
import { assertWindowsWorkspaceTreeHasNoReparsePoints } from './windows-path-attributes.js';

export {
  DELEGATION_LIMITS,
  assertBaselineEntryLimit,
  workspacePathCollisionKey,
} from './baseline-contract.js';
export type {
  BaselineEntry,
  BaselineScanHooks,
  BaselineScanLimits,
  DelegatedBaseline,
  DelegatedChange,
  DelegationContract,
  DelegationRule,
  DeltaEvaluation,
  DeltaEvaluationOptions,
} from './baseline-contract.js';
function lstatBig(path: string): BigStatShape {
  return lstatSync(path, { bigint: true });
}

function fstatBig(fd: number): BigStatShape {
  return fstatSync(fd, { bigint: true });
}

function sameStat(left: BigStatShape, right: BigStatShape): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

function statSignature(stat: BigStatShape): StatSignature {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    nlink: stat.nlink.toString(),
  };
}

function openReadNoFollow(path: string): number {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  try {
    return openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    return invalid(`文件 no-follow open 失败或类型变化：${path}`);
  }
}

function readStableFile(
  path: string,
  limits: BaselineScanLimits,
): { bytes: Buffer; stat: BigStatShape } {
  let before: BigStatShape;
  try {
    before = lstatBig(path);
  } catch {
    return invalid(`扫描期间文件消失：${path}`);
  }
  if (before.isSymbolicLink()) invalid(`workspace symlink 不允许进入 baseline：${path}`);
  if (!before.isFile()) invalid(`扫描期间文件类型变化：${path}`);
  if (before.nlink !== 1n) invalid(`workspace hardlink 不允许进入 baseline：${path}`);
  if (before.size > BigInt(limits.fileBytes)) invalid(`workspace 文件超过单文件预算：${path}`);
  const fd = openReadNoFollow(path);
  try {
    const opened = fstatBig(fd);
    if (!opened.isFile() || opened.nlink !== 1n || !sameStat(before, opened)) {
      invalid(`扫描期间文件 identity 变化：${path}`);
    }
    const bytes = readFileSync(fd);
    const afterHandle = fstatBig(fd);
    let afterPath: BigStatShape;
    try {
      afterPath = lstatBig(path);
    } catch {
      return invalid(`扫描期间文件路径消失：${path}`);
    }
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink !== 1n ||
      !sameStat(opened, afterHandle) ||
      !sameStat(afterHandle, afterPath) ||
      BigInt(bytes.length) !== afterHandle.size
    ) {
      invalid(`扫描期间文件发生变化：${path}`);
    }
    return { bytes, stat: afterHandle };
  } finally {
    closeSync(fd);
  }
}

function validateRuleTargets(contract: DelegationContract, entries: BaselineEntry[]): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const byCollision = new Map(
    entries.map((entry) => [workspacePathCollisionKey(entry.path), entry.path]),
  );
  for (const rule of contract.rules) {
    const collidingPath = byCollision.get(workspacePathCollisionKey(rule.path));
    if (collidingPath && collidingPath !== rule.path) {
      invalid(`delegation rule 与 workspace path NFC/casefold 冲突：${rule.path}`);
    }
    const entry = byPath.get(rule.path);
    if (rule.semantics === 'whole-file') {
      if (!entry) {
        if (!rule.allow.includes('create')) invalid(`whole-file target 不存在：${rule.path}`);
      } else if (entry.type !== 'file') {
        invalid(`whole-file target 必须是 file：${rule.path}`);
      }
      continue;
    }
    if (rule.semantics === 'add-only-directory') {
      if (entry?.type !== 'directory') {
        invalid(`add-only-directory target 必须是既存 directory：${rule.path}`);
      }
      continue;
    }
    if (rule.semantics === 'append-only' && !entry && rule.allow.includes('create')) {
      continue;
    }
    if (entry?.type !== 'file') {
      invalid(`${rule.semantics} target 必须是既存 file：${rule.path}`);
    }
  }
}

function scanWorkspaceOnce(
  workspace: string,
  contract: DelegationContract,
  projectionMode: 'baseline' | 'current',
  limits: BaselineScanLimits,
): ScanSnapshot {
  const ruleByPath = new Map(contract.rules.map((rule) => [rule.path, rule]));
  const semanticPaths = new Set(delegatedSemanticFilePaths(contract.semantic));
  const semanticFiles = new Map<string, Uint8Array>();
  const entries: BaselineEntry[] = [];
  const observations = new Map<string, ScanObservation>();
  const seen = new Set<string>();
  let totalBytes = 0;

  const addEntry = (entry: BaselineEntry): void => {
    assertBaselineEntryLimit(entries.length + 1);
    entries.push(entry);
  };

  const walk = (
    absoluteDir: string,
    rawRelativeDir: string,
    relativeDir: string,
    depth: number,
  ): void => {
    if (depth > limits.depth) invalid(`workspace 目录深度超过预算：${relativeDir || '.'}`);
    let before: BigStatShape;
    try {
      before = lstatBig(absoluteDir);
    } catch {
      return invalid(`扫描期间目录消失：${relativeDir || '.'}`);
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      invalid(`workspace 目录 identity 非法：${relativeDir || '.'}`);
    }
    const children = readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const child of children) {
      const normalizedName = child.name.normalize('NFC');
      const relativePath = relativeDir ? `${relativeDir}/${normalizedName}` : normalizedName;
      const rawRelativePath = rawRelativeDir ? `${rawRelativeDir}/${child.name}` : child.name;
      const collisionKey = workspacePathCollisionKey(relativePath);
      if (seen.has(collisionKey)) invalid(`workspace path NFC/casefold 冲突：${relativePath}`);
      seen.add(collisionKey);
      const absolutePath = join(absoluteDir, child.name);
      if (isProtocolPath(relativePath)) {
        const markerKey = workspacePathCollisionKey('workspace-safety.json');
        if (collisionKey === markerKey && relativePath !== 'workspace-safety.json') {
          invalid(`workspace safety marker 名称不是 canonical spelling：${relativePath}`);
        }
        const firstSegment = relativePath.split('/')[0];
        if (collisionKey !== markerKey && firstSegment !== 'engine.lock') {
          invalid(`workspace protocol root 名称不是 canonical spelling：${relativePath}`);
        }
        const safety = lstatBig(absolutePath);
        if (
          safety.isSymbolicLink() ||
          (collisionKey === markerKey ? !safety.isFile() : !safety.isDirectory())
        ) {
          invalid(`workspace safety path 类型非法：${relativePath}`);
        }
        continue;
      }
      validateRelativePath(relativePath, 'workspace entry path');
      let stat: BigStatShape;
      try {
        stat = lstatBig(absolutePath);
      } catch {
        return invalid(`扫描期间 entry 消失：${relativePath}`);
      }
      if (stat.isSymbolicLink()) {
        invalid(`workspace symlink 不允许进入 baseline：${relativePath}`);
      }
      if (stat.isDirectory()) {
        addEntry({ path: relativePath, type: 'directory', digest: DIRECTORY_DIGEST });
        walk(absolutePath, rawRelativePath, relativePath, depth + 1);
        const stableDirectory = lstatBig(absolutePath);
        observations.set(relativePath, {
          path: relativePath,
          rawPath: rawRelativePath,
          absolutePath,
          type: 'directory',
          stat: statSignature(stableDirectory),
        });
        continue;
      }
      if (!stat.isFile()) invalid(`workspace 特殊文件不受支持：${relativePath}`);
      const stable = readStableFile(absolutePath, limits);
      if (semanticPaths.has(relativePath)) {
        semanticFiles.set(relativePath, Buffer.from(stable.bytes));
      }
      totalBytes += stable.bytes.length;
      if (totalBytes > limits.totalBytes) invalid('workspace 扫描超过总字节预算');
      const rule = ruleByPath.get(relativePath);
      const protectedProjectionDigest = projectionDigest(
        stable.bytes,
        rule,
        relativePath,
        projectionMode === 'baseline',
      );
      const entry: BaselineEntry = {
        path: relativePath,
        type: 'file',
        bytes: stable.bytes.length,
        digest: digestBytes(stable.bytes),
      };
      if (protectedProjectionDigest !== undefined)
        entry.protectedProjectionDigest = protectedProjectionDigest;
      addEntry(entry);
      observations.set(relativePath, {
        path: relativePath,
        rawPath: rawRelativePath,
        absolutePath,
        type: 'file',
        stat: statSignature(stable.stat),
      });
    }
    let after: BigStatShape;
    try {
      after = lstatBig(absoluteDir);
    } catch {
      return invalid(`扫描期间目录路径消失：${relativeDir || '.'}`);
    }
    if (!after.isDirectory() || after.isSymbolicLink() || !sameStat(before, after)) {
      invalid(`扫描期间目录发生变化：${relativeDir || '.'}`);
    }
    if (relativeDir === '') {
      observations.set('', {
        path: '',
        rawPath: '',
        absolutePath: absoluteDir,
        type: 'directory',
        stat: statSignature(after),
      });
    }
  };

  walk(workspace, '', '', 0);
  entries.sort((left, right) => compareCanonicalStrings(left.path, right.path));
  const comparison = {
    entries,
    observations: [...observations.values()]
      .sort((left, right) => compareCanonicalStrings(left.path, right.path))
      .map(({ absolutePath: _absolutePath, ...observation }) => observation),
  };
  const semantic = evaluateDelegatedSemantic({
    semantic: contract.semantic,
    phase: projectionMode === 'baseline' ? 'baseline' : 'settlement',
    files: semanticFiles,
  });
  return { entries, observations, semantic, comparisonBytes: canonicalJson(comparison) };
}

function scanWorkspaceStable(
  workspace: string,
  contract: DelegationContract,
  projectionMode: 'baseline' | 'current',
  hooks: BaselineScanHooks = {},
): ScanSnapshot {
  const limits = resolveScanLimits(hooks.limits);
  assertWindowsWorkspaceTreeHasNoReparsePoints(workspace, {
    maxBusinessEntries: DELEGATION_LIMITS.entries,
  });
  const first = scanWorkspaceOnce(workspace, contract, projectionMode, limits);
  hooks.afterFirstScan?.();
  const second = scanWorkspaceOnce(workspace, contract, projectionMode, limits);
  assertWindowsWorkspaceTreeHasNoReparsePoints(workspace, {
    maxBusinessEntries: DELEGATION_LIMITS.entries,
  });
  if (first.comparisonBytes !== second.comparisonBytes) {
    invalid('workspace 两次完整 scan 结果不一致');
  }
  return second;
}

function withoutManifestDigest(baseline: Omit<DelegatedBaseline, 'manifestDigest'>): string {
  return digestBytes(canonicalJson(baseline));
}

export function captureDelegatedBaseline(
  workspace: string,
  ownerIdValue: string,
  operationIdValue: string,
  requestedContract: DelegationContract,
  hooks: BaselineScanHooks = {},
): DelegatedBaseline {
  const ownerId = requireUuid(ownerIdValue, 'ownerId');
  const operationId = requireUuid(operationIdValue, 'operationId');
  const canonicalWorkspace = realpathSync(workspace);
  const workspaceInfo = statSync(canonicalWorkspace, { bigint: true });
  if (!workspaceInfo.isDirectory()) invalid('workspace canonical path 必须是 directory');
  const workspaceIdentity = workspaceDirectoryIdentity(canonicalWorkspace, workspaceInfo);
  const contract = validateContract(requestedContract);
  const snapshot = scanWorkspaceStable(canonicalWorkspace, contract, 'baseline', hooks);
  validateRuleTargets(contract, snapshot.entries);
  if (!snapshot.semantic.accepted) {
    invalid(`delegated baseline semantic 非法：${snapshot.semantic.violation}`);
  }
  const partial: Omit<DelegatedBaseline, 'manifestDigest'> = {
    schemaVersion: 1,
    ownerId,
    operationId,
    workspaceIdentity,
    contract,
    contractDigest: digestBytes(canonicalJson(contract)),
    entries: snapshot.entries,
    capturedAt: new Date().toISOString(),
  };
  return { ...partial, manifestDigest: withoutManifestDigest(partial) };
}

function validateBaselineEntry(value: unknown, index: number): BaselineEntry {
  const record = asStrictRecord(value, `baseline entry ${index}`);
  const type = record.type;
  if (type !== 'file' && type !== 'directory') invalid(`baseline entry ${index} type 非法`);
  const hasProjection = Object.hasOwn(record, 'protectedProjectionDigest');
  requireExactKeys(
    record,
    type === 'file'
      ? hasProjection
        ? ['path', 'type', 'bytes', 'digest', 'protectedProjectionDigest']
        : ['path', 'type', 'bytes', 'digest']
      : ['path', 'type', 'digest'],
    `baseline entry ${index}`,
  );
  const path = validateRelativePath(record.path, `baseline entry ${index} path`);
  const digest = requireDigest(record.digest, `baseline entry ${index} digest`);
  if (type === 'directory') {
    if (digest !== DIRECTORY_DIGEST) invalid(`baseline directory digest 非法：${path}`);
    return { path, type, digest };
  }
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) {
    invalid(`baseline entry ${index} bytes 非法`);
  }
  const entry: BaselineEntry = { path, type, bytes: record.bytes as number, digest };
  if (hasProjection) {
    entry.protectedProjectionDigest = requireDigest(
      record.protectedProjectionDigest,
      `baseline entry ${index} projection digest`,
    );
  }
  return entry;
}

export function parseDelegatedBaseline(value: unknown): DelegatedBaseline {
  const record = asStrictRecord(value, 'delegated baseline');
  requireExactKeys(
    record,
    [
      'schemaVersion',
      'ownerId',
      'operationId',
      'workspaceIdentity',
      'contract',
      'contractDigest',
      'entries',
      'capturedAt',
      'manifestDigest',
    ],
    'delegated baseline',
  );
  if (record.schemaVersion !== 1) invalid('delegated baseline schemaVersion 非法');
  const ownerId = requireUuid(record.ownerId, 'ownerId');
  const operationId = requireUuid(record.operationId, 'operationId');
  const workspaceIdentity = requireDigest(record.workspaceIdentity, 'workspaceIdentity');
  const contract = validateContract(record.contract);
  if (canonicalJson(contract) !== canonicalJson(record.contract)) {
    invalid('delegation contract 不是 canonical form');
  }
  const contractDigest = requireDigest(record.contractDigest, 'contractDigest');
  if (contractDigest !== digestBytes(canonicalJson(contract))) {
    invalid('delegation contract digest 不匹配');
  }
  if (!Array.isArray(record.entries)) invalid('delegated baseline entries 非法');
  assertBaselineEntryLimit(record.entries.length);
  const entries = record.entries.map(validateBaselineEntry);
  const seen = new Set<string>();
  let previousPath: string | undefined;
  for (const entry of entries) {
    if (previousPath !== undefined && compareCanonicalStrings(previousPath, entry.path) >= 0) {
      invalid('delegated baseline entries 未严格排序或重复');
    }
    previousPath = entry.path;
    const collisionKey = workspacePathCollisionKey(entry.path);
    if (seen.has(collisionKey)) invalid(`baseline entry NFC/casefold 冲突：${entry.path}`);
    seen.add(collisionKey);
  }
  validateRuleTargets(contract, entries);
  const rules = new Map(contract.rules.map((rule) => [rule.path, rule]));
  for (const entry of entries) {
    const isJsonRule = rules.get(entry.path)?.semantics === 'json-mutable-pointers';
    if (isJsonRule !== (entry.protectedProjectionDigest !== undefined)) {
      invalid(`baseline projection digest 与 rule 不匹配：${entry.path}`);
    }
  }
  const capturedAt = requireTimestamp(record.capturedAt, 'capturedAt');
  const manifestDigest = requireDigest(record.manifestDigest, 'manifestDigest');
  const partial: Omit<DelegatedBaseline, 'manifestDigest'> = {
    schemaVersion: 1,
    ownerId,
    operationId,
    workspaceIdentity,
    contract,
    contractDigest,
    entries,
    capturedAt,
  };
  if (withoutManifestDigest(partial) !== manifestDigest) {
    invalid('delegated baseline digest 不匹配');
  }
  return { ...partial, manifestDigest };
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        invalid('delegated baseline string 包含 unpaired surrogate');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalid('delegated baseline string 包含 unpaired surrogate');
    }
  }
}

export function parseDelegatedBaselineBytes(input: string | Buffer): DelegatedBaseline {
  if (typeof input === 'string') assertWellFormedUnicode(input);
  const inputBytes =
    typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (inputBytes > DELEGATION_LIMITS.baselineBytes) {
    invalid('delegated baseline bytes 超过 64MiB limit');
  }
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return parseDelegatedBaseline(parseStrictJson(bytes, 'delegated-baseline.json'));
}

function action(
  before: BaselineEntry | undefined,
  after: BaselineEntry | undefined,
): DelegatedChange {
  if (before === undefined) return 'create';
  if (after === undefined) return 'delete';
  return 'modify';
}

function entryComparisonBytes(entry: BaselineEntry | undefined): string {
  return entry === undefined ? 'absent' : `present:${canonicalJson(entry)}`;
}

function findRule(path: string, contract: DelegationContract): DelegationRule | undefined {
  const exact = contract.rules.find((rule) => rule.path === path);
  if (exact) return exact;
  return contract.rules.find(
    (rule) => rule.semantics === 'add-only-directory' && path.startsWith(`${rule.path}/`),
  );
}

function readStablePrefixDigest(observation: ScanObservation, bytes: number): string {
  let before: BigStatShape;
  try {
    before = lstatBig(observation.absolutePath);
  } catch {
    return invalid(`append target 路径消失：${observation.path}`);
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    canonicalJson(statSignature(before)) !== canonicalJson(observation.stat)
  ) {
    invalid(`append target identity 在 scan 后变化：${observation.path}`);
  }
  const fd = openReadNoFollow(observation.absolutePath);
  try {
    const opened = fstatBig(fd);
    if (!sameStat(before, opened) || opened.size < BigInt(bytes)) {
      invalid(`append target handle identity/size 变化：${observation.path}`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(bytes, 1)));
    let offset = 0;
    while (offset < bytes) {
      const requested = Math.min(buffer.length, bytes - offset);
      const count = readSync(fd, buffer, 0, requested, offset);
      if (count === 0) invalid(`append prefix 发生短读：${observation.path}`);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const afterHandle = fstatBig(fd);
    let afterPath: BigStatShape;
    try {
      afterPath = lstatBig(observation.absolutePath);
    } catch {
      return invalid(`append target 读后路径消失：${observation.path}`);
    }
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameStat(opened, afterHandle) ||
      !sameStat(afterHandle, afterPath)
    ) {
      invalid(`append target prefix 读取期间变化：${observation.path}`);
    }
    return `${SHA256_PREFIX}${hash.digest('hex')}`;
  } finally {
    closeSync(fd);
  }
}

function wholeFileShapeValid(
  change: DelegatedChange,
  before: BaselineEntry | undefined,
  after: BaselineEntry | undefined,
): boolean {
  if (change === 'create') return after?.type === 'file';
  if (change === 'delete') return before?.type === 'file';
  return before?.type === 'file' && after?.type === 'file';
}

export function evaluateDelegatedDelta(
  workspace: string,
  baselineValue: DelegatedBaseline,
  options: DeltaEvaluationOptions = {},
): DeltaEvaluation {
  const baseline = parseDelegatedBaseline(baselineValue);
  const current = scanWorkspaceStable(workspace, baseline.contract, 'current', options);
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const after = new Map(current.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareCanonicalStrings);
  const changes = paths.filter(
    (path) => entryComparisonBytes(before.get(path)) !== entryComparisonBytes(after.get(path)),
  );
  const semanticViolation = current.semantic.accepted ? undefined : current.semantic.violation;
  const semanticCandidate = current.semantic.accepted ? current.semantic.candidate : undefined;
  if (changes.length === 0 && semanticViolation === undefined) {
    return semanticCandidate
      ? { accepted: true, changes: [], candidate: semanticCandidate }
      : { accepted: true, changes: [] };
  }
  if (options.requireUnchanged) {
    const violations = changes.map((path) => `${path}:prestart-baseline-changed`);
    if (semanticViolation !== undefined) violations.push(semanticViolation);
    return {
      accepted: false,
      changes,
      violations: [...new Set(violations)].sort(compareCanonicalStrings),
    };
  }

  const violations: string[] = semanticViolation === undefined ? [] : [semanticViolation];
  for (const path of changes) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    const change = action(oldEntry, newEntry);
    const rule = findRule(path, baseline.contract);
    if (!rule) {
      violations.push(`${path}:${change}-not-allowed`);
      continue;
    }

    if (rule.semantics === 'add-only-directory') {
      if (oldEntry !== undefined) violations.push(`${path}:existing-member-changed`);
      else if (change !== 'create') violations.push(`${path}:${change}-not-allowed`);
      continue;
    }
    if (!rule.allow.includes(change)) {
      violations.push(`${path}:${change}-not-allowed`);
      continue;
    }
    if (rule.path !== path) {
      violations.push(`${path}:rule-path-mismatch`);
      continue;
    }
    if (rule.semantics === 'whole-file') {
      if (!wholeFileShapeValid(change, oldEntry, newEntry)) {
        violations.push(`${path}:whole-file-shape-changed`);
      }
      continue;
    }
    if (rule.semantics === 'append-only') {
      if (!oldEntry && change === 'create' && newEntry?.type === 'file') {
        continue;
      }
      if (!oldEntry || !newEntry || oldEntry.type !== 'file' || newEntry.type !== 'file') {
        violations.push(`${path}:append-shape-changed`);
        continue;
      }
      if (newEntry.bytes! < oldEntry.bytes!) {
        violations.push(`${path}:append-truncated`);
        continue;
      }
      const observation = current.observations.get(path);
      if (!observation || observation.type !== 'file') {
        invalid(`append target 缺少稳定 scan observation：${path}`);
      }
      options.beforeAppendPrefixRead?.(path);
      if (readStablePrefixDigest(observation, oldEntry.bytes!) !== oldEntry.digest) {
        violations.push(`${path}:append-prefix-changed`);
      }
      continue;
    }
    if (rule.semantics === 'json-mutable-pointers') {
      if (!oldEntry || !newEntry || oldEntry.type !== 'file' || newEntry.type !== 'file') {
        violations.push(`${path}:json-shape-changed`);
      } else if (oldEntry.protectedProjectionDigest !== newEntry.protectedProjectionDigest) {
        violations.push(`${path}:protected-json-changed`);
      }
    }
  }

  return violations.length === 0
    ? semanticCandidate
      ? { accepted: true, changes, candidate: semanticCandidate }
      : { accepted: true, changes }
    : {
        accepted: false,
        changes,
        violations: [...new Set(violations)].sort(compareCanonicalStrings),
      };
}

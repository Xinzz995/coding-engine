import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseRunStateValue } from '../contracts/run-state-contract.js';
import { readModelRouting } from '../engine/models.js';
import type { Prd } from '../engine/prd.js';
import { readTddConfig, runTddGate } from '../engine/tdd-gate.js';
import { readGitHead } from '../engine/validation-protocol.js';
import { qualityChecksMatchContract, readQualityContract } from '../quality/contract.js';
import { CODING_X_VERSION } from '../version.js';
import {
  asStrictRecord,
  compareCanonicalStrings,
  parseStrictJson,
  requireDigest,
  requireExactKeys,
} from './baseline-contract.js';
import { digestBytes, jsonBytes } from './filesystem.js';
import {
  readMutationFileSnapshot,
  type MutationAdvanceHooks,
  type MutationDomain,
} from './mutation-domain.js';
import { runWorkspaceMutationControlled, type WorkspaceMutationWrite } from './mutation.js';
import { mutationInvalid } from './mutation-records.js';
import type { WorkspaceSession, WorkspaceWriteData } from './session.js';
import { WorkspaceSafetyError } from './types.js';
import { assertWindowsWorkspaceTreeHasNoReparsePoints } from './windows-path-attributes.js';

export type ApplyPrdV1Mode = 'replace-feature' | 'rederive-feature';

export interface ApplyPrdV1Candidate {
  readonly prd: WorkspaceWriteData;
  readonly state: WorkspaceWriteData | null;
  readonly progress: WorkspaceWriteData | null;
}

export interface ApplyPrdV1Request {
  readonly schemaVersion: 1;
  readonly mode: ApplyPrdV1Mode;
  readonly source: {
    readonly bytes: WorkspaceWriteData;
    readonly digest: string;
  };
  readonly git: {
    readonly expectedHead: string;
    readonly currentHead: string;
  };
  readonly quality: {
    readonly expectedDigest: string;
    readonly currentDigest: string;
  };
  readonly candidate: ApplyPrdV1Candidate & {
    readonly digest: string;
  };
}

export interface RepairV1Request {
  readonly schemaVersion: 1;
  readonly source: {
    readonly prdDigest: string;
    readonly stateDigest: string | null;
  };
  readonly candidate: {
    readonly prd: WorkspaceWriteData;
    readonly state: WorkspaceWriteData | null;
  };
}

const PRODUCT_FILE_LIMIT = 64 * 1024 * 1024;
const PRODUCT_TEXT_LIMIT = 4 * 1024 * 1024;
const SCREENSHOT_DEPTH_LIMIT = 128;
const SCREENSHOT_FILE_LIMIT = 4096;
const GIT_HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const LEGACY_REVIEW_PATTERN = /^review-.*\.md$/u;
const TAMPERED_PRD_PATTERN = /^prd\.tampered-.*\.json$/u;

export interface ProductMutationOptions {
  readonly termination?: {
    readonly signal: AbortSignal;
  };
}

export interface ApplyPrdV1Options extends ProductMutationOptions {
  readonly projectRoot: string;
}

const REVIEW_ROOTS = Object.freeze([
  'final-review.json',
  'final-review.md',
  'review-decisions.json',
]);
const COMPLETE_RUN_ROOTS = Object.freeze([
  'prd.json',
  'state.json',
  'progress.md',
  'evidence.jsonl',
  'report.html',
  'screenshots',
]);

function strictRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  try {
    const record = asStrictRecord(value, label);
    requireExactKeys(record, keys, label);
    return record;
  } catch (error) {
    throw mutationInvalid(`${label} is invalid`, error);
  }
}

function productBytes(value: unknown, label: string, maximum = PRODUCT_FILE_LIMIT): Buffer {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
    throw mutationInvalid(`${label} must be bytes or a string`);
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) {
    throw mutationInvalid(`${label} has an invalid byte length`);
  }
  return bytes;
}

function strictJsonObject(value: WorkspaceWriteData, label: string): Record<string, unknown> {
  const bytes = productBytes(value, label);
  try {
    return asStrictRecord(parseStrictJson(bytes, label), label);
  } catch (error) {
    throw mutationInvalid(`${label} must be one strict JSON object`, error);
  }
}

function strictText(value: WorkspaceWriteData, label: string): Buffer {
  const bytes = productBytes(value, label, PRODUCT_TEXT_LIMIT);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw mutationInvalid(`${label} must be strict UTF-8 text`, error);
  }
  return bytes;
}

function digest(value: unknown, label: string): string {
  try {
    return requireDigest(value, label);
  } catch (error) {
    throw mutationInvalid(`${label} must be a canonical digest`, error);
  }
}

function gitHead(value: unknown, label: string): string {
  if (typeof value !== 'string' || !GIT_HEAD_PATTERN.test(value)) {
    throw mutationInvalid(`${label} must be one full lowercase Git object id`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string, maximumBytes = 4096): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw mutationInvalid(`${label} must be one bounded non-empty string`);
  }
  return value;
}

function exactObjectKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw mutationInvalid(`${label} is missing ${key}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw mutationInvalid(`${label} contains unknown field ${key}`);
    }
  }
}

function validateApplyPrdCandidate(record: Record<string, unknown>): Prd {
  exactObjectKeys(
    record,
    [
      'project',
      'branchName',
      'description',
      'qualityContractDigest',
      'qualityChecks',
      'userStories',
    ],
    ['sourcePrd', 'tdd', 'models'],
    'apply-prd-v1 candidate.prd',
  );
  nonEmptyString(record.project, 'apply-prd-v1 candidate.prd.project');
  nonEmptyString(record.branchName, 'apply-prd-v1 candidate.prd.branchName');
  nonEmptyString(record.description, 'apply-prd-v1 candidate.prd.description', PRODUCT_TEXT_LIMIT);
  if (!Array.isArray(record.userStories)) {
    throw mutationInvalid('apply-prd-v1 candidate.prd.userStories must be an array');
  }

  const storyIds = new Set<string>();
  for (const [index, value] of record.userStories.entries()) {
    const label = `apply-prd-v1 candidate.prd.userStories[${index}]`;
    let story: Record<string, unknown>;
    try {
      story = asStrictRecord(value, label);
    } catch (error) {
      throw mutationInvalid(`${label} is invalid`, error);
    }
    exactObjectKeys(
      story,
      ['id', 'title', 'description', 'acceptanceCriteria', 'priority'],
      ['difficulty', 'difficultyReason'],
      label,
    );
    const id = nonEmptyString(story.id, `${label}.id`);
    if (storyIds.has(id)) throw mutationInvalid(`${label}.id is duplicated`);
    storyIds.add(id);
    nonEmptyString(story.title, `${label}.title`);
    nonEmptyString(story.description, `${label}.description`, PRODUCT_TEXT_LIMIT);
    if (!Array.isArray(story.acceptanceCriteria)) {
      throw mutationInvalid(`${label}.acceptanceCriteria must be an array`);
    }
    for (const [criterionIndex, criterion] of story.acceptanceCriteria.entries()) {
      nonEmptyString(criterion, `${label}.acceptanceCriteria[${criterionIndex}]`);
    }
    if (!Number.isSafeInteger(story.priority) || (story.priority as number) < 1) {
      throw mutationInvalid(`${label}.priority must be a positive integer`);
    }
  }

  const prd = record as unknown as Prd;
  const routing = readModelRouting(prd);
  if (routing.status === 'invalid') {
    throw mutationInvalid(`apply-prd-v1 candidate model routing is invalid: ${routing.errors[0]}`);
  }
  return prd;
}

function validateApplyStateCandidate(stateRecord: Record<string, unknown>, prd: Prd): void {
  const parsed = parseRunStateValue(stateRecord);
  if (!parsed.ok) {
    throw mutationInvalid(`apply-prd-v1 candidate.state is invalid: ${parsed.diagnostic}`);
  }
  const storyIds = new Set(prd.userStories.map((story) => story.id));
  const unknown = Object.keys(parsed.value).filter((storyId) => !storyIds.has(storyId));
  if (unknown.length > 0) {
    throw mutationInvalid(`apply-prd-v1 candidate.state contains unknown story ${unknown[0]}`);
  }
}

function normalizeApplyRequest(request: ApplyPrdV1Request): {
  readonly mode: ApplyPrdV1Mode;
  readonly source: {
    readonly bytes: Buffer;
    readonly digest: string;
  };
  readonly git: {
    readonly expectedHead: string;
    readonly currentHead: string;
  };
  readonly quality: {
    readonly expectedDigest: string;
    readonly currentDigest: string;
  };
  readonly candidate: {
    readonly prd: Buffer;
    readonly prdRecord: Record<string, unknown>;
    readonly state: Buffer | null;
    readonly progress: Buffer | null;
    readonly digest: string;
    readonly branchName: string;
  };
} {
  const root = strictRecord(
    request,
    ['schemaVersion', 'mode', 'source', 'git', 'quality', 'candidate'],
    'apply-prd-v1 request',
  );
  if (root.schemaVersion !== 1) {
    throw mutationInvalid('apply-prd-v1 schemaVersion is unsupported');
  }
  if (root.mode !== 'replace-feature' && root.mode !== 'rederive-feature') {
    throw mutationInvalid('apply-prd-v1 mode is unsupported');
  }
  const mode = root.mode;
  const sourceRecord = strictRecord(root.source, ['bytes', 'digest'], 'apply-prd-v1 source');
  const gitRecord = strictRecord(root.git, ['expectedHead', 'currentHead'], 'apply-prd-v1 git');
  const qualityRecord = strictRecord(
    root.quality,
    ['expectedDigest', 'currentDigest'],
    'apply-prd-v1 quality',
  );
  const candidateRecord = strictRecord(
    root.candidate,
    ['prd', 'state', 'progress', 'digest'],
    'apply-prd-v1 candidate',
  );

  const source = strictText(sourceRecord.bytes as WorkspaceWriteData, 'apply-prd-v1 source.bytes');
  const sourceDigest = digest(sourceRecord.digest, 'apply-prd-v1 source.digest');
  if (digestBytes(source) !== sourceDigest) {
    throw mutationInvalid('apply-prd-v1 source digest does not bind source bytes');
  }

  const expectedHead = gitHead(gitRecord.expectedHead, 'apply-prd-v1 git.expectedHead');
  const currentHead = gitHead(gitRecord.currentHead, 'apply-prd-v1 git.currentHead');
  if (expectedHead !== currentHead) {
    throw mutationInvalid('apply-prd-v1 Git HEAD changed after candidate derivation');
  }

  const expectedQualityDigest = digest(
    qualityRecord.expectedDigest,
    'apply-prd-v1 quality.expectedDigest',
  );
  const currentQualityDigest = digest(
    qualityRecord.currentDigest,
    'apply-prd-v1 quality.currentDigest',
  );
  if (expectedQualityDigest !== currentQualityDigest) {
    throw mutationInvalid('apply-prd-v1 quality contract changed after candidate derivation');
  }

  const prd = productBytes(candidateRecord.prd, 'apply-prd-v1 candidate.prd');
  const prdRecord = strictJsonObject(prd, 'apply-prd-v1 candidate.prd');
  const parsedPrd = validateApplyPrdCandidate(prdRecord);
  const branchName = parsedPrd.branchName;
  const prdQualityDigest = digest(
    prdRecord.qualityContractDigest,
    'apply-prd-v1 candidate.prd.qualityContractDigest',
  );
  if (prdQualityDigest !== expectedQualityDigest) {
    throw mutationInvalid('apply-prd-v1 candidate PRD binds a different quality contract');
  }

  const state =
    candidateRecord.state === null
      ? null
      : productBytes(candidateRecord.state, 'apply-prd-v1 candidate.state');
  if (state) {
    validateApplyStateCandidate(strictJsonObject(state, 'apply-prd-v1 candidate.state'), parsedPrd);
  }
  const progress =
    candidateRecord.progress === null
      ? null
      : strictText(
          candidateRecord.progress as WorkspaceWriteData,
          'apply-prd-v1 candidate.progress',
        );
  const candidateDigest = digest(candidateRecord.digest, 'apply-prd-v1 candidate.digest');
  const normalizedCandidate = { prd, state, progress };
  if (applyPrdV1CandidateDigest(mode, normalizedCandidate) !== candidateDigest) {
    throw mutationInvalid('apply-prd-v1 candidate digest does not bind all candidate bytes');
  }

  if (mode === 'replace-feature') {
    if (state !== null || progress === null) {
      throw mutationInvalid(
        'replace-feature requires a fresh progress candidate and forbids a state candidate',
      );
    }
  } else if (progress !== null) {
    throw mutationInvalid('rederive-feature must preserve progress instead of replacing it');
  }

  return {
    mode,
    source: { bytes: source, digest: sourceDigest },
    git: { expectedHead, currentHead },
    quality: {
      expectedDigest: expectedQualityDigest,
      currentDigest: currentQualityDigest,
    },
    candidate: {
      ...normalizedCandidate,
      prdRecord,
      digest: candidateDigest,
      branchName,
    },
  };
}

/** Binds every apply-prd candidate byte and the lifecycle mode with one stable digest. */
export function applyPrdV1CandidateDigest(
  mode: ApplyPrdV1Mode,
  candidate: ApplyPrdV1Candidate,
): string {
  if (mode !== 'replace-feature' && mode !== 'rederive-feature') {
    throw mutationInvalid('apply-prd-v1 candidate mode is unsupported');
  }
  const prd = productBytes(candidate.prd, 'apply-prd-v1 candidate.prd');
  const state =
    candidate.state === null ? null : productBytes(candidate.state, 'apply-prd-v1 candidate.state');
  const progress =
    candidate.progress === null
      ? null
      : productBytes(candidate.progress, 'apply-prd-v1 candidate.progress');
  return digestBytes(
    jsonBytes({
      schemaVersion: 1,
      domain: 'coding-x-apply-prd-candidate-v1',
      mode,
      prdDigest: digestBytes(prd),
      stateDigest: state === null ? null : digestBytes(state),
      progressDigest: progress === null ? null : digestBytes(progress),
    }),
  );
}

async function rootNames(session: WorkspaceSession): Promise<readonly string[]> {
  await session.lease.verify();
  return (await readdir(session.lease.workspace.path)).sort(compareCanonicalStrings);
}

function matchingNames(names: readonly string[], pattern: RegExp): readonly string[] {
  return names.filter((name) => pattern.test(name));
}

async function screenshotFiles(
  session: WorkspaceSession,
  relativeDirectory = 'screenshots',
  depth = 0,
  selected: string[] = [],
): Promise<readonly string[]> {
  if (depth > SCREENSHOT_DEPTH_LIMIT) {
    throw mutationInvalid('screenshots tree exceeds the fixed product depth');
  }
  const directory = join(session.lease.workspace.path, ...relativeDirectory.split('/'));
  let entries;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw mutationInvalid('screenshots is not an ordinary directory tree');
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return selected;
    throw error;
  }
  for (const entry of entries.sort((left, right) =>
    compareCanonicalStrings(left.name, right.name),
  )) {
    const path = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      await screenshotFiles(session, path, depth + 1, selected);
      continue;
    }
    selected.push(path);
    if (selected.length > SCREENSHOT_FILE_LIMIT) {
      throw mutationInvalid('screenshots tree exceeds the fixed product file count');
    }
  }
  return selected;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

async function currentPrdBranch(session: WorkspaceSession): Promise<string | null> {
  const snapshot = await readMutationFileSnapshot(session.lease.workspace.path, 'prd.json');
  if (snapshot.snapshot.kind === 'missing') return null;
  const record = strictJsonObject(snapshot.bytes, 'current prd.json');
  return nonEmptyString(record.branchName, 'current prd.json branchName');
}

async function assertApplyMode(
  session: WorkspaceSession,
  mode: ApplyPrdV1Mode,
  candidateBranch: string,
): Promise<void> {
  const currentBranch = await currentPrdBranch(session);
  if (mode === 'rederive-feature') {
    if (currentBranch === null || currentBranch !== candidateBranch) {
      throw mutationInvalid('rederive-feature mode does not match the current PRD branch');
    }
    return;
  }
  if (currentBranch === candidateBranch) {
    throw mutationInvalid('replace-feature mode cannot replace the same PRD branch');
  }
}

function reviewPaths(names: readonly string[]): readonly string[] {
  return [...REVIEW_ROOTS, ...matchingNames(names, LEGACY_REVIEW_PATTERN)];
}

function unique(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function throwIfInterrupted(options: ProductMutationOptions): void {
  if (options.termination?.signal.aborted) {
    throw new WorkspaceSafetyError('isolated', 'workspace mutation 已由用户中断');
  }
}

function interruptionHooks(options: ProductMutationOptions): MutationAdvanceHooks & {
  readonly beforeMutationInstalled: () => void;
  readonly afterMutationInstalled: () => void;
} {
  const boundary = () => throwIfInterrupted(options);
  return {
    beforeMutationInstalled: boundary,
    afterMutationInstalled: boundary,
    afterArchivingState: boundary,
    duringArchiveCopy: boundary,
    afterArchiveInstalled: boundary,
    afterApplyingState: boundary,
    afterBusinessStep: boundary,
    afterCommittedState: boundary,
    afterMutationStateInstalled: boundary,
  };
}

function pathInside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

async function verifyApplySource(
  projectRoot: string,
  normalized: ReturnType<typeof normalizeApplyRequest>,
): Promise<void> {
  const sourcePrd = normalized.candidate.prdRecord.sourcePrd;
  if (sourcePrd === undefined) return;
  if (
    typeof sourcePrd !== 'string' ||
    sourcePrd.trim() === '' ||
    sourcePrd.includes('\0') ||
    isAbsolute(sourcePrd)
  ) {
    throw mutationInvalid('apply-prd-v1 candidate sourcePrd must be a project-relative file');
  }
  const root = await realpath(projectRoot);
  const unresolved = resolve(root, sourcePrd);
  let info;
  let sourcePath: string;
  try {
    info = await lstat(unresolved);
    sourcePath = await realpath(unresolved);
  } catch (error) {
    throw mutationInvalid('apply-prd-v1 sourcePrd cannot be read', error);
  }
  if (info.isSymbolicLink() || !info.isFile() || !pathInside(root, sourcePath)) {
    throw mutationInvalid('apply-prd-v1 sourcePrd is not an ordinary project file');
  }
  const current = await readFile(sourcePath);
  if (
    digestBytes(current) !== normalized.source.digest ||
    !current.equals(normalized.source.bytes)
  ) {
    throw mutationInvalid('apply-prd-v1 sourcePrd changed after candidate derivation');
  }
}

async function verifyApplyLiveBindings(
  normalized: ReturnType<typeof normalizeApplyRequest>,
  options: ApplyPrdV1Options,
): Promise<string> {
  throwIfInterrupted(options);
  const projectRoot = await realpath(options.projectRoot);
  const currentHead = readGitHead(projectRoot);
  if (
    currentHead === null ||
    currentHead !== normalized.git.expectedHead ||
    currentHead !== normalized.git.currentHead
  ) {
    throw mutationInvalid('apply-prd-v1 Git HEAD no longer matches the derived candidate');
  }

  const quality = readQualityContract(projectRoot);
  if (quality.status !== 'ready') {
    throw mutationInvalid(`apply-prd-v1 quality contract is not ready: ${quality.status}`);
  }
  if (quality.contract.codingXVersion !== CODING_X_VERSION) {
    throw mutationInvalid(
      `apply-prd-v1 requires coding-x ${quality.contract.codingXVersion}, running ${CODING_X_VERSION}`,
    );
  }
  if (
    quality.digest !== normalized.quality.expectedDigest ||
    quality.digest !== normalized.quality.currentDigest
  ) {
    throw mutationInvalid('apply-prd-v1 quality contract changed after candidate derivation');
  }
  if (!qualityChecksMatchContract(normalized.candidate.prdRecord.qualityChecks, quality.contract)) {
    throw mutationInvalid('apply-prd-v1 candidate qualityChecks do not match the live contract');
  }
  await verifyApplySource(projectRoot, normalized);
  throwIfInterrupted(options);
  return projectRoot;
}

async function verifyApplyEnvironment(
  session: WorkspaceSession,
  normalized: ReturnType<typeof normalizeApplyRequest>,
  options: ApplyPrdV1Options,
): Promise<void> {
  const projectRoot = await verifyApplyLiveBindings(normalized, options);

  const tdd = readTddConfig(normalized.candidate.prdRecord as unknown as Prd);
  if (tdd.status === 'invalid') {
    throw mutationInvalid(`apply-prd-v1 candidate TDD policy is invalid: ${tdd.error}`);
  }
  if (tdd.status === 'enabled') {
    const baseline = await runTddGate(tdd.config, projectRoot, undefined, {
      session,
      kind: 'tdd-check',
      termination: options.termination
        ? {
            signal: options.termination.signal,
            reason: 'user-interrupt',
          }
        : undefined,
    });
    throwIfInterrupted(options);
    if (!baseline.ok) {
      const failure = baseline.failure;
      throw mutationInvalid(
        `apply-prd-v1 TDD baseline failed: ${failure?.command ?? 'unknown'}` +
          `${failure?.timedOut ? ' (timeout)' : ''}`,
      );
    }
  }
  // The baseline is project code. It may succeed after changing HEAD, the quality contract, or
  // the source PRD. Re-read every externally bound input after it finishes and before mutation
  // installation so a successful but mutating command cannot approve a stale candidate.
  await verifyApplyLiveBindings(normalized, options);
}

/**
 * Applies only the fixed apply-prd-v1 policy. Callers cannot add archive, write, or delete paths.
 */
export async function runApplyPrdV1Mutation(
  session: WorkspaceSession,
  request: ApplyPrdV1Request,
  options: ApplyPrdV1Options,
): Promise<MutationDomain> {
  if (session.lease.owner.command !== 'apply-prd') {
    throw mutationInvalid('apply-prd-v1 requires an apply-prd workspace session');
  }
  throwIfInterrupted(options);
  assertWindowsWorkspaceTreeHasNoReparsePoints(session.lease.workspace.path);
  const normalized = normalizeApplyRequest(request);
  await assertApplyMode(session, normalized.mode, normalized.candidate.branchName);
  await verifyApplyEnvironment(session, normalized, options);

  const names = await rootNames(session);
  const reviews = reviewPaths(names);
  const evidence = ['evidence.jsonl'];
  const validationResult = ['validation-result.json'];
  const report = ['report.html'];
  const tampered = matchingNames(names, TAMPERED_PRD_PATTERN);

  let writes: readonly WorkspaceMutationWrite[];
  let deletes: readonly string[];
  let archivePaths: readonly string[];
  if (normalized.mode === 'replace-feature') {
    const screenshots = await screenshotFiles(session);
    writes = [
      { path: 'prd.json', data: normalized.candidate.prd },
      { path: 'progress.md', data: normalized.candidate.progress! },
    ];
    deletes = unique([
      'state.json',
      ...reviews,
      ...evidence,
      ...validationResult,
      ...report,
      ...tampered,
      ...screenshots,
    ]);
    archivePaths = unique([...COMPLETE_RUN_ROOTS, ...reviews, ...tampered]);
  } else {
    const currentState = await readMutationFileSnapshot(session.lease.workspace.path, 'state.json');
    if ((currentState.snapshot.kind === 'file') !== (normalized.candidate.state !== null)) {
      throw mutationInvalid(
        'rederive-feature state candidate must exactly match current state presence',
      );
    }
    writes = [
      { path: 'prd.json', data: normalized.candidate.prd },
      ...(normalized.candidate.state === null
        ? []
        : [{ path: 'state.json', data: normalized.candidate.state }]),
    ];
    deletes = unique([...reviews, ...evidence, ...validationResult, ...report]);
    archivePaths = unique(['prd.json', 'state.json', ...reviews, ...evidence]);
  }

  const hooks = interruptionHooks(options);
  return await runWorkspaceMutationControlled(session, {
    kind: 'apply-prd-v1',
    writes,
    deletes,
    archivePaths,
    hooks: {
      ...hooks,
      // Planning reads workspace state and can take arbitrarily long. Revalidate every external
      // candidate binding at the mutation install boundary so none can change during that window
      // and still authorize the already-built plan.
      beforeMutationInstalled: async () => {
        hooks.beforeMutationInstalled();
        await verifyApplyLiveBindings(normalized, options);
      },
    },
  });
}

function normalizeRepairRequest(request: RepairV1Request): {
  readonly prdDigest: string;
  readonly stateDigest: string | null;
  readonly prd: Buffer;
  readonly state: Buffer | null;
} {
  const root = strictRecord(request, ['schemaVersion', 'source', 'candidate'], 'repair-v1 request');
  if (root.schemaVersion !== 1) throw mutationInvalid('repair-v1 schemaVersion is unsupported');
  const source = strictRecord(root.source, ['prdDigest', 'stateDigest'], 'repair-v1 source');
  const candidate = strictRecord(root.candidate, ['prd', 'state'], 'repair-v1 candidate');
  const prd = productBytes(candidate.prd, 'repair-v1 candidate.prd');
  strictJsonObject(prd, 'repair-v1 candidate.prd');
  const state =
    candidate.state === null ? null : productBytes(candidate.state, 'repair-v1 candidate.state');
  if (state) strictJsonObject(state, 'repair-v1 candidate.state');
  return {
    prdDigest: digest(source.prdDigest, 'repair-v1 source.prdDigest'),
    stateDigest:
      source.stateDigest === null
        ? null
        : digest(source.stateDigest, 'repair-v1 source.stateDigest'),
    prd,
    state,
  };
}

/** Repairs only prd.json and the already-present state.json, archiving both original sources. */
export async function runRepairV1Mutation(
  session: WorkspaceSession,
  request: RepairV1Request,
  options: ProductMutationOptions = {},
): Promise<MutationDomain> {
  if (session.lease.owner.command !== 'repair') {
    throw mutationInvalid('repair-v1 requires a repair workspace session');
  }
  throwIfInterrupted(options);
  const normalized = normalizeRepairRequest(request);
  const currentPrd = await readMutationFileSnapshot(session.lease.workspace.path, 'prd.json');
  if (currentPrd.snapshot.kind !== 'file' || currentPrd.snapshot.digest !== normalized.prdDigest) {
    throw mutationInvalid('repair-v1 source prd digest does not bind current prd.json');
  }
  const currentState = await readMutationFileSnapshot(session.lease.workspace.path, 'state.json');
  if (currentState.snapshot.kind === 'missing') {
    if (normalized.stateDigest !== null || normalized.state !== null) {
      throw mutationInvalid('repair-v1 state binding must remain absent');
    }
  } else if (normalized.stateDigest !== currentState.snapshot.digest || normalized.state === null) {
    throw mutationInvalid('repair-v1 source state digest does not bind current state.json');
  }

  const writes: WorkspaceMutationWrite[] = [{ path: 'prd.json', data: normalized.prd }];
  if (normalized.state !== null) {
    writes.push({ path: 'state.json', data: normalized.state });
  }
  await session.lease.verify();
  return await runWorkspaceMutationControlled(session, {
    kind: 'repair-v1',
    writes,
    deletes: [],
    archivePaths: ['prd.json', 'state.json'],
    hooks: interruptionHooks(options),
  });
}

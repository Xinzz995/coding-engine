import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseRunStateBytes, type RunState } from '../contracts/run-state-contract.js';
import type { ManagedGateContext } from '../engine/gate.js';
import type { Prd } from '../engine/prd.js';
import {
  evaluateStoryValidationCurrentness,
  unverifiableStoryValidationCurrentness,
  type StoryValidationCurrentnessInput,
  type StoryValidationRuntimeIdentity,
  type ReadyStoryValidationCurrentness,
  type UnverifiableStoryValidationCurrentness,
} from '../engine/story-validation-currentness.js';
import { readTddConfig, type TddConfigReadResult } from '../engine/tdd-gate.js';
import { readGitHead } from '../engine/validation-protocol.js';
import {
  parseQualityContract,
  QUALITY_CONTRACT_RELATIVE_PATH,
  type QualityContractReadResult,
  type QualityPlatform,
} from '../quality/contract.js';
import { readTrackedQualityContractAtHead } from '../quality/tracked-contract.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import {
  readStableFile,
  STABLE_FILE_DEFAULT_MAX_BYTES,
  type StableFileReadHooks,
} from '../workspace-safety/stable-file.js';

export type StoryValidationFileSnapshot<T> =
  | { status: 'ready'; value: T; fingerprint: string }
  | { status: 'missing'; fingerprint: 'missing' }
  | { status: 'invalid'; fingerprint: string; diagnostic: string };

export interface StoryValidationObservationOptions {
  projectRoot: string;
  /** 被观察的业务 workspace；默认等于提供受管进程权限的 session workspace。 */
  workspace?: string;
  session: WorkspaceSession;
  termination?: ManagedGateContext['termination'];
  platform?: QualityPlatform;
  /** 签发/复核 Story 凭证的实际引擎版本与正式/候选模式。 */
  runtimeIdentity: StoryValidationRuntimeIdentity;
  /** @internal Loop 测试夹具兼容；正式运行必须省略，由观察器分别读取工作树与 HEAD。 */
  qualityContractReader?: (projectRoot: string) => QualityContractReadResult;
  /** @internal Loop 机械环境摘要夹具兼容；实际版本与模式仍会在其后强制绑定。 */
  validationEnvironmentDigestForTests?: string;
}

export interface StoryValidationObservationReaders {
  readHead: (projectRoot: string) => string | null;
  readPrd: (path: string) => StoryValidationFileSnapshot<Prd>;
  readState: (path: string) => StoryValidationFileSnapshot<RunState>;
  readWorkingContract: (projectRoot: string) => QualityContractReadResult;
  readTrackedContract: (options: {
    projectRoot: string;
    head: string;
    session: WorkspaceSession;
    termination?: ManagedGateContext['termination'];
  }) => Promise<QualityContractReadResult>;
  readTdd: (prd: Prd | null) => TddConfigReadResult;
}

export type StoryValidationObservation =
  | (ReadyStoryValidationCurrentness & { workspacePath: string; observationToken: string })
  | (UnverifiableStoryValidationCurrentness & {
      workspacePath: string;
      observationToken: null;
    });

interface ObservationSnapshot {
  headSha: string | null;
  prd: StoryValidationFileSnapshot<Prd>;
  state: StoryValidationFileSnapshot<RunState>;
  workingContract: QualityContractReadResult;
  trackedContract: QualityContractReadResult;
  tddRead: TddConfigReadResult;
}

export const STORY_VALIDATION_AUTHORITY_MAX_BYTES = STABLE_FILE_DEFAULT_MAX_BYTES;

/** @internal Deterministic replacement seam; production callers must omit hooks. */
export interface StoryValidationAuthorityReadHooks {
  afterOpen?: () => void;
}

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function readStoryValidationAuthorityBytes(
  path: string,
  hooks: StoryValidationAuthorityReadHooks = {},
): ReturnType<typeof readStableFile> {
  return readStableFile(path, {
    label: 'Story 验收权威输入',
    maxBytes: STORY_VALIDATION_AUTHORITY_MAX_BYTES,
    hooks: hooks satisfies StableFileReadHooks,
  });
}

/**
 * Story 验收不能用普通 readFileSync 读取工作树契约：符号链接、FIFO、超大文件或
 * 读取期间替换都会让这份裁判输入不可验证，而不是继续等待或拼出撕裂快照。
 */
export function readWorkingQualityContractAuthority(
  projectRoot: string,
): QualityContractReadResult {
  const path = join(projectRoot, QUALITY_CONTRACT_RELATIVE_PATH);
  const file = readStoryValidationAuthorityBytes(path);
  if (file.status === 'missing') return { status: 'missing', path };
  if (file.status === 'invalid') {
    return { status: 'io-error', path, error: file.diagnostic };
  }

  let value: unknown;
  try {
    value = JSON.parse(file.bytes.toString('utf8'));
  } catch (error) {
    return {
      status: 'invalid-json',
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = parseQualityContract(value);
  return { ...parsed, path };
}

function readPrdFile(path: string): StoryValidationFileSnapshot<Prd> {
  const file = readStoryValidationAuthorityBytes(path);
  if (file.status !== 'ready') return file;
  try {
    return {
      status: 'ready',
      value: JSON.parse(file.bytes.toString('utf8')) as Prd,
      fingerprint: file.fingerprint,
    };
  } catch (error) {
    return {
      status: 'invalid',
      fingerprint: file.fingerprint,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

function readStateFile(path: string): StoryValidationFileSnapshot<RunState> {
  const file = readStoryValidationAuthorityBytes(path);
  if (file.status !== 'ready') return file;
  const parsed = parseRunStateBytes(file.bytes);
  return parsed.ok
    ? { status: 'ready', value: parsed.value, fingerprint: file.fingerprint }
    : {
        status: 'invalid',
        fingerprint: file.fingerprint,
        diagnostic: parsed.diagnostic,
      };
}

function platformOf(value: NodeJS.Platform): QualityPlatform | null {
  if (value === 'linux') return 'linux';
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  return null;
}

function unavailableTrackedContract(head: string | null): QualityContractReadResult {
  return {
    status: 'io-error',
    path: '.coding-x/quality.json',
    error: head === null ? '当前 Git HEAD 不可读取' : `当前 Git HEAD 非法：${head}`,
  };
}

function contractFingerprint(result: QualityContractReadResult): string {
  switch (result.status) {
    case 'ready':
      return `ready:${result.digest}`;
    case 'missing':
      return 'missing';
    case 'invalid':
      return `invalid:${sha256(JSON.stringify(result.errors))}`;
    case 'invalid-json':
      return `invalid-json:${sha256(result.error)}`;
    case 'io-error':
      return `io-error:${sha256(result.error)}`;
  }
}

function tddFingerprint(result: TddConfigReadResult): string {
  return sha256(JSON.stringify(result));
}

function snapshotIdentity(snapshot: ObservationSnapshot): Record<string, string | null> {
  return {
    head: snapshot.headSha,
    prd: `${snapshot.prd.status}:${snapshot.prd.fingerprint}`,
    state: `${snapshot.state.status}:${snapshot.state.fingerprint}`,
    workingContract: contractFingerprint(snapshot.workingContract),
    trackedContract: contractFingerprint(snapshot.trackedContract),
    tdd: tddFingerprint(snapshot.tddRead),
  };
}

function changedSnapshotSources(before: ObservationSnapshot, after: ObservationSnapshot): string[] {
  const first = snapshotIdentity(before);
  const second = snapshotIdentity(after);
  return Object.keys(first).filter((key) => first[key] !== second[key]);
}

function currentnessInput(
  snapshot: ObservationSnapshot,
  platform: QualityPlatform,
  runtimeIdentity: StoryValidationRuntimeIdentity,
  validationEnvironmentDigestForTests?: string,
): StoryValidationCurrentnessInput {
  return {
    prd: snapshot.prd.status === 'ready' ? snapshot.prd.value : null,
    state: snapshot.state.status === 'ready' ? snapshot.state.value : {},
    stateStatus: snapshot.state.status,
    headSha: snapshot.headSha,
    workingContract: snapshot.workingContract,
    trackedContract: snapshot.trackedContract,
    platform,
    runtimeIdentity,
    tddRead: snapshot.tddRead,
    ...(validationEnvironmentDigestForTests !== undefined
      ? { storyValidationEnvironmentDigestForTests: validationEnvironmentDigestForTests }
      : {}),
  };
}

async function collectSnapshot(
  options: StoryValidationObservationOptions,
  readers: StoryValidationObservationReaders,
): Promise<ObservationSnapshot> {
  const workspace = options.workspace ?? options.session.writer.workspacePath;
  const headSha = readers.readHead(options.projectRoot);
  const prd = readers.readPrd(join(workspace, 'prd.json'));
  const state = readers.readState(join(workspace, 'state.json'));
  const workingContract = readers.readWorkingContract(options.projectRoot);
  const trackedContract = headSha
    ? await readers.readTrackedContract({
        projectRoot: options.projectRoot,
        head: headSha,
        session: options.session,
        ...(options.termination ? { termination: options.termination } : {}),
      })
    : unavailableTrackedContract(headSha);
  const tddRead = readers.readTdd(prd.status === 'ready' ? prd.value : null);
  return { headSha, prd, state, workingContract, trackedContract, tddRead };
}

function defaultReaders(
  options: StoryValidationObservationOptions,
): StoryValidationObservationReaders {
  const injected = options.qualityContractReader;
  return {
    readHead: readGitHead,
    readPrd: readPrdFile,
    readState: readStateFile,
    readWorkingContract: injected ?? readWorkingQualityContractAuthority,
    readTrackedContract: injected
      ? ({ projectRoot }) => Promise.resolve(injected(projectRoot))
      : readTrackedQualityContractAtHead,
    readTdd: readTddConfig,
  };
}

/**
 * 受管双快照观察。每次调用都重新读取全部权威输入；任一输入在前后窗口变化都返回
 * unverifiable，不能把一半旧、一半新的状态拼成绿色结论。
 */
export async function observeStoryValidationCurrentnessControlled(
  options: StoryValidationObservationOptions,
  readers: StoryValidationObservationReaders,
): Promise<StoryValidationObservation> {
  const workspacePath = options.workspace ?? options.session.writer.workspacePath;
  const platform = options.platform ?? platformOf(process.platform);
  const before = await collectSnapshot(options, readers);
  const after = await collectSnapshot(options, readers);
  const fallbackPlatform: QualityPlatform = platform ?? 'linux';
  const input = currentnessInput(
    after,
    fallbackPlatform,
    options.runtimeIdentity,
    options.validationEnvironmentDigestForTests,
  );
  if (platform === null) {
    return {
      ...unverifiableStoryValidationCurrentness(
        input,
        'evaluation-error',
        `当前系统 ${process.platform} 不支持本地干净检出验证`,
      ),
      workspacePath,
      observationToken: null,
    };
  }
  const changed = changedSnapshotSources(before, after);
  if (changed.length > 0) {
    return {
      ...unverifiableStoryValidationCurrentness(
        input,
        'observation-drift',
        `Story 验收观察期间输入发生变化：${changed.join('、')}`,
      ),
      workspacePath,
      observationToken: null,
    };
  }
  const evaluated = evaluateStoryValidationCurrentness(input);
  if (evaluated.status === 'unverifiable') {
    return { ...evaluated, workspacePath, observationToken: null };
  }
  const observationToken = sha256(
    JSON.stringify({
      workspacePath,
      ...snapshotIdentity(after),
      storyValidationEnvironmentDigest: evaluated.storyValidationEnvironmentDigest,
      storyValidationDigest: evaluated.storyValidationDigest,
    }),
  );
  return { ...evaluated, workspacePath, observationToken };
}

export function observeStoryValidationCurrentness(
  options: StoryValidationObservationOptions,
): Promise<StoryValidationObservation> {
  return observeStoryValidationCurrentnessControlled(options, defaultReaders(options));
}

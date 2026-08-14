import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ManagedGateContext } from '../engine/gate.js';
import { isGitHead } from '../contracts/validation-contract.js';
import { GIT_NULL_CONFIG_PATH } from '../engine/git-environment.js';
import {
  createValidationProcessEnvironment,
  resolveValidationGitExecutable,
} from '../engine/clean-validation-checkout.js';
import { environmentEntries, runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import {
  parseQualityContract,
  QUALITY_CONTRACT_RELATIVE_PATH,
  type QualityContractReadResult,
} from './contract.js';

const MAX_TRACKED_QUALITY_CONTRACT_BYTES = 1024 * 1024;
const STORY_VALIDATION_GIT_AUTHORITY_HEADER = 'CODING_X_DEFAULT_BRANCH=';

export type DefaultBranchGitHeadRead =
  { status: 'ready'; gitHead: string } | { status: 'unavailable'; message: string };

export interface StoryValidationGitAuthorityRead {
  readonly defaultBranchGitHead: string | null;
  readonly trackedContract: QualityContractReadResult;
}

function parseTrackedQualityContractBytes(bytes: Buffer): QualityContractReadResult {
  if (bytes.byteLength > MAX_TRACKED_QUALITY_CONTRACT_BYTES) {
    return {
      status: 'io-error',
      path: QUALITY_CONTRACT_RELATIVE_PATH,
      error: `当前 HEAD 的质量契约超过 ${MAX_TRACKED_QUALITY_CONTRACT_BYTES} 字节`,
    };
  }
  let value: unknown;
  const sourceFingerprint = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return {
      status: 'invalid-json',
      path: QUALITY_CONTRACT_RELATIVE_PATH,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = parseQualityContract(value);
  return { ...parsed, path: QUALITY_CONTRACT_RELATIVE_PATH, sourceFingerprint };
}

/** @internal Parse the one-process Git authority envelope without trusting contract bytes as framing. */
export function parseStoryValidationGitAuthorityOutput(
  output: Buffer,
): StoryValidationGitAuthorityRead {
  const lineEnd = output.indexOf(0x0a);
  const header =
    lineEnd < 0 ? '' : output.subarray(0, lineEnd).toString('ascii').replace(/\r$/u, '');
  const gitHead = header.startsWith(STORY_VALIDATION_GIT_AUTHORITY_HEADER)
    ? header.slice(STORY_VALIDATION_GIT_AUTHORITY_HEADER.length).toLowerCase()
    : '';
  if (!isGitHead(gitHead)) {
    return {
      defaultBranchGitHead: null,
      trackedContract: {
        status: 'io-error',
        path: QUALITY_CONTRACT_RELATIVE_PATH,
        error: 'Git 未返回可验证的默认分支提交与当前 HEAD 质量契约',
      },
    };
  }
  return {
    defaultBranchGitHead: gitHead,
    trackedContract: parseTrackedQualityContractBytes(output.subarray(lineEnd + 1)),
  };
}

/**
 * Story 当前性会在同一快照中同时需要默认分支提交与候选 HEAD 契约。用一个受管 Git
 * 进程读取两者，避免每次双快照为两个只读事实各启动一次完整监督域。
 */
export async function readStoryValidationGitAuthority(options: {
  projectRoot: string;
  head: string;
  defaultBranch: string;
  session: WorkspaceSession;
  termination?: ManagedGateContext['termination'];
}): Promise<StoryValidationGitAuthorityRead> {
  const unavailable = (message: string): StoryValidationGitAuthorityRead => ({
    defaultBranchGitHead: null,
    trackedContract: {
      status: 'io-error',
      path: QUALITY_CONTRACT_RELATIVE_PATH,
      error: message,
    },
  });
  const environment = createValidationProcessEnvironment(options.projectRoot, options.projectRoot);
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_TERMINAL_PROMPT: '0',
  });
  let git: string;
  try {
    git = resolveValidationGitExecutable(options.projectRoot, options.projectRoot, environment);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  const defaultBranchRef = `refs/remotes/origin/${options.defaultBranch}^{commit}`;
  const result = await runManagedWorkspaceProcess(options.session, {
    kind: 'quality-check',
    delegation: 'read-only-v1',
    executable: git,
    args: [
      '--no-replace-objects',
      '--no-pager',
      'show',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      `--format=tformat:${STORY_VALIDATION_GIT_AUTHORITY_HEADER}%H`,
      '--no-patch',
      '--end-of-options',
      defaultBranchRef,
      `${options.head}:${QUALITY_CONTRACT_RELATIVE_PATH}`,
    ],
    cwd: realpathSync.native(options.projectRoot),
    environment: environmentEntries(environment),
    timeoutMs: 60_000,
    ...(options.termination ? { termination: options.termination } : {}),
  });
  if (
    result.verdict !== 'completed' ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.processTreeNotEmpty
  ) {
    return unavailable(
      Buffer.concat([result.stdout, result.stderr]).toString('utf8').slice(-2000).trim() ||
        `无法同时读取 origin/${options.defaultBranch} 与当前 HEAD 质量契约`,
    );
  }
  return parseStoryValidationGitAuthorityOutput(result.stdout);
}

/** 受管读取质量契约默认分支的本地 origin 跟踪提交，不联网、不猜测替代基线。 */
export async function readDefaultBranchGitHead(options: {
  projectRoot: string;
  defaultBranch: string;
  session: WorkspaceSession;
  termination?: ManagedGateContext['termination'];
}): Promise<DefaultBranchGitHeadRead> {
  const environment = createValidationProcessEnvironment(options.projectRoot, options.projectRoot);
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_TERMINAL_PROMPT: '0',
  });
  let git: string;
  try {
    git = resolveValidationGitExecutable(options.projectRoot, options.projectRoot, environment);
  } catch (error) {
    return {
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const ref = `refs/remotes/origin/${options.defaultBranch}^{commit}`;
  const result = await runManagedWorkspaceProcess(options.session, {
    kind: 'quality-check',
    delegation: 'read-only-v1',
    executable: git,
    args: ['--no-replace-objects', 'rev-parse', '--verify', '--end-of-options', ref],
    cwd: realpathSync.native(options.projectRoot),
    environment: environmentEntries(environment),
    timeoutMs: 60_000,
    ...(options.termination ? { termination: options.termination } : {}),
  });
  const output = result.stdout.toString('utf8').trim().toLowerCase();
  if (
    result.verdict !== 'completed' ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.processTreeNotEmpty ||
    !isGitHead(output)
  ) {
    const detail = Buffer.concat([result.stdout, result.stderr])
      .toString('utf8')
      .slice(-2000)
      .trim();
    return {
      status: 'unavailable',
      message: detail || `无法读取 origin/${options.defaultBranch}；请先获取默认分支远端引用后重试`,
    };
  }
  return { status: 'ready', gitHead: output };
}

/**
 * 通过受管 Git 子进程读取精确 HEAD 上的质量契约。
 *
 * 调用方不得用工作树契约代替这个结果：工作树文件可以尚未提交，而 Story 验收凭证只
 * 能绑定已提交候选。`--no-replace-objects` 同时阻止本地 replace refs 改写对象身份。
 */
export async function readTrackedQualityContractAtHead(options: {
  projectRoot: string;
  head: string;
  session: WorkspaceSession;
  termination?: ManagedGateContext['termination'];
}): Promise<QualityContractReadResult> {
  const environment = createValidationProcessEnvironment(options.projectRoot, options.projectRoot);
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_TERMINAL_PROMPT: '0',
  });
  let git: string;
  try {
    git = resolveValidationGitExecutable(options.projectRoot, options.projectRoot, environment);
  } catch (error) {
    return {
      status: 'io-error',
      path: QUALITY_CONTRACT_RELATIVE_PATH,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const result = await runManagedWorkspaceProcess(options.session, {
    kind: 'quality-check',
    delegation: 'read-only-v1',
    executable: git,
    args: [
      '--no-replace-objects',
      'cat-file',
      'blob',
      `${options.head}:${QUALITY_CONTRACT_RELATIVE_PATH}`,
    ],
    cwd: realpathSync.native(options.projectRoot),
    environment: environmentEntries(environment),
    timeoutMs: 60_000,
    ...(options.termination ? { termination: options.termination } : {}),
  });
  if (
    result.verdict !== 'completed' ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.processTreeNotEmpty
  ) {
    return {
      status: 'io-error',
      path: QUALITY_CONTRACT_RELATIVE_PATH,
      error:
        Buffer.concat([result.stdout, result.stderr]).toString('utf8').slice(-2000).trim() ||
        '无法从当前 HEAD 读取质量契约',
    };
  }
  return parseTrackedQualityContractBytes(result.stdout);
}

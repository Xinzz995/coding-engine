import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ManagedGateContext } from '../engine/gate.js';
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
  if (result.stdout.byteLength > MAX_TRACKED_QUALITY_CONTRACT_BYTES) {
    return {
      status: 'io-error',
      path: QUALITY_CONTRACT_RELATIVE_PATH,
      error: `当前 HEAD 的质量契约超过 ${MAX_TRACKED_QUALITY_CONTRACT_BYTES} 字节`,
    };
  }
  let value: unknown;
  const sourceFingerprint = `sha256:${createHash('sha256').update(result.stdout).digest('hex')}`;
  try {
    value = JSON.parse(result.stdout.toString('utf8'));
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

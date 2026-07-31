import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptanceHash,
  parseValidationResultBytes,
  VALIDATION_PROTOCOL_VERSION,
  VALIDATION_RESULT_MAX_BYTES,
  type ValidationProtocolOutcome,
  type ValidationRequest,
} from '../contracts/validation-contract.js';
import type { Story } from './prd.js';

export const VALIDATION_RESULT_FILE = 'validation-result.json';
export {
  acceptanceHash,
  VALIDATION_PROTOCOL_VERSION,
  VALIDATION_RESULT_MAX_BYTES,
  VALIDATION_TEXT_MAX_CHARS,
} from '../contracts/validation-contract.js';
export type {
  ValidationCheck,
  ValidationProtocolErrorCode,
  ValidationProtocolOutcome,
  ValidationRequest,
  ValidationResult,
} from '../contracts/validation-contract.js';

/**
 * 读取当前提交身份。无法读取时返回 null，由协议显式标记降级；绝不把错误文案
 * 或空字符串伪装成 artifact identity。
 */
export function readGitHead(cwd: string): string | null {
  try {
    const value = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .trim()
      .toLowerCase();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function createValidationRequest(
  story: Pick<Story, 'id' | 'acceptanceCriteria'>,
  workspace: string,
  gitHead: string | null,
  requestId: string = randomUUID(),
): ValidationRequest {
  const criteria = [...story.acceptanceCriteria];
  return {
    version: VALIDATION_PROTOCOL_VERSION,
    requestId,
    storyId: story.id,
    acceptanceHash: acceptanceHash(story.id, criteria),
    acceptanceCriteria: criteria,
    gitHead,
    resultPath: join(workspace, VALIDATION_RESULT_FILE),
  };
}

/**
 * 协议块由引擎追加，custom instruction 无占位符也不能静默降级。它只约束控制面；
 * agent 是否遵守由结果文件、目标绑定与 state 不变式机械判定。
 */
export function renderValidatorInstruction(base: string, request: ValidationRequest): string {
  return `${base.trimEnd()}

<!-- ENGINE-BOUND VALIDATION REQUEST: do not infer another target -->
## 引擎绑定的验收请求（最高优先级运行时合同）

- 只验证下面 JSON 指定的 story、AC 快照与 Git HEAD；不得从 progress.md 猜测目标。
- 不得修改 state.json、prd.json 或项目源码。你只提交 Validator claim，最终状态由引擎写入。
- 按 request.acceptanceCriteria 的顺序逐条验证；结果 checks 必须以 1..N 精确覆盖全部 AC。
- 将单个 JSON 对象原子写入 request.resultPath；schema 必须匹配项目 validator 指令。
- 即使验收失败也正常写入 verdict=failed 的结果；不要用进程退出码代替结构化结论。

\`\`\`json
${JSON.stringify(request, null, 2)}
\`\`\`
`;
}

/** 每轮前只清理引擎固定的临时 result 路径；ENOENT 是合法空态。 */
export function clearValidationResult(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * 读取、严格解析并与本轮 request/调用后 Git HEAD 对账。所有不确定性都返回
 * 显式错误码，调用方必须 fail closed；result 自身仍只是 source=validator 的 claim。
 */
export function readValidationResult(
  path: string,
  expected: ValidationRequest,
  actualGitHead: string | null,
): ValidationProtocolOutcome {
  let raw: Buffer;
  let descriptor: number | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      return { ok: false, code: 'unreadable-result', diagnostic: 'validation result 不是普通文件' };
    }
    if (stat.size > VALIDATION_RESULT_MAX_BYTES) {
      return {
        ok: false,
        code: 'result-too-large',
        diagnostic: `validation result 超过 ${VALIDATION_RESULT_MAX_BYTES} bytes`,
      };
    }
    // 始终从完成 fstat 的同一文件描述符读取，路径随后被替换也不会改读其他文件。
    raw = readFileSync(descriptor);
    if (raw.byteLength > VALIDATION_RESULT_MAX_BYTES) {
      return {
        ok: false,
        code: 'result-too-large',
        diagnostic: `validation result 超过 ${VALIDATION_RESULT_MAX_BYTES} bytes`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, code: 'missing-result', diagnostic: 'Validator 未写 validation result' };
    }
    return {
      ok: false,
      code: 'unreadable-result',
      diagnostic: `validation result 不可读：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }

  const shaped = parseValidationResultBytes(raw, {
    requestId: expected.requestId,
    storyId: expected.storyId,
    acceptanceHash: expected.acceptanceHash,
    checkCount: expected.acceptanceCriteria.length,
    gitHead: expected.gitHead,
  });
  if (!shaped.ok) return shaped;
  if (actualGitHead !== expected.gitHead) {
    return {
      ok: false,
      code: 'artifact-changed',
      diagnostic: 'Validator 执行期间 Git HEAD 发生变化，结果不再绑定调用前产物',
    };
  }
  return shaped;
}

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  acceptanceHash,
  parseValidationResultBytes,
  VALIDATION_PROTOCOL_VERSION,
  VALIDATION_RESULT_FILE,
  VALIDATION_RESULT_MAX_BYTES,
  type EngineQualityGateEvidence,
  type ValidationProtocolOutcome,
  type ValidationRequest,
} from '../contracts/validation-contract.js';
import type { Story } from './prd.js';
import type { WorkspaceWriter } from '../workspace-safety/session.js';

export {
  acceptanceHash,
  VALIDATION_PROTOCOL_VERSION,
  VALIDATION_RESULT_FILE,
  VALIDATION_RESULT_MAX_BYTES,
  VALIDATION_TEXT_MAX_CHARS,
} from '../contracts/validation-contract.js';
export type {
  EngineQualityGateCheckEvidence,
  EngineQualityGateEvidence,
  ValidationCheck,
  ValidationProtocolErrorCode,
  ValidationProtocolOutcome,
  ValidationRequest,
  ValidationResult,
} from '../contracts/validation-contract.js';

export interface ValidationArtifactTarget {
  readonly gitHead: string | null;
  readonly storyBaseGitHead: string | null;
  readonly changeManifestDigest: string;
  readonly changedPathCount: number;
}

/**
 * 读取当前提交身份。无法读取时返回 null，由协议显式标记降级；绝不把错误文案
 * 或空字符串伪装成 artifact identity。
 */
export function readGitHead(cwd: string): string | null {
  const objectId = (value: string): string | null => {
    const normalized = value.trim().toLowerCase();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(normalized) ? normalized : null;
  };
  const readBounded = (path: string, maximumBytes: number): string | null => {
    let descriptor: number | null = null;
    try {
      const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
      descriptor = openSync(path, constants.O_RDONLY | noFollow);
      const opened = fstatSync(descriptor);
      const linkedPath = lstatSync(path);
      if (
        !opened.isFile() ||
        !linkedPath.isFile() ||
        linkedPath.isSymbolicLink() ||
        linkedPath.dev !== opened.dev ||
        linkedPath.ino !== opened.ino ||
        opened.size > maximumBytes
      ) {
        return null;
      }
      const bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      const hasTrailingByte = readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, null) !== 0;
      const after = fstatSync(descriptor);
      if (
        offset !== opened.size ||
        hasTrailingByte ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      ) {
        return null;
      }
      return bytes.toString('utf8');
    } catch {
      return null;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  };
  const locateGitDirectory = (): string | null => {
    let current = resolve(cwd);
    for (;;) {
      const marker = join(current, '.git');
      const text = readBounded(marker, 4096);
      if (text !== null) {
        const match = text.match(/^gitdir:\s*(.+?)\s*$/u);
        if (!match) return null;
        return isAbsolute(match[1]) ? resolve(match[1]) : resolve(current, match[1]);
      }
      try {
        const info = statSync(marker);
        if (info.isDirectory()) return marker;
      } catch {
        // Continue towards the filesystem root.
      }
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };
  const gitDirectory = locateGitDirectory();
  if (!gitDirectory) return null;
  const commonDirectoryText = readBounded(join(gitDirectory, 'commondir'), 4096);
  const commonDirectory = commonDirectoryText
    ? resolve(gitDirectory, commonDirectoryText.trim())
    : gitDirectory;
  const packedRefs = (): Map<string, string> => {
    const values = new Map<string, string>();
    const text = readBounded(join(commonDirectory, 'packed-refs'), 16 * 1024 * 1024);
    if (!text) return values;
    for (const line of text.split(/\r?\n/u)) {
      if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
      const separator = line.indexOf(' ');
      if (separator <= 0) continue;
      const id = objectId(line.slice(0, separator));
      const ref = line.slice(separator + 1).trim();
      if (id && ref.startsWith('refs/')) values.set(ref, id);
    }
    return values;
  };
  const packed = packedRefs();
  let value = readBounded(join(gitDirectory, 'HEAD'), 4096);
  for (let depth = 0; value !== null && depth < 8; depth += 1) {
    const id = objectId(value);
    if (id) return id;
    const match = value.trim().match(/^ref:\s*(refs\/[^\0\r\n]+)$/u);
    if (!match) return null;
    const ref = match[1];
    const parts = ref.split('/');
    if (
      parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))
    ) {
      return null;
    }
    value =
      readBounded(join(gitDirectory, ...parts), 4096) ??
      readBounded(join(commonDirectory, ...parts), 4096);
    if (value === null) return packed.get(ref) ?? null;
  }
  return null;
}

export function createValidationRequest(
  story: Pick<Story, 'id' | 'acceptanceCriteria'>,
  workspace: string,
  target: ValidationArtifactTarget,
  requestId: string = randomUUID(),
  /** 宿主隔离 profile 提供的临时域固定 claim 路径；缺省保持 workspace 内旧位置。 */
  resultPathOverride?: string,
  engineQualityGate?: EngineQualityGateEvidence,
): ValidationRequest {
  const criteria = [...story.acceptanceCriteria];
  if (engineQualityGate !== undefined) {
    if (
      target.gitHead === null ||
      engineQualityGate.gitHead !== target.gitHead ||
      engineQualityGate.status !== 'passed' ||
      engineQualityGate.ran !== engineQualityGate.total ||
      engineQualityGate.checks.length !== engineQualityGate.total
    ) {
      throw new Error('Validator 机械检查证明未绑定当前完整通过的目标');
    }
  }
  return {
    version: VALIDATION_PROTOCOL_VERSION,
    requestId,
    storyId: story.id,
    acceptanceHash: acceptanceHash(story.id, criteria),
    acceptanceCriteria: criteria,
    gitHead: target.gitHead,
    storyBaseGitHead: target.storyBaseGitHead,
    changeManifestDigest: target.changeManifestDigest,
    changedPathCount: target.changedPathCount,
    ...(engineQualityGate
      ? {
          engineQualityGate: {
            ...engineQualityGate,
            checks: engineQualityGate.checks.map((check) => ({ ...check })),
            skippedCheckIds: [...engineQualityGate.skippedCheckIds],
          },
        }
      : {}),
    resultPath: resultPathOverride ?? join(workspace, VALIDATION_RESULT_FILE),
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

- 只验证下面 JSON 指定的 story、AC 快照、固定 Story 起点、变化摘要与 Git HEAD；不得从 progress.md 猜测目标。
- 必须检查 request.storyBaseGitHead..request.gitHead 的完整变化；不得用 HEAD^、当前父提交或自行选择的基线缩窄范围。
- 不得修改 state.json、prd.json 或项目源码。你只提交 Validator claim，最终状态由引擎写入。
- 按 request.acceptanceCriteria 的顺序逐条验证；结果 checks 必须以 1..N 精确覆盖全部 AC。
- request.engineQualityGate 若存在，是引擎在同一提交与冻结质量契约上刚完成的全量检查证明。只对其 checks 明确覆盖的机械 AC 直接引用该证明，禁止重复执行相同命令；代码语义、范围和未覆盖能力仍须独立验证。
- 将单个 JSON 对象原子写入 request.resultPath；schema 必须匹配项目 validator 指令。
- 即使验收失败也正常写入 verdict=failed 的结果；不要用进程退出码代替结构化结论。

\`\`\`json
${JSON.stringify(request, null, 2)}
\`\`\`
`;
}

/**
 * @deprecated 仅供激活前旧控制流与同步单元测试使用。正式控制流必须使用
 * clearValidationResultWithWriter，不得接受任意结果路径。
 */
export function clearValidationResult(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** 每轮前由当前 owner 清理固定的 validation-result.json；文件缺失是合法空态。 */
export function clearValidationResultWithWriter(writer: WorkspaceWriter): Promise<void> {
  return writer.removeFile(VALIDATION_RESULT_FILE);
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
    storyBaseGitHead: expected.storyBaseGitHead,
    changeManifestDigest: expected.changeManifestDigest,
    changedPathCount: expected.changedPathCount,
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

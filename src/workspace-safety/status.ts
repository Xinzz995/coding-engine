import {
  evaluateWorkspaceSafetyDisk,
  type WorkspaceSafetyDiskEvaluation,
  type WorkspaceSafetyDiskReason,
} from './disk-evaluator.js';
import type { WorkspaceSafetyClassification } from './types.js';

export type WorkspaceSafetyStatus =
  'ready' | 'active' | 'recoverable' | 'isolated' | 'legacy' | 'invalid' | 'uninitialized';

export interface WorkspaceSafetyStatusDisplay {
  readonly label: string;
  readonly summary: string;
  readonly guidance: string | null;
}

/**
 * Read-only status projection shared by doctor, status, dashboard, and CLI adapters.
 *
 * `status` is deliberately diagnostic rather than an authorization decision. A writer must
 * still acquire and verify its own workspace authority instead of trusting an earlier snapshot.
 */
export interface WorkspaceSafetyStatusSnapshot {
  readonly status: WorkspaceSafetyStatus;
  readonly observedClassification: WorkspaceSafetyClassification;
  readonly reason: WorkspaceSafetyDiskReason;
  readonly operationState: WorkspaceSafetyDiskEvaluation['operationState'];
  readonly operationLocation: WorkspaceSafetyDiskEvaluation['operationLocation'];
  readonly probeEvidence: WorkspaceSafetyDiskEvaluation['probeEvidence'];
  readonly safetyFingerprint: string | null;
  readonly diagnostic: string | null;
  readonly display: WorkspaceSafetyStatusDisplay;
}

function assertNever(value: never): never {
  throw new Error(`Unknown workspace safety classification: ${String(value)}`);
}

/**
 * Keep the public display vocabulary small without discarding the evaluator's exact observation.
 * Recovery owns the workspace just like another active operation, while an empty eligible
 * directory is presented as uninitialized rather than leaking the internal bootstrap term.
 */
export function normalizeWorkspaceSafetyStatus(
  classification: WorkspaceSafetyClassification,
): WorkspaceSafetyStatus {
  switch (classification) {
    case 'ready':
    case 'active':
    case 'recoverable':
    case 'isolated':
    case 'legacy':
    case 'invalid':
      return classification;
    case 'recovering':
      return 'active';
    case 'uninitialized-empty':
      return 'uninitialized';
    default:
      return assertNever(classification);
  }
}

function displayFor(
  status: WorkspaceSafetyStatus,
  observedClassification: WorkspaceSafetyClassification,
): WorkspaceSafetyStatusDisplay {
  if (observedClassification === 'recovering') {
    return {
      label: '恢复中',
      summary: '工作区恢复流程正在执行，或上一次恢复尚未完成。',
      guidance: '不要启动新的写操作；请继续既有恢复流程。',
    };
  }

  switch (status) {
    case 'ready':
      return {
        label: '就绪',
        summary: '工作区安全记录有效，当前没有活动写入者。',
        guidance: null,
      };
    case 'active':
      return {
        label: '使用中',
        summary: '工作区当前存在活动写入者。',
        guidance: '等待当前操作结束后再继续。',
      };
    case 'recoverable':
      return {
        label: '可恢复',
        summary: '原写入者已经退出，且现有证据允许显式恢复。',
        guidance: '使用对应的 workspace 恢复命令；不要手动删除安全记录。',
      };
    case 'isolated':
      return {
        label: '已隔离',
        summary: '工作区状态无法被安全接管。',
        guidance: '保留现场并根据诊断处理；不要强行删除安全记录。',
      };
    case 'legacy':
      return {
        label: '旧版工作区',
        summary: '工作区包含旧版运行记录，无法证明旧进程树已经完全退出。',
        guidance: '停止所有旧版写入命令，并初始化一个新的工作区。',
      };
    case 'invalid':
      return {
        label: '状态无效',
        summary: '工作区安全记录损坏、错绑或无法可靠读取。',
        guidance: '保留现场并根据诊断处理；不要手工修补安全记录。',
      };
    case 'uninitialized':
      return {
        label: '未初始化',
        summary: '目录为空，可以显式初始化为新版安全工作区。',
        guidance: '先运行 workspace 初始化命令。',
      };
    default:
      return assertNever(status);
  }
}

export function adaptWorkspaceSafetyEvaluation(
  evaluation: WorkspaceSafetyDiskEvaluation,
): WorkspaceSafetyStatusSnapshot {
  const status = normalizeWorkspaceSafetyStatus(evaluation.classification);
  return {
    status,
    observedClassification: evaluation.classification,
    reason: evaluation.reason,
    operationState: evaluation.operationState,
    operationLocation: evaluation.operationLocation,
    probeEvidence: evaluation.probeEvidence,
    safetyFingerprint: evaluation.safetyFingerprint ?? null,
    diagnostic: evaluation.diagnostic ?? null,
    display: displayFor(status, evaluation.classification),
  };
}

/** One text representation for every human-facing read-only consumer. */
export function renderWorkspaceSafetyStatusLines(
  snapshot: WorkspaceSafetyStatusSnapshot,
): readonly string[] {
  return [
    `🧱 workspace 安全状态：${snapshot.display.label}（${snapshot.status}）`,
    `  ${snapshot.display.summary}`,
    ...(snapshot.display.guidance === null ? [] : [`  💡 ${snapshot.display.guidance}`]),
  ];
}

/**
 * Reads the current disk state through the production evaluator. This function never acquires a
 * lease, performs recovery, creates a directory, or writes a status cache.
 */
export async function inspectWorkspaceSafetyStatus(
  workspacePath: string,
): Promise<WorkspaceSafetyStatusSnapshot> {
  const evaluation = await evaluateWorkspaceSafetyDisk({ workspacePath });
  return adaptWorkspaceSafetyEvaluation(evaluation);
}

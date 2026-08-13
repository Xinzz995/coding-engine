import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ManagedWorkspaceProcessOptions } from '../workspace-safety/coordinator.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import {
  ReviewTemporaryDirectory,
  type ReviewTemporaryCleanupResult,
} from '../review/temporary-directory.js';
import { VALIDATION_PROTOCOL_VERSION } from '../contracts/validation-contract.js';
import type { AgentKind } from './agent.js';
import {
  observeValidatorRunner,
  type ValidatorRunnerObservation,
} from './validator-runner-observation.js';
import {
  resolveValidatorRunnerProfile,
  validatorCanaryEvidenceDigest,
  validatorRunnerTemporaryDomain,
  type ValidatorRunnerCanaryEvidence,
  type ValidatorRunnerProfile,
  type ValidatorRunnerProfileUnverifiableCode,
} from './validator-runner-profile.js';

type ManagedTermination = ManagedWorkspaceProcessOptions['termination'];

export type ValidatorHostIsolationUnverifiableCode =
  ValidatorRunnerProfileUnverifiableCode | 'runner-unobservable';

/** 引擎侧 canary 执行器合同：只接受引擎机械观察产出的证据，模型自述不构成通过。 */
export type ValidatorCanaryProvider = (
  profile: ValidatorRunnerProfile,
) => Promise<ValidatorRunnerCanaryEvidence | undefined> | ValidatorRunnerCanaryEvidence | undefined;

export interface ValidatorHostIsolationRequest {
  readonly session: WorkspaceSession;
  readonly runner: AgentKind;
  /** null = runner-default 模型路由。 */
  readonly model: string | null;
  readonly projectRoot: string;
  readonly engineWorkspaceRoot: string;
  /** 干净验证检出根；Validator 的唯一项目输入。 */
  readonly cleanCheckoutRoot: string;
  /** 冻结质量契约摘要（raw hex，64 字符）。 */
  readonly commandContractSha256: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly termination?: ManagedTermination;
  /** @internal 测试注入观察结果；生产始终受监督探测真实可执行文件。 */
  readonly observationForTests?: ValidatorRunnerObservation;
  /** canary 执行器；批次 C 提供引擎默认实现，测试可注入。缺省 = canary-missing。 */
  readonly canaryProvider?: ValidatorCanaryProvider;
}

export interface ValidatorHostIsolationHandle {
  /**
   * 隔离域收口：Runner 受管进程结算（containment 证明由 runAgent 的受管 operation 承担）
   * 后调用；域本身是运行期可变的被动存储，收口时做身份与 safe tree 核对，status 非
   * removed 时凭证链必须失败关闭。
   */
  readonly dispose: () => ReviewTemporaryCleanupResult;
}

export type ValidatorHostIsolationOutcome =
  | ({
      readonly status: 'ready';
      readonly profile: ValidatorRunnerProfile;
      readonly canary: ValidatorRunnerCanaryEvidence;
      /** Validator claim 的固定写出位置（临时域内沙箱唯一授权输出区）。 */
      readonly resultPath: string;
      readonly sealedInvocation: {
        readonly executable: string;
        readonly args: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
      };
      /** 凭证 v3 绑定（`sha256:` 前缀）。 */
      readonly binding: { readonly profileDigest: string; readonly canaryDigest: string };
    } & ValidatorHostIsolationHandle)
  | ({
      readonly status: 'unverifiable';
      readonly code: ValidatorHostIsolationUnverifiableCode;
      readonly message: string;
      readonly profileDigest?: string;
    } & ValidatorHostIsolationHandle);

function presealCodexAuthentication(runnerState: string, host: NodeJS.ProcessEnv): void {
  const hostCodexHome = host.CODEX_HOME ?? join(homedir(), '.codex');
  const source = join(hostCodexHome, 'auth.json');
  if (!existsSync(source)) return;
  const target = join(runnerState, 'auth.json');
  copyFileSync(source, target);
  chmodSync(target, 0o600);
}

function handleFor(domain: ReviewTemporaryDirectory): ValidatorHostIsolationHandle {
  return {
    dispose: () => domain.cleanup(),
  };
}

/**
 * 建立一次 Validator 调用的宿主隔离：创建单次调用临时身份域、机械观察 Runner、
 * 解析固定 profile 并核对 canary 反测（ADR-025）。任何一步失败都返回 unverifiable，
 * 调用方按 ADR-023 退出 5，不得回退宽权限执行。
 */
export async function establishValidatorHostIsolation(
  request: ValidatorHostIsolationRequest,
): Promise<ValidatorHostIsolationOutcome> {
  const domain = ReviewTemporaryDirectory.create({
    prefix: 'coding-x-validator-identity-',
    projectRoot: request.projectRoot,
  });
  const handle = handleFor(domain);
  const host = request.hostEnvironment ?? process.env;
  try {
    const layout = validatorRunnerTemporaryDomain(domain.root, request.runner);
    for (const directory of [
      layout.home,
      layout.config,
      layout.cache,
      layout.data,
      layout.temp,
      layout.sessions,
      layout.runnerState,
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (request.runner === 'codex') presealCodexAuthentication(layout.runnerState, host);

    const observed = request.observationForTests
      ? ({ status: 'observed', observation: request.observationForTests } as const)
      : await observeValidatorRunner({
          session: request.session,
          runner: request.runner,
          projectRoot: request.projectRoot,
          environment: host,
          timeoutMs: request.timeoutMs,
          termination: request.termination,
        });
    if (observed.status !== 'observed') {
      return {
        status: 'unverifiable',
        code: 'runner-unobservable',
        message: observed.message,
        ...handle,
      };
    }
    const observation = observed.observation;
    const profileRequest = {
      runner: request.runner,
      runnerVersion: observation.runnerVersion,
      platform: observation.platform,
      architecture: observation.architecture,
      model: request.model,
      executablePath: observation.executablePath,
      executableSha256: observation.executableSha256,
      cleanCheckoutRoot: realpathSync(request.cleanCheckoutRoot),
      sourceProjectRoot: realpathSync(request.projectRoot),
      engineWorkspaceRoot: realpathSync(request.engineWorkspaceRoot),
      identityRoot: domain.root,
      claimProtocolVersion: VALIDATION_PROTOCOL_VERSION,
      commandContractSha256: request.commandContractSha256,
      hostEnvironment: host,
    } as const;

    // 两步解析：先取无 canary 的 profile（含 profileDigest），交给引擎侧 canary 执行器，
    // 再带证据重新解析。证据绑定本次域与 argv，跨调用不可复用。
    const initial = resolveValidatorRunnerProfile(profileRequest);
    if (initial.status === 'unverifiable' && initial.code !== 'canary-missing') {
      return {
        status: 'unverifiable',
        code: initial.code,
        message: initial.message,
        ...(initial.profile ? { profileDigest: initial.profile.profileDigest } : {}),
        ...handle,
      };
    }
    const profile =
      initial.status === 'ready' ? initial.profile : (initial.profile as ValidatorRunnerProfile);
    const canary = await request.canaryProvider?.(profile);
    const resolution = resolveValidatorRunnerProfile({ ...profileRequest, canary });
    if (resolution.status !== 'ready') {
      return {
        status: 'unverifiable',
        code: resolution.code,
        message: resolution.message,
        ...(resolution.profile ? { profileDigest: resolution.profile.profileDigest } : {}),
        ...handle,
      };
    }
    return {
      status: 'ready',
      profile: resolution.profile,
      canary: canary as ValidatorRunnerCanaryEvidence,
      resultPath: resolution.profile.temporary.resultPath,
      sealedInvocation: {
        executable: resolution.profile.executablePath,
        args: resolution.profile.args,
        environment: resolution.profile.environment,
      },
      binding: {
        profileDigest: `sha256:${resolution.profile.profileDigest}`,
        canaryDigest: `sha256:${validatorCanaryEvidenceDigest(canary as ValidatorRunnerCanaryEvidence)}`,
      },
      ...handle,
    };
  } catch (error) {
    // 建立过程中的任何异常（目录创建、realpath、认证预置）都判不可验证；
    // 域本身交由调用方 dispose，清理失败仍走 retention fail-closed。
    return {
      status: 'unverifiable',
      code: 'invalid-profile',
      message: `Validator 宿主隔离无法建立：${error instanceof Error ? error.message : String(error)}`,
      ...handle,
    };
  }
}

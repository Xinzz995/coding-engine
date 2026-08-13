import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  HOST_CONTEXT_ISOLATION_EXPECTATIONS,
  resolveValidatorRunnerProfile,
  validatorCanaryEvidenceDigest,
  validatorRunnerTemporaryDomain,
  type ValidatorRunnerCanaryEvidence,
  type ValidatorRunnerProfile,
  type ValidatorRunnerProfileUnverifiableCode,
} from './validator-runner-profile.js';

type ManagedTermination = ManagedWorkspaceProcessOptions['termination'];

export type ValidatorHostIsolationUnverifiableCode =
  ValidatorRunnerProfileUnverifiableCode | 'runner-unobservable' | 'host-context-unverifiable';

/** 允许出现在临时域 CODEX_HOME 里的引擎预置文件；其余（AGENTS.md/config/memory 等）视为污染。 */
const ALLOWED_RUNNER_STATE_ENTRIES = new Set(['auth.json']);

export interface HostContextIsolationFact {
  readonly enforced: boolean;
  readonly failures: readonly string[];
}

/**
 * 机械核对宿主上下文注入隔离的静态事实（ADR-025，替代运行时 sentinel）：
 * 1. profile.args 含该 runner 的忽略/禁用参数全集；
 * 2. 环境的 CODEX_HOME/HOME/XDG 都落在引擎临时身份域内（宿主真实配置被重定向切断）；
 * 3. 临时域 CODEX_HOME 除引擎预置 auth 外无任何配置文件（无自造/残留注入源）。
 * 三项组合成「宿主自动注入向量已被切断」的可审计事实；任一不满足即不可验证。
 */
export function assertHostContextIsolation(
  profile: ValidatorRunnerProfile,
): HostContextIsolationFact {
  const failures: string[] = [];
  if (profile.runner === 'codex') {
    const expectations = HOST_CONTEXT_ISOLATION_EXPECTATIONS.codex;
    for (const arg of expectations.requiredArgs) {
      if (!profile.args.includes(arg)) failures.push(`缺少隔离参数 ${arg}`);
    }
    for (const feature of expectations.requiredDisabledFeatures) {
      const disabled = profile.args.some(
        (value, index) => value === '--disable' && profile.args[index + 1] === feature,
      );
      if (!disabled) failures.push(`未禁用注入能力 ${feature}`);
    }
  }
  const identityRoot = profile.temporary.root;
  const withinIdentity = (value: string | undefined, label: string): void => {
    if (value === undefined || !pathWithinIdentity(identityRoot, value)) {
      failures.push(`${label} 未落在临时身份域内`);
    }
  };
  withinIdentity(profile.environment.HOME, 'HOME');
  withinIdentity(profile.environment.CODEX_HOME, 'CODEX_HOME');
  withinIdentity(profile.environment.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME');
  withinIdentity(profile.environment.XDG_DATA_HOME, 'XDG_DATA_HOME');
  withinIdentity(profile.environment.XDG_CACHE_HOME, 'XDG_CACHE_HOME');
  try {
    for (const entry of readdirSync(profile.temporary.runnerState)) {
      if (!ALLOWED_RUNNER_STATE_ENTRIES.has(entry)) {
        failures.push(`临时域 Runner 状态目录存在非预置文件 ${entry}`);
      }
    }
  } catch (error) {
    failures.push(
      `无法核对临时域 Runner 状态目录：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { enforced: failures.length === 0, failures };
}

function pathWithinIdentity(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

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
      /** 宿主上下文注入隔离的静态事实核对结果（ready 时必为 enforced）。 */
      readonly hostContextIsolation: HostContextIsolationFact;
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
    // 宿主注入隔离的静态事实核对必须在 canary 前完成：此刻临时域仍为引擎预置的纯净态
    // （canary 稍后会种 credential 探针），能真实核对「Runner 状态目录除 auth 外无配置」。
    const hostContextIsolation = assertHostContextIsolation(profile);
    if (!hostContextIsolation.enforced) {
      return {
        status: 'unverifiable',
        code: 'host-context-unverifiable',
        message: `宿主上下文注入隔离无法证明：${hostContextIsolation.failures.join('；')}`,
        profileDigest: profile.profileDigest,
        ...handle,
      };
    }
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
      hostContextIsolation,
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

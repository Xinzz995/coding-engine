import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentKind } from './agent.js';

export const VALIDATOR_RUNNER_PROFILE_POLICY_VERSION = 'validator-host-isolation-v1';
export const VALIDATOR_RUNNER_CANARY_SCHEMA_VERSION = 1;

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'linux', 'win32']);
const CURRENT_RUNNER_VERSIONS: Readonly<Record<AgentKind, string>> = {
  codex: '0.147.0-alpha.6.5',
  claude: '2.1.220',
  cursor: '2026.07.20-8cc9c0b',
};
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SCHEMA_BYTES = 128 * 1024;

const BASE_ENVIRONMENT_NAMES = [
  'PATH',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
] as const;

const FORBIDDEN_COMMAND_ENVIRONMENT_NAME =
  /(?:^|_)(?:AUTH|COOKIE|CREDENTIAL|HOME|KEY|MCP|PASSWORD|SECRET|SESSION|TOKEN)(?:_|$)/iu;
const FORBIDDEN_COMMAND_ENVIRONMENT_PREFIX = /^(?:CODEX|CLAUDE|CURSOR|GITHUB|NPM|XDG)_/iu;

const CODEX_DISABLED_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'enable_mcp_apps',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'plugin_sharing',
  'remote_plugin',
  'request_permissions_tool',
  'shell_snapshot',
  'skill_mcp_dependency_install',
  'skill_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'workspace_dependencies',
] as const;

export const VALIDATOR_RUNNER_CANARY_CHECKS = [
  'host-rules-hidden',
  'host-memory-hidden',
  'host-mcp-hidden',
  'host-plugins-hidden',
  'host-hooks-hidden',
  'host-apps-hidden',
  'host-session-hidden',
  'credential-hidden',
  'outside-read-denied',
  'outside-write-denied',
  'project-agents-readable',
  'checkout-read-allowed',
  'controlled-command-allowed',
  'structured-claim-returned',
  'process-tree-settled',
  'temporary-domain-clean',
] as const;

export type ValidatorRunnerCanaryCheck = (typeof VALIDATOR_RUNNER_CANARY_CHECKS)[number];
export type ValidatorRunnerCanaryCheckResult = 'passed' | 'failed' | 'unverifiable';

export interface ValidatorRunnerCanaryEvidence {
  readonly schemaVersion: typeof VALIDATOR_RUNNER_CANARY_SCHEMA_VERSION;
  readonly policyVersion: typeof VALIDATOR_RUNNER_PROFILE_POLICY_VERSION;
  readonly runner: AgentKind;
  /** Version output observed from the supervised executable, not a configured expectation. */
  readonly runnerVersion: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly model: string;
  readonly executableSha256: string;
  readonly profileDigest: string;
  /** This object is accepted only from the engine-owned canary executor, never from model output. */
  readonly source: 'engine-observed-v1';
  readonly checks: Readonly<Record<ValidatorRunnerCanaryCheck, ValidatorRunnerCanaryCheckResult>>;
}

export interface ValidatorRunnerProfileRequest {
  readonly runner: AgentKind;
  /** Raw first line returned by the supervised `--version` invocation. */
  readonly runnerVersion: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly model: string;
  /** Canonical absolute path resolved before this module is called. */
  readonly executablePath: string;
  /** Digest of the executable bytes (or signed native bundle selected by the adapter). */
  readonly executableSha256: string;
  /** Canonical clean validation checkout. */
  readonly cleanCheckoutRoot: string;
  /** Canonical developer source tree; it must never become the Validator cwd or identity domain. */
  readonly sourceProjectRoot: string;
  /** Canonical engine workspace containing state and receipts. */
  readonly engineWorkspaceRoot: string;
  /** Engine-owned temporary domain outside the checkout and project workspace. */
  readonly identityRoot: string;
  /** Exact structured Validator result schema. */
  readonly claimSchema: string;
  /** Digest of the frozen default-branch quality command contract. */
  readonly commandContractSha256: string;
  /** Explicit non-secret variables made available to controlled project commands. */
  readonly commandEnvironment?: Readonly<Record<string, string>>;
  /** Host environment is filtered through a fixed allowlist; HOME and auth variables are ignored. */
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly canary?: ValidatorRunnerCanaryEvidence;
}

export interface ValidatorRunnerTemporaryDomain {
  readonly root: string;
  readonly home: string;
  readonly config: string;
  readonly cache: string;
  readonly data: string;
  readonly temp: string;
  readonly sessions: string;
  readonly contracts: string;
  readonly claimSchemaPath: string;
  readonly runnerState: string;
  readonly lifecycle: 'single-validator-invocation';
  readonly modelAccess: 'denied';
  readonly cleanup: 'required-after-process-settlement';
  readonly authentication: 'presealed-native-store-outside-model-sandbox';
}

export interface ValidatorRunnerProfile {
  readonly policyVersion: typeof VALIDATOR_RUNNER_PROFILE_POLICY_VERSION;
  readonly runner: AgentKind;
  readonly runnerVersion: string;
  readonly normalizedRunnerVersion: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly model: string;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly cleanCheckoutRoot: string;
  readonly sourceProjectRoot: string;
  readonly engineWorkspaceRoot: string;
  readonly temporary: ValidatorRunnerTemporaryDomain;
  readonly environment: Readonly<Record<string, string>>;
  readonly commandEnvironment: Readonly<Record<string, string>>;
  readonly args: readonly string[];
  readonly promptMode: 'stdin';
  readonly claimTransport: 'structured-stdout';
  readonly claimSchemaSha256: string;
  readonly commandContractSha256: string;
  readonly allowedProjectInputs: readonly [
    'tracked-clean-checkout',
    'AGENTS.md',
    'quality-contract',
  ];
  readonly forbiddenHostInputs: readonly [
    'rules',
    'memory',
    'mcp',
    'plugins',
    'hooks',
    'apps',
    'session',
  ];
  readonly requiredCanaryChecks: typeof VALIDATOR_RUNNER_CANARY_CHECKS;
  readonly profileDigest: string;
}

export type ValidatorRunnerProfileUnverifiableCode =
  | 'invalid-profile'
  | 'unsupported-platform'
  | 'unsupported-version'
  | 'native-boundary-incomplete'
  | 'canary-missing'
  | 'canary-binding-mismatch'
  | 'canary-failed';

export type ValidatorRunnerProfileResolution =
  | { readonly status: 'ready'; readonly profile: ValidatorRunnerProfile }
  | {
      readonly status: 'unverifiable';
      readonly code: ValidatorRunnerProfileUnverifiableCode;
      readonly message: string;
      readonly profile?: ValidatorRunnerProfile;
    };

class InvalidProfile extends Error {}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRecord);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableRecord(item)]),
  );
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(stableRecord(value)));
}

function assertBoundedString(value: string, label: string, maximum: number): string {
  if (value.trim() === '' || value.length > maximum || value.includes('\0')) {
    throw new InvalidProfile(`${label} 必须是 1-${maximum} 字符的非空字符串`);
  }
  return value.trim();
}

function assertSha256(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new InvalidProfile(`${label} 不是 SHA-256`);
  return normalized;
}

function pathWithin(parent: string, candidate: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes('\0'))
    throw new InvalidProfile(`${label} 必须是绝对路径`);
  return resolve(value);
}

function normalizedRunnerVersion(runner: AgentKind, raw: string): string {
  const value = assertBoundedString(raw, 'Runner version', 200);
  const pattern =
    runner === 'codex'
      ? /^(?:codex-cli )?([^\s]+)$/u
      : runner === 'claude'
        ? /^([^\s]+)(?: \(Claude Code\))?$/u
        : /^([^\s]+)$/u;
  const match = value.match(pattern);
  if (!match) throw new InvalidProfile(`${runner} Runner version 格式无法机械识别`);
  return match[1];
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return environment[name];
  const matches = Object.entries(environment).filter(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length > 1) throw new InvalidProfile(`环境变量 ${name} 存在大小写冲突`);
  return matches[0]?.[1];
}

function setEnvironmentValue(
  target: Record<string, string>,
  name: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  if (value.includes('\0')) throw new InvalidProfile(`环境变量 ${name} 包含 NUL`);
  const existing = Object.keys(target).find(
    (key) => platform === 'win32' && key.toLowerCase() === name.toLowerCase(),
  );
  if (existing && existing !== name) throw new InvalidProfile(`环境变量 ${name} 存在大小写冲突`);
  target[name] = value;
}

function temporaryDomain(root: string, runner: AgentKind): ValidatorRunnerTemporaryDomain {
  const home = join(root, 'home');
  const contracts = join(root, 'contracts');
  return {
    root,
    home,
    config: join(root, 'config'),
    cache: join(root, 'cache'),
    data: join(root, 'data'),
    temp: join(root, 'tmp'),
    sessions: join(root, 'sessions'),
    contracts,
    claimSchemaPath: join(contracts, 'validation-result.schema.json'),
    runnerState: join(root, runner),
    lifecycle: 'single-validator-invocation',
    modelAccess: 'denied',
    cleanup: 'required-after-process-settlement',
    authentication: 'presealed-native-store-outside-model-sandbox',
  };
}

function safeEnvironment(
  runner: AgentKind,
  platform: NodeJS.Platform,
  temporary: ValidatorRunnerTemporaryDomain,
  host: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of BASE_ENVIRONMENT_NAMES) {
    const value = environmentValue(host, name, platform);
    if (value !== undefined) setEnvironmentValue(result, name, value, platform);
  }
  setEnvironmentValue(result, 'CI', '1', platform);
  setEnvironmentValue(result, 'NO_COLOR', '1', platform);
  setEnvironmentValue(result, 'HOME', temporary.home, platform);
  setEnvironmentValue(result, 'XDG_CONFIG_HOME', temporary.config, platform);
  setEnvironmentValue(result, 'XDG_CACHE_HOME', temporary.cache, platform);
  setEnvironmentValue(result, 'XDG_DATA_HOME', temporary.data, platform);
  setEnvironmentValue(result, 'TMPDIR', temporary.temp, platform);
  setEnvironmentValue(result, 'TMP', temporary.temp, platform);
  setEnvironmentValue(result, 'TEMP', temporary.temp, platform);
  if (platform === 'win32') {
    setEnvironmentValue(result, 'USERPROFILE', temporary.home, platform);
    setEnvironmentValue(result, 'APPDATA', temporary.config, platform);
    setEnvironmentValue(result, 'LOCALAPPDATA', temporary.data, platform);
  }
  if (runner === 'codex')
    setEnvironmentValue(result, 'CODEX_HOME', temporary.runnerState, platform);
  if (runner === 'claude') {
    setEnvironmentValue(result, 'CLAUDE_CONFIG_DIR', temporary.runnerState, platform);
    setEnvironmentValue(result, 'CLAUDE_CODE_SAFE_MODE', '1', platform);
    setEnvironmentValue(result, 'CLAUDE_CODE_SIMPLE', '1', platform);
  }
  return Object.freeze(result);
}

function safeCommandEnvironment(
  input: Readonly<Record<string, string>> | undefined,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = assertBoundedString(rawName, '命令环境变量名称', 200);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new InvalidProfile(`命令环境变量名称非法：${name}`);
    }
    if (
      FORBIDDEN_COMMAND_ENVIRONMENT_NAME.test(name) ||
      FORBIDDEN_COMMAND_ENVIRONMENT_PREFIX.test(name)
    ) {
      throw new InvalidProfile(`命令环境变量 ${name} 可能暴露认证或宿主上下文`);
    }
    setEnvironmentValue(
      result,
      name,
      assertBoundedString(value, `命令环境变量 ${name}`, 16_384),
      platform,
    );
  }
  return Object.freeze(result);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexPermissionArgs(checkout: string, temporaryOutput: string): string[] {
  const readableSystem =
    'filesystem={ ":minimal" = "read", ":root" = "deny", ":tmpdir" = "deny", ":slash_tmp" = "deny", ';
  return [
    '-c',
    'default_permissions="coding_x_validator"',
    '-c',
    `permissions.coding_x_validator.${readableSystem}${tomlString(checkout)} = "write", ${tomlString(temporaryOutput)} = "write" }`,
    '-c',
    'permissions.coding_x_validator.network.enabled=false',
  ];
}

function codexShellEnvironmentArgs(environment: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name} = ${tomlString(value)}`)
    .join(', ');
  return [
    '-c',
    'shell_environment_policy.inherit="none"',
    '-c',
    `shell_environment_policy.set={ ${entries} }`,
  ];
}

function runnerArgs(options: {
  runner: AgentKind;
  model: string;
  checkout: string;
  temporary: ValidatorRunnerTemporaryDomain;
  claimSchema: string;
  commandEnvironment: Readonly<Record<string, string>>;
}): string[] {
  if (options.runner === 'codex') {
    return [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--sandbox',
      'workspace-write',
      ...codexPermissionArgs(options.checkout, options.temporary.temp),
      '-c',
      'approval_policy="never"',
      '-c',
      'web_search="disabled"',
      ...codexShellEnvironmentArgs(options.commandEnvironment),
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      '--model',
      options.model,
      '--cd',
      options.checkout,
      '--output-schema',
      options.temporary.claimSchemaPath,
      '--json',
      '-',
    ];
  }
  if (options.runner === 'claude') {
    return [
      '--print',
      '--output-format',
      'stream-json',
      '--bare',
      '--safe-mode',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--no-chrome',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--settings',
      join(options.temporary.runnerState, 'settings.json'),
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Bash',
      '--model',
      options.model,
      '--json-schema',
      options.claimSchema,
    ];
  }
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--sandbox',
    'enabled',
    '--model',
    options.model,
    '--workspace',
    options.checkout,
  ];
}

function profileDigest(profile: Omit<ValidatorRunnerProfile, 'profileDigest'>): string {
  // Canary is intentionally per invocation. Absolute checkout/identity paths and the exact
  // rendered argv are security inputs, so a result from another temporary domain is stale.
  return digest(profile);
}

function buildProfile(request: ValidatorRunnerProfileRequest): ValidatorRunnerProfile {
  const runnerVersion = assertBoundedString(request.runnerVersion, 'Runner version', 200);
  const normalizedVersion = normalizedRunnerVersion(request.runner, runnerVersion);
  const model = assertBoundedString(request.model, 'Runner model', 300);
  const architecture = assertBoundedString(request.architecture, 'Runner architecture', 100);
  const executablePath = absolutePath(request.executablePath, 'Runner executable');
  const checkout = absolutePath(request.cleanCheckoutRoot, 'clean checkout');
  const sourceProject = absolutePath(request.sourceProjectRoot, 'source project');
  const engineWorkspace = absolutePath(request.engineWorkspaceRoot, 'engine workspace');
  const identityRoot = absolutePath(request.identityRoot, 'Validator temporary identity root');
  if (pathWithin(checkout, identityRoot) || pathWithin(identityRoot, checkout)) {
    throw new InvalidProfile('Validator temporary identity root 与 clean checkout 必须完全分离');
  }
  if (pathWithin(checkout, executablePath) || pathWithin(identityRoot, executablePath)) {
    throw new InvalidProfile('Runner executable 不能来自 clean checkout 或临时身份域');
  }
  if (
    pathWithin(sourceProject, identityRoot) ||
    pathWithin(identityRoot, sourceProject) ||
    pathWithin(engineWorkspace, identityRoot) ||
    pathWithin(identityRoot, engineWorkspace)
  ) {
    throw new InvalidProfile(
      'Validator temporary identity root 必须与源码项目和 engine workspace 完全分离',
    );
  }
  if (
    pathWithin(sourceProject, checkout) ||
    pathWithin(checkout, sourceProject) ||
    pathWithin(engineWorkspace, checkout) ||
    pathWithin(checkout, engineWorkspace)
  ) {
    throw new InvalidProfile('clean checkout 必须与源码项目和 engine workspace 完全分离');
  }
  if (pathWithin(sourceProject, executablePath) || pathWithin(engineWorkspace, executablePath)) {
    throw new InvalidProfile('Runner executable 不能来自源码项目或 engine workspace');
  }
  const claimSchema = assertBoundedString(
    request.claimSchema,
    'Validator claim schema',
    MAX_SCHEMA_BYTES,
  );
  if (Buffer.byteLength(claimSchema) > MAX_SCHEMA_BYTES) {
    throw new InvalidProfile(`Validator claim schema 超过 ${MAX_SCHEMA_BYTES} bytes`);
  }
  try {
    const parsed = JSON.parse(claimSchema) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('schema root is not an object');
    }
  } catch {
    throw new InvalidProfile('Validator claim schema 不是 JSON 对象');
  }
  const temporary = temporaryDomain(identityRoot, request.runner);
  const environment = safeEnvironment(
    request.runner,
    request.platform,
    temporary,
    request.hostEnvironment ?? process.env,
  );
  const commandEnvironment = safeCommandEnvironment(
    {
      ...Object.fromEntries(
        ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'ComSpec', 'PATHEXT'].flatMap((name) =>
          environment[name] === undefined ? [] : [[name, environment[name]]],
        ),
      ),
      TMPDIR: temporary.temp,
      TMP: temporary.temp,
      TEMP: temporary.temp,
      ...request.commandEnvironment,
    },
    request.platform,
  );
  const args = runnerArgs({
    runner: request.runner,
    model,
    checkout,
    temporary,
    claimSchema,
    commandEnvironment,
  });
  const withoutDigest: Omit<ValidatorRunnerProfile, 'profileDigest'> = {
    policyVersion: VALIDATOR_RUNNER_PROFILE_POLICY_VERSION,
    runner: request.runner,
    runnerVersion,
    normalizedRunnerVersion: normalizedVersion,
    platform: request.platform,
    architecture,
    model,
    executablePath,
    executableSha256: assertSha256(request.executableSha256, 'Runner executable digest'),
    cleanCheckoutRoot: checkout,
    sourceProjectRoot: sourceProject,
    engineWorkspaceRoot: engineWorkspace,
    temporary,
    environment,
    commandEnvironment,
    args: Object.freeze(args),
    promptMode: 'stdin',
    claimTransport: 'structured-stdout',
    claimSchemaSha256: sha256(claimSchema),
    commandContractSha256: assertSha256(
      request.commandContractSha256,
      'quality command contract digest',
    ),
    allowedProjectInputs: ['tracked-clean-checkout', 'AGENTS.md', 'quality-contract'],
    forbiddenHostInputs: ['rules', 'memory', 'mcp', 'plugins', 'hooks', 'apps', 'session'],
    requiredCanaryChecks: VALIDATOR_RUNNER_CANARY_CHECKS,
  };
  return { ...withoutDigest, profileDigest: profileDigest(withoutDigest) };
}

function canaryBindingFailures(
  profile: ValidatorRunnerProfile,
  evidence: ValidatorRunnerCanaryEvidence,
): string[] {
  const failures: string[] = [];
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return ['shape'];
  }
  const evidenceRecord = evidence as unknown as Record<string, unknown>;
  const expectedEvidenceFields = new Set([
    'schemaVersion',
    'policyVersion',
    'runner',
    'runnerVersion',
    'platform',
    'architecture',
    'model',
    'executableSha256',
    'profileDigest',
    'source',
    'checks',
  ]);
  for (const name of Object.keys(evidenceRecord)) {
    if (!expectedEvidenceFields.has(name)) failures.push(`unknown:${name}`);
  }
  const exact: Array<[string, unknown, unknown]> = [
    ['schemaVersion', evidence.schemaVersion, VALIDATOR_RUNNER_CANARY_SCHEMA_VERSION],
    ['policyVersion', evidence.policyVersion, profile.policyVersion],
    ['runner', evidence.runner, profile.runner],
    ['runnerVersion', evidence.runnerVersion, profile.runnerVersion],
    ['platform', evidence.platform, profile.platform],
    ['architecture', evidence.architecture, profile.architecture],
    ['model', evidence.model, profile.model],
    ['executableSha256', evidence.executableSha256, profile.executableSha256],
    ['profileDigest', evidence.profileDigest, profile.profileDigest],
    ['source', evidence.source, 'engine-observed-v1'],
  ];
  for (const [name, actual, expected] of exact) {
    if (actual !== expected) failures.push(name);
  }
  if (typeof evidence.checks !== 'object' || evidence.checks === null) {
    failures.push('checks');
  } else {
    const expectedChecks = new Set<string>(VALIDATOR_RUNNER_CANARY_CHECKS);
    for (const name of Object.keys(evidence.checks)) {
      if (!expectedChecks.has(name)) failures.push(`checks.unknown:${name}`);
    }
  }
  return failures;
}

function nativeBoundaryFailure(profile: ValidatorRunnerProfile): string | null {
  if (profile.runner === 'codex') return null;
  if (profile.runner === 'claude') {
    return (
      'Claude 2.1.220 虽可禁用自定义能力和持久会话，但当前 CLI 没有可机械约束 Bash ' +
      '只访问 clean checkout 的宿主沙箱；--bare 还会放弃 OAuth/keychain。参数存在不足以证明边界'
    );
  }
  return (
    'Cursor 2026.07.20-8cc9c0b 的 ask/plan 模式不能运行验收命令；可运行命令的 print 模式又没有' +
    '禁用宿主规则、MCP、插件和会话的参数，也没有结构化 schema 约束'
  );
}

export function resolveValidatorRunnerProfile(
  request: ValidatorRunnerProfileRequest,
): ValidatorRunnerProfileResolution {
  if (!SUPPORTED_PLATFORMS.has(request.platform)) {
    return {
      status: 'unverifiable',
      code: 'unsupported-platform',
      message: `Validator Runner 宿主隔离尚未支持 ${request.platform}`,
    };
  }
  let profile: ValidatorRunnerProfile;
  try {
    profile = buildProfile(request);
  } catch (error) {
    return {
      status: 'unverifiable',
      code: 'invalid-profile',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (profile.normalizedRunnerVersion !== CURRENT_RUNNER_VERSIONS[profile.runner]) {
    return {
      status: 'unverifiable',
      code: 'unsupported-version',
      message:
        `${profile.runner} ${profile.runnerVersion} 尚未完成 ${VALIDATOR_RUNNER_PROFILE_POLICY_VERSION} ` +
        '参数审计和真实隔离反测',
      profile,
    };
  }
  const nativeFailure = nativeBoundaryFailure(profile);
  if (nativeFailure !== null) {
    return {
      status: 'unverifiable',
      code: 'native-boundary-incomplete',
      message: nativeFailure,
      profile,
    };
  }
  if (request.canary === undefined) {
    return {
      status: 'unverifiable',
      code: 'canary-missing',
      message: `${profile.runner} Validator 隔离反测尚未针对当前版本、平台和安全参数运行`,
      profile,
    };
  }
  const bindingFailures = canaryBindingFailures(profile, request.canary);
  if (bindingFailures.length > 0) {
    return {
      status: 'unverifiable',
      code: 'canary-binding-mismatch',
      message: `Validator 隔离反测与当前 Profile 不匹配：${bindingFailures.join('、')}`,
      profile,
    };
  }
  const failedChecks = VALIDATOR_RUNNER_CANARY_CHECKS.filter(
    (check) => request.canary?.checks?.[check] !== 'passed',
  );
  if (failedChecks.length > 0) {
    return {
      status: 'unverifiable',
      code: 'canary-failed',
      message: `Validator 隔离反测未通过：${failedChecks.join('、')}`,
      profile,
    };
  }
  return { status: 'ready', profile };
}

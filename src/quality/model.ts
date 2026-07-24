import { createHash } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  normalize,
  sep,
} from 'node:path';
import type {
  FindingSeverity,
  QualityFindingDraft,
  ReviewAxis,
  ReviewModelOutput,
} from './types.js';

const RAW_FINDING_KEYS = new Set([
  'severity', 'file', 'line', 'title', 'evidence', 'source', 'impact', 'recommendation',
]);
const OUTPUT_KEYS = new Set(['summary', 'findings']);
const SEVERITIES = new Set<FindingSeverity>(['critical', 'high', 'medium', 'low']);
const MAX_FINDINGS = 50;
const MAX_FIELD_CHARS = 8_000;
const DEFAULT_MODEL_TIMEOUT_MS = 300_000;

export const reviewResponseSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'coding_x_quality_review',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'findings'],
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 8000 },
        findings: {
          type: 'array',
          maxItems: MAX_FINDINGS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'severity', 'file', 'line', 'title', 'evidence',
              'source', 'impact', 'recommendation',
            ],
            properties: {
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              file: { type: 'string', minLength: 1, maxLength: 1024 },
              line: { type: ['integer', 'null'], minimum: 1 },
              title: { type: 'string', minLength: 1, maxLength: 1000 },
              evidence: { type: 'string', minLength: 1, maxLength: 8000 },
              source: { type: 'string', minLength: 1, maxLength: 2000 },
              impact: { type: 'string', minLength: 1, maxLength: 8000 },
              recommendation: { type: 'string', minLength: 1, maxLength: 8000 },
            },
          },
        },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_FIELD_CHARS;
}

function validRepositoryPath(value: unknown): value is string {
  if (!validText(value) || isAbsolute(value)) return false;
  const path = normalize(value);
  return path !== '..' && !path.startsWith(`..${sep}`);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized.slice(0, 48) || 'finding';
}

function findingId(
  axis: ReviewAxis,
  file: string,
  line: number | null,
  title: string,
): string {
  const digest = createHash('sha256').update(`${axis}\0${file}\0${line ?? ''}\0${title}`).digest('hex').slice(0, 12);
  return `${axis}:${slug(file)}:${line ?? 0}:${digest}`;
}

export function normalizeReviewModelOutput(
  value: unknown,
  axis: ReviewAxis,
): (
  | { status: 'valid'; output: ReviewModelOutput; error: null }
  | { status: 'invalid'; output: null; error: string }
) {
  if (!isRecord(value) || !exactKeys(value, OUTPUT_KEYS)) {
    return { status: 'invalid', output: null, error: '模型输出根对象或字段非法' };
  }
  if (!validText(value.summary)) {
    return { status: 'invalid', output: null, error: '模型输出 summary 非法' };
  }
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
    return { status: 'invalid', output: null, error: '模型输出 findings 非法或过多' };
  }
  const findings: QualityFindingDraft[] = [];
  for (const [index, raw] of value.findings.entries()) {
    if (!isRecord(raw) || !exactKeys(raw, RAW_FINDING_KEYS)) {
      return { status: 'invalid', output: null, error: `findings[${index}] 字段非法` };
    }
    if (!SEVERITIES.has(raw.severity as FindingSeverity)
      || !validRepositoryPath(raw.file)
      || !(raw.line === null || (Number.isInteger(raw.line) && (raw.line as number) > 0))
      || !validText(raw.title)
      || !validText(raw.evidence)
      || !validText(raw.source)
      || !validText(raw.impact)
      || !validText(raw.recommendation)) {
      return { status: 'invalid', output: null, error: `findings[${index}] 值非法` };
    }
    findings.push({
      id: findingId(axis, raw.file as string, raw.line as number | null, raw.title as string),
      axis,
      severity: raw.severity as FindingSeverity,
      file: raw.file as string,
      line: raw.line as number | null,
      title: raw.title as string,
      evidence: raw.evidence as string,
      source: raw.source as string,
      impact: raw.impact as string,
      recommendation: raw.recommendation as string,
    });
  }
  return {
    status: 'valid',
    output: { summary: value.summary as string, findings },
    error: null,
  };
}

export type ModelFailureReason =
  | 'input-too-large'
  | 'provider-error'
  | 'invalid-output';

export type CopilotModelResult =
  | {
      status: 'valid';
      output: ReviewModelOutput;
      error: null;
      model: string;
      premiumRequests: number;
    }
  | {
      status: 'invalid';
      output: null;
      error: string;
      reason: ModelFailureReason;
      model?: string;
      premiumRequests?: number;
    };

export interface CopilotProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CopilotProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  spawnError: string | null;
}

export type CopilotProcessRunner = (
  command: string,
  args: string[],
  opts: CopilotProcessOptions,
) => Promise<CopilotProcessResult>;

const COPILOT_AGENT_ID = 'coding-x-review';
const COPILOT_PROFILE_LIMIT = 30_000;
const COPILOT_USER_PROMPT_LIMIT = 96_000;
const COPILOT_OUTPUT_LIMIT = 12 * 1024 * 1024;
const COPILOT_VERSION_OUTPUT_LIMIT = 64 * 1024;
const COPILOT_VERSION_TIMEOUT_MS = 20_000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._/-]{1,128}$/;
const verifiedCopilotVersions = new Set<string>();

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  child.kill(signal);
}

export const runCopilotProcess: CopilotProcessRunner = (
  command,
  args,
  opts,
) => new Promise((resolve) => {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;
  let outputExceeded = false;
  let spawnError: string | null = null;
  let settled = false;
  let forceTimer: NodeJS.Timeout | null = null;
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stop = () => {
    terminateProcessTree(child, 'SIGTERM');
    forceTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 2_000);
    forceTimer.unref();
  };
  const append = (target: Buffer[], chunk: Buffer) => {
    if (outputExceeded) return;
    outputBytes += chunk.length;
    if (outputBytes > opts.maxOutputBytes) {
      outputExceeded = true;
      stop();
      return;
    }
    target.push(chunk);
  };
  child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk));
  child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk));
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, opts.timeoutMs);
  const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    resolve({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      outputExceeded,
      spawnError,
    });
  };
  child.once('error', (error) => {
    spawnError = error.message;
    finish(null, null);
  });
  child.once('close', finish);
});

function copilotEnvironment(token: string, copilotHome: string): NodeJS.ProcessEnv {
  const passthrough = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'GITHUB_ACTIONS',
    'GITHUB_SERVER_URL',
    'GITHUB_API_URL',
    'GITHUB_GRAPHQL_URL',
    'RUNNER_OS',
    'RUNNER_ARCH',
    'CI',
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of passthrough) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    GITHUB_TOKEN: token,
    COPILOT_GITHUB_TOKEN: token,
    COPILOT_HOME: copilotHome,
    NO_COLOR: '1',
    CLICOLOR: '0',
  };
}

async function verifyCopilotVersion(opts: {
  command: string;
  cliVersion: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runImpl: CopilotProcessRunner;
}): Promise<string | null> {
  const cacheKey = `${opts.command}\0${opts.cliVersion}`;
  if (opts.runImpl === runCopilotProcess && verifiedCopilotVersions.has(cacheKey)) {
    return null;
  }
  const result = await opts.runImpl(opts.command, ['--version'], {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: COPILOT_VERSION_TIMEOUT_MS,
    maxOutputBytes: COPILOT_VERSION_OUTPUT_LIMIT,
  });
  if (result.spawnError) return `无法启动 Copilot CLI：${result.spawnError}`;
  if (result.timedOut) return 'Copilot CLI 版本核验超时';
  if (result.outputExceeded) return 'Copilot CLI 版本输出超过上限';
  if (result.exitCode !== 0) return `Copilot CLI 版本核验退出 ${result.exitCode ?? 'unknown'}`;
  const actual = /GitHub Copilot CLI\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)/u
    .exec(result.stdout)?.[1];
  if (!actual) return 'Copilot CLI 版本输出无法识别';
  if (actual !== opts.cliVersion) {
    return `Copilot CLI 版本不匹配：期望 ${opts.cliVersion}，实际 ${actual}`;
  }
  if (opts.runImpl === runCopilotProcess) verifiedCopilotVersions.add(cacheKey);
  return null;
}

function exactJsonFromAssistant(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? null;
}

interface CopilotJsonEvent {
  type?: unknown;
  data?: unknown;
  exitCode?: unknown;
  usage?: unknown;
}

interface CopilotAssistantData {
  content?: unknown;
  model?: unknown;
  toolRequests?: unknown;
}

export function parseCopilotJsonl(
  stdout: string,
  requestedModel: string,
  axis: ReviewAxis,
): CopilotModelResult {
  const assistantMessages: CopilotAssistantData[] = [];
  const results: CopilotJsonEvent[] = [];
  const autoModels = new Set<string>();
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let event: CopilotJsonEvent;
    try {
      event = JSON.parse(line) as CopilotJsonEvent;
    } catch {
      return {
        status: 'invalid',
        output: null,
        error: `Copilot CLI JSONL 第 ${index + 1} 行损坏`,
        reason: 'invalid-output',
      };
    }
    if (event.type === 'assistant.message' && isRecord(event.data)) {
      assistantMessages.push(event.data as CopilotAssistantData);
    }
    if (event.type === 'session.auto_mode_resolved' && isRecord(event.data)) {
      const chosen = event.data.chosenModel;
      if (typeof chosen === 'string' && chosen.trim() !== '') autoModels.add(chosen);
    }
    if (event.type === 'result') results.push(event);
  }
  if (assistantMessages.length !== 1 || results.length !== 1) {
    return {
      status: 'invalid',
      output: null,
      error: 'Copilot CLI 必须且只能返回一个最终回复与一个 result',
      reason: 'invalid-output',
    };
  }
  const result = results[0];
  const usage = isRecord(result.usage) ? result.usage : null;
  const premiumRequests = usage
    && typeof usage.premiumRequests === 'number'
    && Number.isFinite(usage.premiumRequests)
    && usage.premiumRequests >= 0
    ? usage.premiumRequests
    : null;
  const message = assistantMessages[0];
  const actualModel = typeof message.model === 'string' && message.model.trim() !== ''
    ? message.model
    : null;
  if (premiumRequests === null) {
    return {
      status: 'invalid',
      output: null,
      error: 'Copilot CLI result 缺少有效的 premiumRequests 用量',
      reason: 'invalid-output',
      ...(actualModel && MODEL_ID_PATTERN.test(actualModel) ? { model: actualModel } : {}),
    };
  }
  if (result.exitCode !== 0) {
    return {
      status: 'invalid',
      output: null,
      error: `Copilot CLI result 退出 ${String(result.exitCode)}`,
      reason: 'provider-error',
      ...(actualModel ? { model: actualModel } : {}),
      premiumRequests,
    };
  }
  if (!actualModel || !MODEL_ID_PATTERN.test(actualModel)) {
    return {
      status: 'invalid',
      output: null,
      error: 'Copilot CLI 最终回复缺少安全、可识别的实际模型身份',
      reason: 'invalid-output',
      premiumRequests,
    };
  }
  if (requestedModel === 'auto') {
    if (autoModels.size !== 1 || !autoModels.has(actualModel)) {
      return {
        status: 'invalid',
        output: null,
        error: 'Copilot CLI auto 路由身份与最终回复不一致',
        reason: 'invalid-output',
        model: actualModel,
        premiumRequests,
      };
    }
  } else if (actualModel !== requestedModel) {
    return {
      status: 'invalid',
      output: null,
      error: `Copilot CLI 模型不匹配：期望 ${requestedModel}，实际 ${actualModel}`,
      reason: 'invalid-output',
      model: actualModel,
      premiumRequests,
    };
  }
  if (!Array.isArray(message.toolRequests) || message.toolRequests.length !== 0) {
    return {
      status: 'invalid',
      output: null,
      error: 'Copilot CLI 评审器请求了被禁止的工具',
      reason: 'invalid-output',
      model: actualModel,
      premiumRequests,
    };
  }
  if (typeof message.content !== 'string') {
    return {
      status: 'invalid',
      output: null,
      error: 'Copilot CLI 最终回复缺少文本 content',
      reason: 'invalid-output',
      model: actualModel,
      premiumRequests,
    };
  }
  const json = exactJsonFromAssistant(message.content);
  if (!json) {
    return {
      status: 'invalid',
      output: null,
      error: 'Copilot CLI content 不是单个 JSON 对象',
      reason: 'invalid-output',
      model: actualModel,
      premiumRequests,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      status: 'invalid',
      output: null,
      error: 'Copilot CLI content 不是有效 JSON',
      reason: 'invalid-output',
      model: actualModel,
      premiumRequests,
    };
  }
  const normalized = normalizeReviewModelOutput(parsed, axis);
  return normalized.status === 'valid'
    ? {
        ...normalized,
        model: actualModel,
        premiumRequests,
      }
    : {
        ...normalized,
        reason: 'invalid-output',
        model: actualModel,
        premiumRequests,
      };
}

export async function callCopilotModel(opts: {
  token: string;
  model: string;
  cliVersion: string;
  systemPrompt: string;
  userPrompt: string;
  axis: ReviewAxis;
  command?: string;
  runImpl?: CopilotProcessRunner;
  timeoutMs?: number;
}): Promise<CopilotModelResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const runImpl = opts.runImpl ?? runCopilotProcess;
  const command = opts.command ?? 'copilot';
  if (!MODEL_ID_PATTERN.test(opts.model)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(opts.cliVersion)) {
    return {
      status: 'invalid',
      output: null,
      error: 'Copilot CLI 模型或版本配置非法',
      reason: 'provider-error',
    };
  }
  if (opts.systemPrompt.length > COPILOT_PROFILE_LIMIT) {
    return {
      status: 'invalid',
      output: null,
      error: `可信评审指令超过 Copilot custom agent 的 ${COPILOT_PROFILE_LIMIT} 字符上限`,
      reason: 'input-too-large',
    };
  }
  if (opts.userPrompt.length > COPILOT_USER_PROMPT_LIMIT) {
    return {
      status: 'invalid',
      output: null,
      error: `评审数据超过 Copilot CLI 的 ${COPILOT_USER_PROMPT_LIMIT} 字符上限`,
      reason: 'input-too-large',
    };
  }
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'coding-x-copilot-'));
  try {
    const projectRoot = join(runtimeRoot, 'trusted-project');
    const copilotHome = join(runtimeRoot, 'copilot-home');
    mkdirSync(join(projectRoot, '.github', 'agents'), { recursive: true });
    mkdirSync(copilotHome, { recursive: true });
    execFileSync('git', ['init', '--quiet', projectRoot], { stdio: 'ignore' });
    const profile = [
      '---',
      `name: ${COPILOT_AGENT_ID}`,
      'description: Trusted read-only coding-x quality reviewer',
      'tools: []',
      'infer: false',
      '---',
      '',
      opts.systemPrompt,
      '',
    ].join('\n');
    writeFileSync(
      join(projectRoot, '.github', 'agents', `${COPILOT_AGENT_ID}.agent.md`),
      profile,
      { encoding: 'utf8', mode: 0o600 },
    );
    const env = copilotEnvironment(opts.token, copilotHome);
    const versionError = await verifyCopilotVersion({
      command,
      cliVersion: opts.cliVersion,
      cwd: projectRoot,
      env,
      runImpl,
    });
    if (versionError) {
      return {
        status: 'invalid',
        output: null,
        error: versionError,
        reason: 'provider-error',
      };
    }
    const result = await runImpl(command, [
      '-C', projectRoot,
      '-p', opts.userPrompt,
      `--agent=${COPILOT_AGENT_ID}`,
      '--model', opts.model,
      '--available-tools=',
      '--disable-builtin-mcps',
      '--no-custom-instructions',
      '--no-ask-user',
      '--no-remote',
      '--no-remote-export',
      '--no-auto-update',
      '--no-color',
      '--no-experimental',
      '--no-mouse',
      '--output-format=json',
      '--log-level=none',
      '--disallow-temp-dir',
      '--max-autopilot-continues=0',
      '--max-ai-credits=30',
    ], {
      cwd: projectRoot,
      env,
      timeoutMs,
      maxOutputBytes: COPILOT_OUTPUT_LIMIT,
    });
    if (result.spawnError) {
      return {
        status: 'invalid',
        output: null,
        error: `无法启动 Copilot CLI：${result.spawnError}`,
        reason: 'provider-error',
      };
    }
    if (result.timedOut) {
      return {
        status: 'invalid',
        output: null,
        error: `Copilot CLI 评审调用超过 ${timeoutMs} 毫秒时限`,
        reason: 'provider-error',
      };
    }
    if (result.outputExceeded) {
      return {
        status: 'invalid',
        output: null,
        error: `Copilot CLI 输出超过 ${COPILOT_OUTPUT_LIMIT} 字节上限`,
        reason: 'invalid-output',
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: 'invalid',
        output: null,
        error: `Copilot CLI 进程退出 ${result.exitCode ?? result.signal ?? 'unknown'}`,
        reason: 'provider-error',
      };
    }
    return parseCopilotJsonl(result.stdout, opts.model, opts.axis);
  } catch (error) {
    return {
      status: 'invalid',
      output: null,
      error: error instanceof Error ? error.message : String(error),
      reason: 'provider-error',
    };
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

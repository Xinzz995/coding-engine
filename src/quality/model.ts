import { createHash } from 'node:crypto';
import { isAbsolute, normalize, sep } from 'node:path';
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
const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL_MAX_ATTEMPTS = 5;
const MAX_MODEL_RETRY_DELAY_MS = 30_000;
const MODEL_RETRY_BASE_DELAY_MS = 2_000;

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

interface GitHubModelsResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export type ModelFailureReason =
  | 'input-too-large'
  | 'provider-error'
  | 'invalid-output';

export type GitHubModelResult =
  | { status: 'valid'; output: ReviewModelOutput; error: null }
  | {
      status: 'invalid';
      output: null;
      error: string;
      reason: ModelFailureReason;
    };

function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

function modelRetryDelayMs(
  response: Response,
  attempt: number,
  nowMs: number,
  random: () => number,
): number {
  const providerDelay = retryAfterMs(response.headers.get('retry-after'), nowMs);
  const fallback = MODEL_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
  const base = Math.min(providerDelay ?? fallback, MAX_MODEL_RETRY_DELAY_MS);
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * 500);
  return Math.min(base + jitter, MAX_MODEL_RETRY_DELAY_MS);
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const complete = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(complete, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function callGitHubModel(opts: {
  token: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  axis: ReviewAxis;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
  nowImpl?: () => number;
  randomImpl?: () => number;
}): Promise<GitHubModelResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const requestedAttempts = opts.maxAttempts ?? DEFAULT_MODEL_MAX_ATTEMPTS;
  const maxAttempts = Number.isInteger(requestedAttempts) && requestedAttempts > 0
    ? Math.min(8, requestedAttempts)
    : DEFAULT_MODEL_MAX_ATTEMPTS;
  const sleepImpl = opts.sleepImpl ?? sleepWithAbort;
  const nowImpl = opts.nowImpl ?? Date.now;
  const randomImpl = opts.randomImpl ?? Math.random;
  const controller = new AbortController();
  const deadline = nowImpl() + timeoutMs;
  const timer = setTimeout(
    () => controller.abort(new Error(`GitHub Models 调用超过 ${timeoutMs} 毫秒总时限`)),
    timeoutMs,
  );
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetchImpl('https://models.github.ai/inference/chat/completions', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: opts.systemPrompt },
            { role: 'user', content: opts.userPrompt },
          ],
          temperature: 0,
          max_tokens: 4_000,
          response_format: reviewResponseSchema,
        }),
        signal: controller.signal,
      });
      if (response.ok) {
        const envelope = await response.json() as GitHubModelsResponse;
        const content = envelope.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          return {
            status: 'invalid',
            output: null,
            error: 'GitHub Models 响应缺少文本 content',
            reason: 'invalid-output',
          };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          return {
            status: 'invalid',
            output: null,
            error: 'GitHub Models content 不是 JSON',
            reason: 'invalid-output',
          };
        }
        const normalized = normalizeReviewModelOutput(parsed, opts.axis);
        return normalized.status === 'valid'
          ? normalized
          : { ...normalized, reason: 'invalid-output' };
      }
      const diagnostic = (await response.text()).slice(0, 1000);
      if (response.status === 429 && attempt < maxAttempts) {
        const delayMs = modelRetryDelayMs(response, attempt, nowImpl(), randomImpl);
        if (nowImpl() + delayMs >= deadline) {
          return {
            status: 'invalid',
            output: null,
            error: `GitHub Models HTTP 429：重试等待将超过 ${timeoutMs} 毫秒总时限`,
            reason: 'provider-error',
          };
        }
        await sleepImpl(delayMs, controller.signal);
        continue;
      }
      return {
        status: 'invalid',
        output: null,
        error: `GitHub Models HTTP ${response.status}${diagnostic ? `：${diagnostic}` : ''}${
          response.status === 429 && attempt > 1 ? `（${attempt} 次尝试后）` : ''
        }`,
        reason: response.status === 413 && diagnostic.includes('tokens_limit_reached')
          ? 'input-too-large'
          : 'provider-error',
      };
    }
    return {
      status: 'invalid',
      output: null,
      error: 'GitHub Models 重试状态异常',
      reason: 'provider-error',
    };
  } catch (error) {
    return {
      status: 'invalid',
      output: null,
      error: error instanceof Error ? error.message : String(error),
      reason: 'provider-error',
    };
  } finally {
    clearTimeout(timer);
  }
}

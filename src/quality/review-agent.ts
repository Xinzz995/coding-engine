import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { forceKillProcessTreeOnExit, terminateProcessTree } from '../engine/process-tree.js';
import { resolveBinary, type AgentKind } from '../engine/agent.js';
import { reviewResponseSchema, normalizeReviewModelOutput } from './model.js';
import type { ReviewAxis, ReviewModelOutput } from './types.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function buildReadOnlyReviewArgs(
  kind: AgentKind,
  prompt: string,
  files: { schemaPath: string; outputPath: string },
  model?: string,
): string[] {
  const modelArgs = model ? ['--model', model] : [];
  if (kind === 'codex') {
    return [
      'exec',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--color', 'never',
      '--output-schema', files.schemaPath,
      '--output-last-message', files.outputPath,
      ...modelArgs,
      prompt,
    ];
  }
  if (kind === 'claude') {
    return [
      '--print',
      '--permission-mode', 'plan',
      '--no-session-persistence',
      '--output-format', 'text',
      '--json-schema', JSON.stringify(reviewResponseSchema.json_schema.schema),
      ...modelArgs,
      prompt,
    ];
  }
  return ['--print', '--mode', 'plan', '--output-format', 'text', ...modelArgs, prompt];
}
function parseAgentText(
  raw: string,
  axis: ReviewAxis,
): ReturnType<typeof normalizeReviewModelOutput> {
  const trimmed = raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (!fenced) return { status: 'invalid', output: null, error: '只读 reviewer 未返回纯 JSON' };
    try {
      value = JSON.parse(fenced[1]);
    } catch {
      return { status: 'invalid', output: null, error: '只读 reviewer JSON 无法解析' };
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.structured_output !== undefined) value = record.structured_output;
    else if (typeof record.result === 'string') {
      try {
        value = JSON.parse(record.result);
      } catch {
        // Let the strict output validator return the bounded error.
      }
    }
  }
  return normalizeReviewModelOutput(value, axis);
}

export async function runReadOnlyReviewAgent(opts: {
  kind: AgentKind;
  axis: ReviewAxis;
  prompt: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
}): Promise<
  | { status: 'valid'; output: ReviewModelOutput; error: null; durationMs: number }
  | { status: 'invalid'; output: null; error: string; durationMs: number }
> {
  const temp = mkdtempSync(join(tmpdir(), 'coding-x-review-'));
  const schemaPath = join(temp, 'schema.json');
  const outputPath = join(temp, 'output.json');
  writeFileSync(schemaPath, JSON.stringify(reviewResponseSchema.json_schema.schema));
  const binary = resolveBinary(opts.kind);
  const commandParts = binary.split(' ');
  const command = commandParts[0];
  const args = [
    ...commandParts.slice(1),
    ...buildReadOnlyReviewArgs(opts.kind, opts.prompt, { schemaPath, outputPath }, opts.model),
  ];
  const started = Date.now();
  try {
    const result = await new Promise<{
      timedOut: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      overflow: boolean;
    }>((resolve) => {
      const child = spawn(command, args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let overflow = false;
      let settled = false;
      let terminating = false;
      const collect = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString();
        if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
          overflow = true;
          return next.slice(-MAX_OUTPUT_BYTES);
        }
        return next;
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); });
      const killOnExit = () => forceKillProcessTreeOnExit(child);
      process.once('exit', killOnExit);
      const finish = (timedOut: boolean, exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.removeListener('exit', killOnExit);
        resolve({ timedOut, exitCode, stdout, stderr, overflow });
      };
      const timer = setTimeout(() => {
        if (settled || terminating) return;
        terminating = true;
        void terminateProcessTree(child).then(() => finish(true, null), () => finish(true, null));
      }, opts.timeoutMs ?? 20 * 60 * 1000);
      child.once('close', (code) => {
        if (!terminating) finish(false, code);
      });
      child.once('error', (error) => {
        stderr = collect(stderr, Buffer.from(error.message));
        finish(false, null);
      });
    });
    const durationMs = Date.now() - started;
    if (result.timedOut) {
      return { status: 'invalid', output: null, error: '只读 reviewer 超时', durationMs };
    }
    if (result.exitCode !== 0) {
      return {
        status: 'invalid',
        output: null,
        error: `只读 reviewer 退出 ${result.exitCode ?? 'unavailable'}：${result.stderr.slice(-1000)}`,
        durationMs,
      };
    }
    if (result.overflow) {
      return { status: 'invalid', output: null, error: '只读 reviewer 输出超过 1 MiB', durationMs };
    }
    let raw = result.stdout;
    try {
      raw = readFileSync(outputPath, 'utf8');
    } catch {
      // Codex writes outputPath; Claude/Cursor return stdout.
    }
    const parsed = parseAgentText(raw, opts.axis);
    return parsed.status === 'valid'
      ? { ...parsed, durationMs }
      : { ...parsed, durationMs };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

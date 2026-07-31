import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { WorkspaceSafetyError } from './types.js';

export interface WindowsPathAttributeTransportOptions {
  readonly executablePath: string;
  readonly helperDigest: string;
  readonly requestBytes: Buffer;
  readonly maxResponseBytes: number;
}

const HELPER_FAILURE_STAGES = new Set([
  'startup',
  'executable-digest',
  'request-read',
  'request-parse',
  'paths-read',
  'tree-root',
  'canonical-name-enumeration',
  'workspace-child-enumeration',
  'safety-child-enumeration',
  'response-write',
]);

function invalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError(
    'invalid',
    `Invalid Windows path attribute transport: ${message}`,
  );
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function boundedHelperFailureStage(stderr: Buffer): string {
  if (stderr.byteLength === 0 || stderr.byteLength > 1024) return 'unavailable';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stderr).trim();
  } catch {
    return 'unavailable';
  }
  const match = /^CXWPI_FAILURE_V1 stage=([a-z-]+) code=incomplete$/u.exec(text);
  return match && HELPER_FAILURE_STAGES.has(match[1]) ? match[1] : 'unavailable';
}

function environmentValue(name: 'systemroot' | 'temp' | 'tmp'): string {
  const keys = Object.keys(process.env).filter((key) => key.toLowerCase() === name);
  if (keys.length !== 1) throw invalid(`required ${name} environment value is ambiguous`);
  const value = process.env[keys[0]];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !win32.isAbsolute(value)
  ) {
    throw invalid(`required ${name} environment value is unavailable`);
  }
  return value;
}

export function invokeWindowsPathAttributeHelper(
  options: WindowsPathAttributeTransportOptions,
): Buffer {
  if (process.platform !== 'win32') {
    throw new WorkspaceSafetyError('unsupported', 'Windows path attributes require Windows');
  }
  const systemRoot = environmentValue('systemroot');
  const temp = environmentValue('temp');
  const tmp = environmentValue('tmp');
  const startedAt = Date.now();
  const result = spawnSync(
    options.executablePath,
    ['--expected-helper-digest', options.helperDigest],
    {
      cwd: win32.dirname(options.executablePath),
      env: { SystemRoot: systemRoot, TEMP: temp, TMP: tmp },
      input: options.requestBytes,
      encoding: 'buffer',
      maxBuffer: options.maxResponseBytes,
      timeout: 60_000,
      windowsHide: true,
      shell: false,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  const stage = boundedHelperFailureStage(stderr);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? 'unknown';
    throw invalid(
      `fixed helper execution failed (code ${code}, stage ${stage}, elapsed ${elapsedMs}ms)`,
      result.error,
    );
  }
  if (result.status !== 0 || result.signal !== null) {
    throw invalid(
      `fixed helper did not return a complete proof (status ${String(result.status)}, signal ${String(result.signal)}, stage ${stage}, elapsed ${elapsedMs}ms)`,
    );
  }
  return Buffer.from(result.stdout);
}

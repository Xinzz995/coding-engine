import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { WorkspaceSafetyError } from './types.js';

export interface WindowsPathAttributeTransportOptions {
  readonly helperPath: string;
  readonly sourcePath: string;
  readonly helperDigest: string;
  readonly requestBytes: Buffer;
  readonly maxResponseBytes: number;
}

function invalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError(
    'invalid',
    `Invalid Windows path attribute transport: ${message}`,
  );
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
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
  const command = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(
    command,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      options.helperPath,
      '-ExpectedHelperDigest',
      options.helperDigest,
      '-SourcePath',
      options.sourcePath,
    ],
    {
      cwd: win32.dirname(options.helperPath),
      env: { SystemRoot: systemRoot, TEMP: temp, TMP: tmp },
      input: options.requestBytes,
      encoding: 'buffer',
      maxBuffer: options.maxResponseBytes,
      timeout: 60_000,
      windowsHide: true,
      shell: false,
    },
  );
  if (result.error) throw invalid('fixed helper execution failed', result.error);
  if (result.status !== 0 || result.signal !== null) {
    throw invalid('fixed helper did not return a complete proof');
  }
  return Buffer.from(result.stdout);
}

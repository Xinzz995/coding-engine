import { uptime } from 'node:os';
import { win32 } from 'node:path';
import { WorkspaceSafetyError } from './types.js';

export const WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS = 60_000;

export interface WindowsIdentityPowerShellLaunch {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface WindowsIdentitySnapshotRecord {
  readonly hostIdentity: string;
  readonly bootIdentity: string;
  readonly processStatus: 'found' | 'missing' | 'unknown';
  readonly processValue: string | null;
}

export function resolveWindowsIdentityPowerShellLaunch(
  environment: NodeJS.ProcessEnv = process.env,
): WindowsIdentityPowerShellLaunch {
  const keys = Object.keys(environment).filter(
    (candidate) => candidate.toLowerCase() === 'systemroot',
  );
  if (keys.length !== 1) {
    throw new WorkspaceSafetyError('unsupported', 'Windows SystemRoot is unavailable or ambiguous');
  }
  const systemRoot = environment[keys[0]];
  if (
    typeof systemRoot !== 'string' ||
    systemRoot.length === 0 ||
    systemRoot.includes('\0') ||
    !win32.isAbsolute(systemRoot)
  ) {
    throw new WorkspaceSafetyError('unsupported', 'Windows SystemRoot is invalid');
  }
  const normalizedRoot = win32.normalize(systemRoot);
  const powerShellHome = win32.join(normalizedRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  return {
    command: win32.join(powerShellHome, 'powershell.exe'),
    env: {
      SystemRoot: normalizedRoot,
      windir: normalizedRoot,
      PSModulePath: win32.join(powerShellHome, 'Modules'),
    },
  };
}

export function resolveWindowsPowerShellPath(environment: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsIdentityPowerShellLaunch(environment).command;
}

export const WINDOWS_IDENTITY_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$targetProcessId = 0',
  '$rawProcessId = [Environment]::GetEnvironmentVariable("CODING_X_WINDOWS_IDENTITY_PID", "Process")',
  'if (-not [int]::TryParse($rawProcessId, [ref]$targetProcessId) -or $targetProcessId -le 0) { exit 6 }',
  '$processStatus = "missing"',
  '$processValue = $null',
  '$target = Get-Process -Id $targetProcessId -ErrorAction SilentlyContinue',
  'if ($null -ne $target) {',
  '  try {',
  '    $processValue = $target.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)',
  '    $processStatus = "found"',
  '  } catch { $processStatus = "unknown" }',
  '}',
  '$bootIdentity = (Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime).LastBootUpTime.ToUniversalTime().ToString("O")',
  '$hostIdentity = [string](Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid',
  '[Console]::Out.Write((@{ processStatus = $processStatus; processValue = $processValue; bootIdentity = $bootIdentity; hostIdentity = $hostIdentity } | ConvertTo-Json -Compress))',
].join('\n');

export function parseWindowsIdentitySnapshotOutput(output: string): WindowsIdentitySnapshotRecord {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new WorkspaceSafetyError('unsupported', 'Windows identity snapshot is malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceSafetyError('unsupported', 'Windows identity snapshot is malformed');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.hostIdentity !== 'string' ||
    typeof record.bootIdentity !== 'string' ||
    typeof record.processStatus !== 'string' ||
    !['found', 'missing', 'unknown'].includes(record.processStatus) ||
    (record.processStatus === 'found' &&
      (typeof record.processValue !== 'string' || !/^\d+$/u.test(record.processValue))) ||
    (record.processStatus !== 'found' && record.processValue !== null)
  ) {
    throw new WorkspaceSafetyError('unsupported', 'Windows identity snapshot is malformed');
  }
  return record as unknown as WindowsIdentitySnapshotRecord;
}

export function validateWindowsBootIdentity(value: string): string {
  const bootTime = Date.parse(value);
  const uptimeDerived = Date.now() - uptime() * 1000;
  if (!Number.isFinite(bootTime) || Math.abs(bootTime - uptimeDerived) > 120_000) {
    throw new WorkspaceSafetyError('unsupported', 'Windows boot identity sources disagree');
  }
  return value;
}

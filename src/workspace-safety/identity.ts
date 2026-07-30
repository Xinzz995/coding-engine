import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  IdentityProbe,
  IdentityVerdict,
  OwnerRecord,
  ProcessIdentityKind,
  ProcessIdentitySnapshot,
} from './types.js';
import { WorkspaceSafetyError } from './types.js';
import { MAX_SAFETY_STRING_LENGTH } from './schema.js';

export type SupportedIdentityPlatform = 'linux' | 'darwin' | 'win32';

export type ProcessIdentityLookup =
  { status: 'found'; value: string } | { status: 'missing' } | { status: 'unknown' };

export interface IdentityProbeAdapter {
  platform: SupportedIdentityPlatform;
  pid: number;
  readHostIdentity(): string;
  readBootIdentity(): string;
  readProcessIdentity(pid: number): ProcessIdentityLookup;
  readIdentitySnapshot?(pid: number): {
    readonly hostIdentity: string;
    readonly bootIdentity: string;
    readonly processIdentity: ProcessIdentityLookup;
  };
}

const KIND_BY_PLATFORM: Record<SupportedIdentityPlatform, ProcessIdentityKind> = {
  linux: 'linux-boot-start',
  darwin: 'macos-boot-start',
  win32: 'windows-filetime',
};

export const PLATFORM_IDENTITY_HASH_DOMAINS = {
  host: 'coding-x-workspace-host-v1\0',
  boot: 'coding-x-workspace-boot-v1\0',
} as const;

function boundedRawIdentity(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_SAFETY_STRING_LENGTH) {
    throw new WorkspaceSafetyError('unsupported', `${name} is unavailable or unbounded`);
  }
  return normalized;
}

export function hashPlatformIdentity(domain: 'host' | 'boot', value: string): string {
  const normalized = boundedRawIdentity(value, `${domain} identity`);
  return `sha256:${createHash('sha256')
    .update(PLATFORM_IDENTITY_HASH_DOMAINS[domain], 'utf8')
    .update(normalized, 'utf8')
    .digest('hex')}`;
}

function readIdentitySnapshot(
  adapter: IdentityProbeAdapter,
  pid: number,
):
  | {
      readonly hostIdentity: string;
      readonly bootIdentity: string;
      readonly processIdentity: ProcessIdentityLookup;
    }
  | undefined {
  return adapter.readIdentitySnapshot?.(pid);
}

function currentSnapshot(adapter: IdentityProbeAdapter): ProcessIdentitySnapshot {
  const observed = readIdentitySnapshot(adapter, adapter.pid);
  const processIdentity = observed?.processIdentity ?? adapter.readProcessIdentity(adapter.pid);
  if (processIdentity.status !== 'found') {
    throw new WorkspaceSafetyError('unsupported', 'Current process identity is unavailable');
  }
  return {
    pid: adapter.pid,
    processIdentity: {
      kind: KIND_BY_PLATFORM[adapter.platform],
      value: boundedRawIdentity(processIdentity.value, 'process identity'),
    },
    bootIdentity: hashPlatformIdentity(
      'boot',
      observed?.bootIdentity ?? adapter.readBootIdentity(),
    ),
    hostId: hashPlatformIdentity('host', observed?.hostIdentity ?? adapter.readHostIdentity()),
  };
}

function probeRecord(adapter: IdentityProbeAdapter, record: OwnerRecord): IdentityVerdict {
  try {
    const expectedKind = KIND_BY_PLATFORM[adapter.platform];
    if (record.processIdentity.kind !== expectedKind) return 'unknown';

    const observed = readIdentitySnapshot(adapter, record.pid);
    const hostId = hashPlatformIdentity(
      'host',
      observed?.hostIdentity ?? adapter.readHostIdentity(),
    );
    if (hostId !== record.hostId) return 'unknown';

    const bootIdentity = hashPlatformIdentity(
      'boot',
      observed?.bootIdentity ?? adapter.readBootIdentity(),
    );
    if (bootIdentity !== record.bootIdentity) return 'dead';

    const processIdentity = observed?.processIdentity ?? adapter.readProcessIdentity(record.pid);
    if (processIdentity.status === 'missing') return 'dead';
    if (processIdentity.status === 'unknown') return 'unknown';
    const observedValue = boundedRawIdentity(processIdentity.value, 'process identity');
    if (observedValue !== record.processIdentity.value) return 'dead';

    // The first macOS implementation can only persist second-resolution start time.
    // Equality therefore cannot rule out PID reuse and must not authorize takeover.
    return adapter.platform === 'darwin' ? 'unknown' : 'alive';
  } catch {
    return 'unknown';
  }
}

export function createIdentityProbe(
  adapter: IdentityProbeAdapter = createSystemIdentityAdapter(),
): IdentityProbe {
  return {
    current: () => {
      try {
        return currentSnapshot(adapter);
      } catch (error) {
        if (error instanceof WorkspaceSafetyError) throw error;
        throw new WorkspaceSafetyError('unsupported', 'Platform identity sources are unavailable');
      }
    },
    probe: (record) => probeRecord(adapter, record),
  };
}

export interface ExactCurrentIdentityAuthority {
  readonly identity: ProcessIdentitySnapshot;
  readonly probeOwner: (owner: OwnerRecord) => IdentityVerdict;
  readonly verifyCurrent: () => void;
}

/**
 * Captures one OS identity and provides a fail-closed recheck bound to those exact bytes.
 * There is intentionally no adapter parameter: production recovery wrappers cannot inject it.
 */
export function captureExactCurrentIdentityAuthority(): ExactCurrentIdentityAuthority {
  const probe = createIdentityProbe();
  const identity = probe.current();
  return {
    identity,
    probeOwner: (owner) => probe.probe(owner),
    verifyCurrent: () => {
      const current = probe.current();
      if (
        current.pid !== identity.pid ||
        current.hostId !== identity.hostId ||
        current.bootIdentity !== identity.bootIdentity ||
        current.processIdentity.kind !== identity.processIdentity.kind ||
        current.processIdentity.value !== identity.processIdentity.value
      ) {
        throw new WorkspaceSafetyError('lease-lost', 'system process authority changed');
      }
    },
  };
}

export type SameHostRebootIdentityVerdict =
  'same-host-boot-changed' | 'platform-kind-mismatch' | 'foreign-host' | 'same-boot';

/** Pure platform-neutral comparison. It never authorizes a write by itself. */
export function classifySameHostRebootIdentity(
  sourceOwner: Pick<OwnerRecord, 'processIdentity' | 'bootIdentity' | 'hostId'>,
  current: Pick<ProcessIdentitySnapshot, 'processIdentity' | 'bootIdentity' | 'hostId'>,
): SameHostRebootIdentityVerdict {
  if (current.processIdentity.kind !== sourceOwner.processIdentity.kind) {
    return 'platform-kind-mismatch';
  }
  if (current.hostId !== sourceOwner.hostId) return 'foreign-host';
  if (current.bootIdentity === sourceOwner.bootIdentity) return 'same-boot';
  return 'same-host-boot-changed';
}

function readLinuxProcessIdentity(pid: number): ProcessIdentityLookup {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unknown' };
  }
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 2) return { status: 'unknown' };
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  if (!startTime || !/^\d+$/.test(startTime)) return { status: 'unknown' };
  return { status: 'found', value: startTime };
}

interface CommandResult {
  status: number | null;
  stdout: string;
  error?: Error;
}

export const POSIX_IDENTITY_COMMAND_TIMEOUT_MS = 5_000;
export const WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS = 30_000;

export interface WindowsIdentityPowerShellLaunch {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}

function probePidExistence(pid: number): 'present' | 'missing' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'missing';
    return 'unknown';
  }
}

function runCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: environment,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    error: result.error,
  };
}

function requireCommandText(command: string, args: string[], name: string): string {
  const result = runCommand(
    command,
    args,
    { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    POSIX_IDENTITY_COMMAND_TIMEOUT_MS,
  );
  if (result.error || result.status !== 0) {
    throw new WorkspaceSafetyError('unsupported', `${name} is unavailable`);
  }
  return boundedRawIdentity(result.stdout, name);
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

function runWindowsPowerShell(args: string[]): CommandResult {
  const launch = resolveWindowsIdentityPowerShellLaunch();
  return runCommand(
    launch.command,
    ['-NoLogo', '-NoProfile', '-NonInteractive', ...args],
    launch.env,
    WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
  );
}

function requireWindowsPowerShellText(args: string[], name: string): string {
  const result = runWindowsPowerShell(args);
  if (result.error || result.status !== 0) {
    throw new WorkspaceSafetyError('unsupported', `${name} is unavailable`);
  }
  return boundedRawIdentity(result.stdout, name);
}

function readDarwinProcessIdentity(pid: number): ProcessIdentityLookup {
  const result = runCommand(
    '/bin/ps',
    ['-p', String(pid), '-o', 'lstart='],
    { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    POSIX_IDENTITY_COMMAND_TIMEOUT_MS,
  );
  if (result.status === 1) {
    const existence = probePidExistence(pid);
    return existence === 'missing' ? { status: 'missing' } : { status: 'unknown' };
  }
  if (result.error || result.status !== 0) return { status: 'unknown' };
  const value = result.stdout.trim().replace(/\s+/g, ' ');
  return value ? { status: 'found', value } : { status: 'unknown' };
}

function readWindowsProcessIdentity(pid: number): ProcessIdentityLookup {
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { exit 3 }',
    'try { [Console]::Out.Write($p.StartTime.ToUniversalTime().ToFileTimeUtc()) } catch { exit 4 }',
  ].join('; ');
  const result = runWindowsPowerShell(['-Command', script]);
  if (result.status === 3) {
    const existence = probePidExistence(pid);
    return existence === 'missing' ? { status: 'missing' } : { status: 'unknown' };
  }
  if (result.error || result.status !== 0) return { status: 'unknown' };
  const value = result.stdout.trim();
  return /^\d+$/.test(value) ? { status: 'found', value } : { status: 'unknown' };
}

function readWindowsBootIdentity(): string {
  return validateWindowsBootIdentity(
    requireWindowsPowerShellText(
      [
        '-Command',
        '[Console]::Out.Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("O"))',
      ],
      'Windows boot identity',
    ),
  );
}

function validateWindowsBootIdentity(value: string): string {
  const bootTime = Date.parse(value);
  const uptimeDerived = Date.now() - uptime() * 1000;
  if (!Number.isFinite(bootTime) || Math.abs(bootTime - uptimeDerived) > 120_000) {
    throw new WorkspaceSafetyError('unsupported', 'Windows boot identity sources disagree');
  }
  return value;
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
  '$bootIdentity = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("O")',
  '$hostIdentity = [string](Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid',
  '[Console]::Out.Write((@{ processStatus = $processStatus; processValue = $processValue; bootIdentity = $bootIdentity; hostIdentity = $hostIdentity } | ConvertTo-Json -Compress))',
].join('\n');

export function parseWindowsIdentitySnapshotOutput(output: string): {
  readonly hostIdentity: string;
  readonly bootIdentity: string;
  readonly processStatus: 'found' | 'missing' | 'unknown';
  readonly processValue: string | null;
} {
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
  return record as ReturnType<typeof parseWindowsIdentitySnapshotOutput>;
}

function readWindowsIdentitySnapshot(pid: number): {
  readonly hostIdentity: string;
  readonly bootIdentity: string;
  readonly processIdentity: ProcessIdentityLookup;
} {
  const launch = resolveWindowsIdentityPowerShellLaunch();
  const result = runCommand(
    launch.command,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDENTITY_SNAPSHOT_SCRIPT],
    { ...launch.env, CODING_X_WINDOWS_IDENTITY_PID: String(pid) },
    WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
  );
  if (result.error || result.status !== 0) {
    throw new WorkspaceSafetyError('unsupported', 'Windows identity snapshot is unavailable');
  }
  const record = parseWindowsIdentitySnapshotOutput(result.stdout);
  let processIdentity: ProcessIdentityLookup;
  if (record.processStatus === 'found') {
    processIdentity = { status: 'found', value: record.processValue! };
  } else if (record.processStatus === 'unknown') {
    processIdentity = { status: 'unknown' };
  } else {
    const existence = probePidExistence(pid);
    processIdentity = existence === 'missing' ? { status: 'missing' } : { status: 'unknown' };
  }
  return {
    processIdentity,
    bootIdentity: validateWindowsBootIdentity(record.bootIdentity),
    hostIdentity: record.hostIdentity,
  };
}

export function createSystemIdentityAdapter(): IdentityProbeAdapter {
  if (process.platform === 'linux') {
    return {
      platform: 'linux',
      pid: process.pid,
      readHostIdentity: () => readFileSync('/etc/machine-id', 'utf8'),
      readBootIdentity: () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
      readProcessIdentity: readLinuxProcessIdentity,
    };
  }
  if (process.platform === 'darwin') {
    return {
      platform: 'darwin',
      pid: process.pid,
      readHostIdentity: () => {
        const output = requireCommandText(
          '/usr/sbin/ioreg',
          ['-rd1', '-c', 'IOPlatformExpertDevice'],
          'macOS host identity',
        );
        const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output);
        if (!match?.[1]) {
          throw new WorkspaceSafetyError('unsupported', 'macOS host identity is unavailable');
        }
        return match[1];
      },
      readBootIdentity: () =>
        requireCommandText(
          '/usr/sbin/sysctl',
          ['-n', 'kern.bootsessionuuid'],
          'macOS boot identity',
        ),
      readProcessIdentity: readDarwinProcessIdentity,
    };
  }
  if (process.platform === 'win32') {
    return {
      platform: 'win32',
      pid: process.pid,
      readHostIdentity: () =>
        requireWindowsPowerShellText(
          [
            '-Command',
            '[Console]::Out.Write((Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid)',
          ],
          'Windows host identity',
        ),
      readBootIdentity: readWindowsBootIdentity,
      readProcessIdentity: readWindowsProcessIdentity,
      readIdentitySnapshot: readWindowsIdentitySnapshot,
    };
  }
  throw new WorkspaceSafetyError(
    'unsupported',
    `Unsupported identity platform: ${process.platform}`,
  );
}

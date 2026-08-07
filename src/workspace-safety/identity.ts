import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import {
  readWindowsIdentitySnapshot,
  readWindowsProcessIdentity,
} from './windows-identity-transport.js';

export {
  parseWindowsIdentitySnapshotOutput,
  resolveWindowsIdentityPowerShellLaunch,
  resolveWindowsPowerShellPath,
  WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
  WINDOWS_IDENTITY_MAX_ATTEMPTS,
  WINDOWS_IDENTITY_SNAPSHOT_SCRIPT,
  WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS,
  type WindowsIdentityPowerShellLaunch,
} from './windows-identity-protocol.js';

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

export type ProcessIdentitySubject = Pick<
  OwnerRecord,
  'pid' | 'processIdentity' | 'bootIdentity' | 'hostId'
>;

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

function probeRecord(
  adapter: IdentityProbeAdapter,
  record: ProcessIdentitySubject,
): IdentityVerdict {
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
  readonly probeOwner: (owner: ProcessIdentitySubject) => IdentityVerdict;
  readonly verifyCurrent: () => void;
}

function cloneIdentitySnapshot(identity: ProcessIdentitySnapshot): ProcessIdentitySnapshot {
  return {
    pid: identity.pid,
    processIdentity: { ...identity.processIdentity },
    bootIdentity: identity.bootIdentity,
    hostId: identity.hostId,
  };
}

function probeRecordAgainstCapturedSystem(
  adapter: IdentityProbeAdapter,
  captured: ProcessIdentitySnapshot,
  record: ProcessIdentitySubject,
): IdentityVerdict {
  try {
    if (record.processIdentity.kind !== KIND_BY_PLATFORM[adapter.platform]) return 'unknown';
    if (record.hostId !== captured.hostId) return 'unknown';
    if (record.bootIdentity !== captured.bootIdentity) return 'dead';

    const processIdentity = adapter.readProcessIdentity(record.pid);
    if (processIdentity.status === 'missing') return 'dead';
    if (processIdentity.status === 'unknown') return 'unknown';
    const observedValue = boundedRawIdentity(processIdentity.value, 'process identity');
    if (observedValue !== record.processIdentity.value) return 'dead';
    return adapter.platform === 'darwin' ? 'unknown' : 'alive';
  } catch {
    return 'unknown';
  }
}

function verifyCapturedCurrentProcess(
  adapter: IdentityProbeAdapter,
  captured: ProcessIdentitySnapshot,
): void {
  try {
    const processIdentity = adapter.readProcessIdentity(captured.pid);
    if (
      adapter.pid === captured.pid &&
      captured.processIdentity.kind === KIND_BY_PLATFORM[adapter.platform] &&
      processIdentity.status === 'found' &&
      boundedRawIdentity(processIdentity.value, 'process identity') ===
        captured.processIdentity.value
    ) {
      return;
    }
  } catch {
    // Every read/parse failure loses authority below.
  }
  throw new WorkspaceSafetyError('lease-lost', 'system process authority changed');
}

/**
 * @internal Authority-controlled core exposed to deterministic tests only through the test seam.
 */
export function captureExactCurrentIdentityAuthorityControlled(
  adapter: IdentityProbeAdapter,
): ExactCurrentIdentityAuthority {
  const probe = createIdentityProbe(adapter);
  const captured = probe.current();
  const identity = cloneIdentitySnapshot(captured);

  if (adapter.platform === 'win32') {
    return {
      identity,
      probeOwner: (owner) => probeRecordAgainstCapturedSystem(adapter, captured, owner),
      verifyCurrent: () => verifyCapturedCurrentProcess(adapter, captured),
    };
  }

  return {
    identity,
    probeOwner: (owner) => probeRecord(adapter, owner),
    verifyCurrent: () => {
      const current = probe.current();
      if (
        current.pid !== captured.pid ||
        current.hostId !== captured.hostId ||
        current.bootIdentity !== captured.bootIdentity ||
        current.processIdentity.kind !== captured.processIdentity.kind ||
        current.processIdentity.value !== captured.processIdentity.value
      ) {
        throw new WorkspaceSafetyError('lease-lost', 'system process authority changed');
      }
    },
  };
}

/**
 * Captures one OS identity and provides a fail-closed recheck bound to those exact bytes.
 * There is intentionally no adapter parameter: production recovery wrappers cannot inject it.
 */
export function captureExactCurrentIdentityAuthority(): ExactCurrentIdentityAuthority {
  return captureExactCurrentIdentityAuthorityControlled(createSystemIdentityAdapter());
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
      readHostIdentity: () => readWindowsIdentitySnapshot(process.pid).hostIdentity,
      readBootIdentity: () => readWindowsIdentitySnapshot(process.pid).bootIdentity,
      readProcessIdentity: readWindowsProcessIdentity,
      readIdentitySnapshot: readWindowsIdentitySnapshot,
    };
  }
  throw new WorkspaceSafetyError(
    'unsupported',
    `Unsupported identity platform: ${process.platform}`,
  );
}

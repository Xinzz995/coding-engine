import { describe, expect, it } from 'vitest';
import type { OwnerRecord, ProcessIdentityKind } from './types.js';
import {
  createIdentityProbe,
  hashPlatformIdentity,
  resolveWindowsIdentityPowerShellLaunch,
  resolveWindowsPowerShellPath,
  type IdentityProbeAdapter,
} from './identity.js';
import { WorkspaceSafetyError } from './types.js';
import { MAX_SAFETY_STRING_LENGTH } from './schema.js';

const digest = `sha256:${'a'.repeat(64)}`;

function adapter(platform: IdentityProbeAdapter['platform'] = 'linux'): IdentityProbeAdapter {
  return {
    platform,
    pid: 100,
    readHostIdentity: () => 'host-a',
    readBootIdentity: () => 'boot-a',
    readProcessIdentity: (pid) =>
      pid === 100 ? { status: 'found', value: 'start-a' } : { status: 'missing' },
  };
}

function ownerFrom(
  probeAdapter: IdentityProbeAdapter,
  overrides: Partial<OwnerRecord> = {},
): OwnerRecord {
  const kind: ProcessIdentityKind =
    probeAdapter.platform === 'linux'
      ? 'linux-boot-start'
      : probeAdapter.platform === 'darwin'
        ? 'macos-boot-start'
        : 'windows-filetime';
  return {
    schemaVersion: 2,
    ownerId: '123e4567-e89b-42d3-a456-426614174000',
    pid: probeAdapter.pid,
    processIdentity: { kind, value: 'start-a' },
    bootIdentity: hashPlatformIdentity('boot', 'boot-a'),
    hostId: hashPlatformIdentity('host', 'host-a'),
    workspaceIdentity: digest,
    startedAt: '2026-07-30T00:00:00.000Z',
    command: 'run',
    ...overrides,
  };
}

describe('platform identity probe', () => {
  it('resolves Windows PowerShell from the system directory without consulting PATH or cwd', () => {
    const launch = resolveWindowsIdentityPowerShellLaunch({
      SystemRoot: 'D:\\Windows',
      PATH: 'C:\\project\\attacker-controlled',
      PSModulePath: 'C:\\project\\attacker-modules',
      PROJECT_SECRET: 'canary',
    });
    expect(launch).toEqual({
      command: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      env: {
        SystemRoot: 'D:\\Windows',
        windir: 'D:\\Windows',
        PSModulePath: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
      },
    });
    expect(JSON.stringify(launch)).not.toContain('attacker');
    expect(JSON.stringify(launch)).not.toContain('canary');
    expect(resolveWindowsPowerShellPath({ SystemRoot: 'D:\\Windows' })).toBe(launch.command);
  });

  it('fails closed when Windows SystemRoot is missing, relative, or ambiguous', () => {
    expect(() => resolveWindowsPowerShellPath({ PATH: 'C:\\project' })).toThrow(/SystemRoot/i);
    expect(() => resolveWindowsPowerShellPath({ SystemRoot: '.\\Windows' })).toThrow(/SystemRoot/i);
    expect(() =>
      resolveWindowsPowerShellPath({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Windows' }),
    ).toThrow(/ambiguous/i);
  });

  it('returns alive only for an exact Linux/Windows identity match', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const source = adapter(platform);
      expect(createIdentityProbe(source).probe(ownerFrom(source))).toBe('alive');
    }
  });

  it('returns dead when the pid is absent or has been reused', () => {
    const source = adapter();
    expect(
      createIdentityProbe({ ...source, readProcessIdentity: () => ({ status: 'missing' }) }).probe(
        ownerFrom(source),
      ),
    ).toBe('dead');
    expect(
      createIdentityProbe({
        ...source,
        readProcessIdentity: () => ({ status: 'found', value: 'new-start' }),
      }).probe(ownerFrom(source)),
    ).toBe('dead');
  });

  it('treats a reliable same-host reboot as proof that the old owner is dead', () => {
    const source = adapter();
    const currentBoot = { ...source, readBootIdentity: () => 'boot-b' };
    expect(createIdentityProbe(currentBoot).probe(ownerFrom(source))).toBe('dead');
  });

  it.each([
    ['foreign host', { readHostIdentity: () => 'host-b' }],
    ['permission/read error', { readProcessIdentity: () => ({ status: 'unknown' as const }) }],
    ['platform kind mismatch', {}],
  ])('returns unknown for %s', (label, overrides) => {
    const source = adapter();
    const record =
      label === 'platform kind mismatch'
        ? ownerFrom(source, {
            processIdentity: { kind: 'windows-filetime', value: 'start-a' },
          })
        : ownerFrom(source);
    expect(createIdentityProbe({ ...source, ...overrides }).probe(record)).toBe('unknown');
  });

  it('never turns adapter failures into dead', () => {
    const source = adapter();
    expect(
      createIdentityProbe({
        ...source,
        readBootIdentity: () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      }).probe(ownerFrom(source)),
    ).toBe('unknown');
  });

  it('keeps equal second-resolution macOS identities unknown but proves a different one dead', () => {
    const source = adapter('darwin');
    expect(createIdentityProbe(source).probe(ownerFrom(source))).toBe('unknown');
    expect(
      createIdentityProbe({
        ...source,
        readProcessIdentity: () => ({ status: 'found', value: 'start-b' }),
      }).probe(ownerFrom(source)),
    ).toBe('dead');
  });

  it('creates a bounded snapshot without retaining raw machine or boot identifiers', () => {
    const source = adapter();
    const snapshot = createIdentityProbe(source).current();
    expect(snapshot).toEqual({
      pid: 100,
      processIdentity: { kind: 'linux-boot-start', value: 'start-a' },
      bootIdentity: hashPlatformIdentity('boot', 'boot-a'),
      hostId: hashPlatformIdentity('host', 'host-a'),
    });
    expect(JSON.stringify(snapshot)).not.toContain('host-a');
    expect(JSON.stringify(snapshot)).not.toContain('boot-a');
  });

  it('freezes the raw platform identity length boundary', () => {
    expect(hashPlatformIdentity('host', 'x'.repeat(MAX_SAFETY_STRING_LENGTH))).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(() => hashPlatformIdentity('host', 'x'.repeat(MAX_SAFETY_STRING_LENGTH + 1))).toThrow(
      /unbounded/i,
    );
  });

  it('freezes domain-separated host and boot hash vectors', () => {
    expect(hashPlatformIdentity('host', 'host-a')).toBe(
      'sha256:66acfb2c2fe4b0079c46140a05a2faf74a44ac0f241d98c78deb674afe33b342',
    );
    expect(hashPlatformIdentity('boot', 'boot-a')).toBe(
      'sha256:3e8acef689fb1d4f033da9e8952b4cab1286b184f8a727b2a896b567c06c2bc2',
    );
  });

  it('fails current identity acquisition explicitly instead of returning a partial snapshot', () => {
    const source = adapter();
    let error: unknown;
    try {
      createIdentityProbe({
        ...source,
        readHostIdentity: () => {
          throw new Error('missing host source');
        },
      }).current();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceSafetyError);
    expect((error as WorkspaceSafetyError).code).toBe('unsupported');
  });

  it.runIf(['linux', 'darwin', 'win32'].includes(process.platform))(
    'round-trips the current process through the real platform probe',
    () => {
      const probe = createIdentityProbe();
      const current = probe.current();
      const record: OwnerRecord = {
        schemaVersion: 2,
        ownerId: '123e4567-e89b-42d3-a456-426614174000',
        ...current,
        workspaceIdentity: digest,
        startedAt: '2026-07-30T00:00:00.000Z',
        command: 'run',
      };
      expect(probe.probe(record)).toBe(process.platform === 'darwin' ? 'unknown' : 'alive');
    },
    20_000,
  );
});

import { cpSync, linkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWindowsSupervisorLaunch,
  readWindowsSupervisorAssets,
  WINDOWS_SUPERVISOR_SOURCES,
} from './windows-supervisor.js';
import {
  ASSET_ROOT,
  BREAKAWAY_SOURCE,
  created,
  CTRL_C_DRIVER_SOURCE,
  CTRL_C_PARENT,
  HANDLE_INVENTORY_SOURCE,
  PARENT_CRASH_PARENT,
  windowsEnvironment,
} from './windows-supervisor.test-support.js';

describe('fixed Windows Job supervisor assets', () => {
  it('builds one deterministic, minimal, no-shell PowerShell launch', () => {
    const launch = createWindowsSupervisorLaunch({
      assetRoot: ASSET_ROOT,
      environment: windowsEnvironment({
        CODING_X_SECRET: 'must-not-cross',
        PATH: 'C:\\untrusted',
      }),
      platform: 'win32',
    });

    expect(launch.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(launch.args.slice(0, 5)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      join(ASSET_ROOT, 'windows-job-supervisor.ps1'),
    ]);
    expect(launch.args).not.toContain('-ExecutionPolicy');
    expect(launch.assets.sourcePaths.map((path) => basename(path))).toEqual([
      ...WINDOWS_SUPERVISOR_SOURCES,
    ]);
    expect(launch.env).toEqual({
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Windows\\Temp',
      TMP: 'C:\\Windows\\Temp',
    });
    expect(launch.detached).toBe(false);
    expect(launch.windowsHide).toBe(true);
    expect(launch.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('binds every fixed source byte and rejects helper drift by digest', () => {
    const original = readWindowsSupervisorAssets(ASSET_ROOT);
    expect(original.helperDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(readWindowsSupervisorAssets(ASSET_ROOT).helperDigest).toBe(original.helperDigest);

    const copy = mkdtempSync(join(tmpdir(), 'coding-x-windows-helper-'));
    created.push(copy);
    cpSync(ASSET_ROOT, copy, { recursive: true });
    const authority = join(copy, 'WindowsJobAuthority.cs');
    writeFileSync(authority, Buffer.concat([readFileSync(authority), Buffer.from('\n// drift\n')]));
    expect(readWindowsSupervisorAssets(copy).helperDigest).not.toBe(original.helperDigest);
  });

  it('rejects a fixed helper with an external hard-link alias', () => {
    const copy = mkdtempSync(join(tmpdir(), 'coding-x-windows-helper-link-'));
    created.push(copy);
    cpSync(ASSET_ROOT, copy, { recursive: true });
    const authority = join(copy, 'WindowsJobAuthority.cs');
    linkSync(authority, join(copy, 'external-alias.cs'));

    expect(() => readWindowsSupervisorAssets(copy)).toThrow(/single-link/u);
  });

  it('rejects ambiguous case-insensitive Windows launch environment keys', () => {
    expect(() =>
      createWindowsSupervisorLaunch({
        assetRoot: ASSET_ROOT,
        platform: 'win32',
        environment: windowsEnvironment({ temp: 'C:\\different' }),
      }),
    ).toThrow(/ambiguous/u);
  });

  it('keeps each native source reviewable and preserves the fail-closed Windows sequence', () => {
    const powershell = readFileSync(join(ASSET_ROOT, 'windows-job-supervisor.ps1'), 'utf8');
    const sources = WINDOWS_SUPERVISOR_SOURCES.map((name) =>
      readFileSync(join(ASSET_ROOT, name), 'utf8'),
    );
    const [core, processSource, authority] = sources;
    const all = `${powershell}\n${sources.join('\n')}`;

    for (const source of sources) expect(source.split('\n').length).toBeLessThan(1000);
    expect(powershell).toContain("$ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'");
    expect(powershell).toContain('Add-Type -TypeDefinition $sourceText');
    expect(core.indexOf('SetConsoleCtrlHandler(IntPtr.Zero, true)')).toBeLessThan(
      core.indexOf('session.Run()'),
    );
    expect(processSource.indexOf('CreateJobObjectW')).toBeLessThan(
      processSource.indexOf('CreateProcessW'),
    );
    expect(processSource).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(processSource).toContain('PROC_THREAD_ATTRIBUTE_JOB_LIST');
    expect(processSource).toContain('PROC_THREAD_ATTRIBUTE_HANDLE_LIST');
    expect(processSource).toContain('EXTENDED_STARTUPINFO_PRESENT');
    expect(processSource).toContain('CREATE_UNICODE_ENVIRONMENT');
    expect(processSource).toContain('CREATE_SUSPENDED');
    expect(processSource.indexOf('Native.ResumeThread(thread)')).toBeLessThan(
      processSource.indexOf('Native.Close(ref thread)'),
    );
    expect(authority.indexOf('AuthorityBinding.ReadArmed')).toBeLessThan(
      authority.indexOf('jobTarget.Resume()'),
    );
    expect(authority.indexOf('binding.InstallReceipt')).toBeLessThan(
      authority.indexOf('{ "schemaVersion", 1 }, { "type", "DRAINED" }'),
    );
    expect(authority).toContain('ReadCurrentArmed');
    expect(authority).toContain('GetFileInformationByHandle');
    expect(authority).toContain('FileShare.Read');
    expect(authority).toContain('AssertCurrent()');
    expect(authority).toContain('never-started-containment-empty-v1');
    expect(authority).toContain('firstType == "ABORT_BEFORE_START"');
    expect(authority.indexOf('firstType == "ABORT_BEFORE_START"')).toBeLessThan(
      authority.indexOf('target = TargetSpec.Parse(dataEnvelope)'),
    );
    expect(authority).toContain('SendPrestartDrained(operationId)');
    expect(authority).toContain('SendPrestartDrained(target.OperationId)');
    expect(authority).toContain('{ "proof", proof }, { "drainReason", drainReason }');
    expect(authority).toContain(
      'StrictJson.ExactKeys(contract, "delegation contract", "version", "semantic", "rules")',
    );
    expect(authority).toContain('ValidateSemantic(StrictJson.Object(contract, "semantic"');
    expect(authority).toContain('StrictJson.CanonicalSerialize(contract)');
    expect(authority).toContain('information.NumberOfLinks != 1');
    expect(authority).not.toContain('{ "leftover",');
    expect(all).not.toMatch(
      /AssignProcessToJobObject|taskkill|Start-Process|Invoke-Expression|BREAKAWAY|ExecutionPolicy|shell\s*:/u,
    );
    const ctrlDriver = readFileSync(CTRL_C_DRIVER_SOURCE, 'utf8');
    const ctrlParent = readFileSync(CTRL_C_PARENT, 'utf8');
    const ctrlTarget = readFileSync(
      join(dirname(CTRL_C_PARENT), 'windows-ctrl-c-target.mjs'),
      'utf8',
    );
    expect(ctrlDriver).toContain('CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP');
    expect(ctrlDriver).toContain('GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)');
    expect(ctrlParent).toContain("process.on('SIGINT'");
    expect(ctrlParent).toContain("reason: 'user-interrupt'");
    expect(ctrlParent).toContain("new URL('./windows-ctrl-c-target.mjs', import.meta.url)");
    expect(ctrlParent).not.toContain("args: ['-e'");
    expect(ctrlTarget).toContain("process.on('SIGINT'");
    expect(`${ctrlDriver}\n${ctrlParent}\n${ctrlTarget}`).not.toContain('process.kill');

    const breakaway = readFileSync(BREAKAWAY_SOURCE, 'utf8');
    const handleInventory = readFileSync(HANDLE_INVENTORY_SOURCE, 'utf8');
    const parentCrash = readFileSync(PARENT_CRASH_PARENT, 'utf8');
    expect(breakaway).toContain('CREATE_BREAKAWAY_FROM_JOB');
    expect(handleInventory).toContain('NtQuerySystemInformation');
    expect(handleInventory).toContain('HANDLE_FLAG_INHERIT');
    expect(parentCrash).toContain('supervisorPid: bound.supervisorPid');
    expect(parentCrash).toContain('await new Promise(() => {})');
    expect(`${breakaway}\n${handleInventory}\n${parentCrash}`).not.toContain('vi.mock');
  });
});

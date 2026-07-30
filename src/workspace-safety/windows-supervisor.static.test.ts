import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWindowsSupervisorLaunch,
  readWindowsSupervisorAssets,
  WINDOWS_SUPERVISOR_EXECUTABLE,
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

const REVIEWED_WINDOWS_SOURCES = [
  'WindowsJobSupervisor.cs',
  'WindowsJobProcess.cs',
  'WindowsJobAuthority.cs',
  'WindowsSupervisorProgram.cs',
] as const;

function createExecutableFixture(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `coding-x-windows-${label}-`));
  created.push(root);
  writeFileSync(
    join(root, WINDOWS_SUPERVISOR_EXECUTABLE),
    Buffer.from('MZ\0coding-x static executable fixture', 'utf8'),
  );
  return root;
}

describe('fixed Windows Job supervisor assets', () => {
  it('builds one deterministic, minimal direct executable launch', () => {
    const assetRoot = createExecutableFixture('launch');
    const launch = createWindowsSupervisorLaunch({
      assetRoot,
      environment: windowsEnvironment({
        CODING_X_SECRET: 'must-not-cross',
        PATH: 'C:\\untrusted',
      }),
      platform: 'win32',
    });

    expect(launch.command).toBe(join(assetRoot, WINDOWS_SUPERVISOR_EXECUTABLE));
    expect(launch.args).toEqual([
      '--expected-helper-digest',
      launch.assets.helperDigest,
      '--timeouts-base64',
      expect.any(String),
    ]);
    expect(JSON.parse(Buffer.from(launch.args[3], 'base64').toString('utf8'))).toEqual({
      handshakeMs: 5000,
      naturalDrainMs: 5000,
      terminateMs: 5000,
      ackMs: 5000,
      pollMs: 25,
    });
    expect(launch.assets.executablePath).toBe(launch.command);
    expect(launch.args.join(' ')).not.toMatch(/PowerShell|SourcePath|ExecutionPolicy/iu);
    expect(launch.env).toEqual({
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Windows\\Temp',
      TMP: 'C:\\Windows\\Temp',
    });
    expect(launch.detached).toBe(true);
    expect(launch.windowsHide).toBe(true);
    expect(launch.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('binds the exact executable bytes behind a domain-separated digest', () => {
    const assetRoot = createExecutableFixture('digest');
    const original = readWindowsSupervisorAssets(assetRoot);
    expect(original.helperDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(readWindowsSupervisorAssets(assetRoot).helperDigest).toBe(original.helperDigest);
    expect(original.helperBytes).toEqual(
      Buffer.concat([
        Buffer.from('coding-x-windows-supervisor-exe-v1\0', 'utf8'),
        readFileSync(original.executablePath),
      ]),
    );
    expect(original.helperDigest).toBe(
      `sha256:${createHash('sha256').update(original.helperBytes).digest('hex')}`,
    );

    const executable = join(assetRoot, WINDOWS_SUPERVISOR_EXECUTABLE);
    writeFileSync(executable, Buffer.concat([readFileSync(executable), Buffer.from('drift')]));
    expect(readWindowsSupervisorAssets(assetRoot).helperDigest).not.toBe(original.helperDigest);
  });

  it('rejects a fixed helper with an external hard-link alias', () => {
    const assetRoot = createExecutableFixture('helper-link');
    const executable = join(assetRoot, WINDOWS_SUPERVISOR_EXECUTABLE);
    linkSync(executable, join(assetRoot, 'external-alias.exe'));

    expect(() => readWindowsSupervisorAssets(assetRoot)).toThrow(/single-link/u);
  });

  it('rejects ambiguous case-insensitive Windows launch environment keys', () => {
    const assetRoot = createExecutableFixture('environment');
    expect(() =>
      createWindowsSupervisorLaunch({
        assetRoot,
        platform: 'win32',
        environment: windowsEnvironment({ temp: 'C:\\different' }),
      }),
    ).toThrow(/ambiguous/u);
  });

  it('keeps each native source reviewable and preserves the fail-closed Windows sequence', () => {
    const sources = REVIEWED_WINDOWS_SOURCES.map((name) =>
      readFileSync(join(ASSET_ROOT, name), 'utf8'),
    );
    const [core, processSource, authority, program] = sources;
    const all = sources.join('\n');

    for (const source of sources) expect(source.split('\n').length).toBeLessThan(1000);
    expect(program).toContain('coding-x-windows-supervisor-exe-v1');
    expect(program).toContain('OpenStandardInput');
    expect(program).toContain('OpenStandardOutput');
    expect(program).toContain('new UTF8Encoding(false, true)');
    expect(program).toContain('GetConsoleWindow() != IntPtr.Zero');
    expect(program).toContain('GetFileType(handle) != FileTypePipe');
    expect(program).toContain('--expected-helper-digest');
    expect(program).toContain('--timeouts-base64');
    expect(program).toContain('arguments.Length != 4');
    expect(program).toContain('Assembly.Location');
    expect(core).not.toContain('Console.InputEncoding');
    expect(core).not.toContain('Console.OutputEncoding');
    expect(core).not.toContain('SetConsoleCtrlHandler');
    expect(processSource.indexOf('CreateJobObjectW')).toBeLessThan(
      processSource.indexOf('CreateProcessW'),
    );
    expect(processSource).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(processSource).toContain('PROC_THREAD_ATTRIBUTE_JOB_LIST');
    expect(processSource).toContain('PROC_THREAD_ATTRIBUTE_HANDLE_LIST');
    expect(processSource).toContain('EXTENDED_STARTUPINFO_PRESENT');
    expect(processSource).toContain('CREATE_UNICODE_ENVIRONMENT');
    expect(processSource).toContain('CREATE_SUSPENDED');
    expect(processSource).toContain('CREATE_NO_WINDOW');
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
    expect(ctrlParent).toContain("const SUPERVISOR_EXECUTABLE = 'coding-x-windows-supervisor.exe'");
    expect(ctrlParent).toContain('detached: true');
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
    expect(parentCrash).toContain(
      "const SUPERVISOR_EXECUTABLE = 'coding-x-windows-supervisor.exe'",
    );
    expect(parentCrash).toContain('detached: true');
    expect(parentCrash).toContain('await new Promise(() => {})');
    expect(`${breakaway}\n${handleInventory}\n${parentCrash}`).not.toContain('vi.mock');
  });
});

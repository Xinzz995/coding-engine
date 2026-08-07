import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MonotonicDeadline } from './deadline.js';
import { createSystemIdentityAdapter } from './identity.js';
import {
  DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS,
  createWindowsSupervisorLaunch,
  readWindowsSupervisorAssets,
  spawnWindowsJobSupervisor,
  WINDOWS_SUPERVISOR_EXECUTABLE,
} from './windows-supervisor.js';
import { WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS } from './windows-path-attributes.js';
import { WindowsSupervisorProcess } from './windows-supervisor-protocol.js';
import {
  ASSET_ROOT,
  BREAKAWAY_SOURCE,
  BREAKAWAY_TARGET,
  created,
  CTRL_C_DRIVER,
  CTRL_C_DRIVER_SOURCE,
  CTRL_C_PARENT,
  HANDLE_INVENTORY_SOURCE,
  OUTER_JOB_DRIVER,
  PARENT_CRASH_PARENT,
  windowsEnvironment,
} from './windows-supervisor.test-support.js';

const REVIEWED_WINDOWS_SOURCES = [
  'WindowsJobSupervisor.cs',
  'WindowsJobDeadlines.cs',
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
      handshakeMs: 120_000,
      naturalDrainMs: 5000,
      terminateMs: 5000,
      ackMs: 30_000,
      pollMs: 25,
    });
    expect(launch.assets.executablePath).toBe(launch.command);
    expect(launch.args.join(' ')).not.toMatch(/PowerShell|SourcePath|ExecutionPolicy/iu);
    expect(launch.env).toEqual({
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Windows\\Temp',
      TMP: 'C:\\Windows\\Temp',
    });
    // BOUND→DATA and ARMED→START each contain repeated exact owner/target identity
    // checks plus bounded workspace scans. Keep a full minute beyond the currently
    // longest eleven sequential identity probes instead of racing the fixed helper.
    expect(DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS.handshakeMs).toBeGreaterThanOrEqual(
      11 * WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS + 60_000,
    );
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

  it.runIf(process.platform === 'win32')(
    'observes the same native creation identity emitted by the fixed supervisor',
    async () => {
      const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
      const supervisor = new WindowsSupervisorProcess(spawnWindowsJobSupervisor(launch), 5000);
      try {
        const bound = await supervisor.next('BOUND');
        expect(bound.supervisorPid).toBe(supervisor.pid);
        expect(createSystemIdentityAdapter().readProcessIdentity(supervisor.pid)).toEqual({
          status: 'found',
          value: bound.supervisorIdentity,
        });
      } finally {
        await supervisor.abort(MonotonicDeadline.after(5000));
      }
    },
  );

  it('keeps each native source reviewable and preserves the fail-closed Windows sequence', () => {
    const sources = REVIEWED_WINDOWS_SOURCES.map((name) =>
      readFileSync(join(ASSET_ROOT, name), 'utf8'),
    );
    const [core, deadlines, processSource, authority, program] = sources;
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
    expect(core).toContain('private const int MaximumDecodedObjectBytes = 64 * 1024');
    expect(core).toContain('4 * ((MaximumDecodedObjectBytes + 2) / 3)');
    expect(core).toContain(
      'StrictJson.Base64ObjectString(envelope, "messageBase64", "DATA messageBase64")',
    );
    expect(core).not.toContain('encoded.Length > 96 * 1024');
    expect(authority).toContain(
      'StrictJson.String(envelope, "messageBase64", "messageBase64", false)',
    );
    expect(authority).not.toContain('StrictJson.Base64ObjectString(');
    expect(core).not.toContain('Console.InputEncoding');
    expect(core).not.toContain('Console.OutputEncoding');
    expect(core).not.toContain('SetConsoleCtrlHandler');
    expect(core).toContain(
      'Range(StrictJson.Integer(record, "handshakeMs", "handshakeMs"), 10, 300000)',
    );
    expect(deadlines).toContain('Stopwatch.GetTimestamp()');
    expect(deadlines).toContain('RemainingMilliseconds');
    expect(deadlines).toContain('TightenAfter');
    expect(deadlines).toContain('protocol send timed out');
    expect(deadlines).toContain('internal static bool SendOutput');
    expect(deadlines).toMatch(
      /while \(connected && !Requests\.TryAdd\(request, 25\)\)[\s\S]*?while \(connected && !request\.Completed\.Wait\(25\)\)/u,
    );
    expect(deadlines).toContain('TryFailure(string message, MonotonicDeadline deadline)');
    expect(deadlines).toContain(
      'Requests.TryAdd(new WriteRequest { Line = StrictJson.Serialize(failure) }, 0)',
    );
    expect(deadlines).toMatch(
      /request\.Completed\.Wait\(remaining\)[\s\S]*?if \(deadline\.Expired\)[\s\S]*?request\.Error/u,
    );
    expect(deadlines).not.toContain('DateTime.UtcNow');
    expect(processSource).toContain('WaitForEmptyAndEof(MonotonicDeadline deadline');
    expect(processSource).toContain('private const int MaximumOutstandingBytes = 256 * 1024');
    expect(processSource).toContain('private const int MaximumOutstandingFrames = 1024');
    expect(processSource).toContain('outstanding.Count >= MaximumOutstandingFrames');
    expect(processSource).toContain('ProtocolWriter.SendOutput(');
    expect(processSource).toContain('{ "operationId", operationId }');
    expect(processSource).toContain('{ "sequence", reservation.Sequence }');
    expect(processSource).toContain('{ "bytes", reservation.Bytes }');
    expect(processSource).toContain(
      'standardOutput.EndOfFile && standardError.EndOfFile && outputCredit.Settled',
    );
    expect(processSource).toContain('Monitor.PulseAll(sync)');
    expect(processSource).toMatch(
      /internal void Terminate\(\)[\s\S]*?Native\.Close\(ref thread\);\s*Native\.Close\(ref process\);/u,
    );
    expect(processSource).not.toMatch(
      /ProtocolWriter\.Send\(new Dictionary<string, object> \{[\s\S]{0,300}\{ "type", "OUTPUT" \}/u,
    );
    expect(processSource).toMatch(
      /bool drained = ActiveProcesses\(job\) == 0 && OutputEnded;\s*if \(deadline\.Expired\) return false;\s*if \(drained\) return true;/u,
    );
    expect(processSource).not.toMatch(
      /Thread\.Sleep\([\s\S]*?\);\s*\}\s*return ActiveProcesses\(job\) == 0 && OutputEnded;/u,
    );
    expect(processSource).not.toContain('DateTime.UtcNow.AddMilliseconds');
    expect(core).toMatch(
      /if \(!frames\.TryTake\(out frame, timeoutMs\)\)\s*throw new SafetyException\(label \+ " timed out"\);\s*if \(deadline\.Expired\) throw new SafetyException\(label \+ " timed out"\);/u,
    );
    expect(core).toContain('internal bool TryTake(int timeoutMs, out ControlFrame frame)');
    expect(authority).toContain('control.Take(prepareDeadline, "DATA handshake")');
    expect(authority).toContain('control.Take(prepareDeadline, "START handshake")');
    expect(authority).toContain('control.Take(deadline, "ACK")');
    expect(authority).toContain('HandleOutputAcknowledgement(ControlFrame frame)');
    expect(authority).toContain('"schemaVersion", "type", "operationId", "sequence", "bytes"');
    expect(authority).toContain('jobTarget.AcknowledgeOutput(operationId, sequence, bytes)');
    expect(authority).toContain('jobTarget.DiscardOutput()');
    expect(authority).toMatch(
      /if \(requestedTermination != null\)\s*\{\s*jobTarget\.Terminate\(\);\s*DrainAndSend\(requestedTermination,[\s\S]*?return;\s*\}\s*closeoutDeadline = StartPhaseDeadline/u,
    );
    expect(authority).not.toContain('WaitForRootResult');
    expect(authority).toContain('parent output acknowledgements did not settle');
    expect(authority).toContain('windows-job-zero-pipes-eof-output-settled-v2');
    expect(authority).not.toContain('windows-job-zero-and-pipes-eof-v1');
    expect(authority).toContain('closeoutDeadline.TightenAfter(timeouts.TerminateMs)');
    expect(authority).toContain('StartPhaseDeadline(timeouts.AckMs)');
    expect(authority).toContain('internal MonotonicDeadline FailureDeadline()');
    expect(core).toContain('session == null ? null : session.FailureDeadline()');
    expect(authority).toMatch(
      /MonotonicDeadline naturalDeadline = MonotonicDeadline\.Start\(timeouts\.NaturalDrainMs\);\s*bool naturallyDrained = jobTarget\.Drained;\s*while \(requestedTermination == null && !naturallyDrained &&\s*!naturalDeadline\.Expired/u,
    );
    expect(authority).toContain('control.TryTake(timeouts.PollMs, out frame)');
    expect(authority).toMatch(
      /int waitMs = Math\.Min\(timeouts\.PollMs,\s*Math\.Min\(naturalDeadline\.RemainingMilliseconds,\s*closeoutDeadline\.RemainingMilliseconds\)\);\s*if \(waitMs > 0 && control\.TryTake\(waitMs, out frame\)\)/u,
    );
    expect(authority).toMatch(
      /if \(requestedTermination == null && !naturalDeadline\.Expired &&\s*!closeoutDeadline\.Expired\)\s*\{\s*bool observedDrained = jobTarget\.Drained;\s*if \(!naturalDeadline\.Expired && !closeoutDeadline\.Expired\)\s*naturallyDrained = observedDrained;\s*\}/u,
    );
    expect(authority).toContain('else if (!naturallyDrained)');
    expect(authority).not.toContain('else if (!jobTarget.Drained)');
    expect(authority).not.toContain('DateTime.UtcNow.AddMilliseconds');
    expect(processSource.indexOf('CreateJobObjectW')).toBeLessThan(
      processSource.indexOf('CreateProcessW'),
    );
    expect(processSource).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(processSource).toContain('PROC_THREAD_ATTRIBUTE_JOB_LIST');
    expect(processSource).toContain('PROC_THREAD_ATTRIBUTE_HANDLE_LIST');
    expect(processSource).toMatch(
      /IntPtr\[\] inherited = new IntPtr\[\] \{\s+standardInput, standardOutput\.ChildHandle, standardError\.ChildHandle\s+\};/u,
    );
    expect(processSource).toContain('EXTENDED_STARTUPINFO_PRESENT');
    expect(processSource).toContain('CREATE_UNICODE_ENVIRONMENT');
    expect(processSource).toContain('CREATE_SUSPENDED');
    expect(processSource).toContain('CREATE_NO_WINDOW');
    expect(processSource).toContain('cmd.exe target must use the fixed /d /s /c shape');
    expect(processSource).toContain('only the fixed system cmd.exe target is supported');
    expect(processSource).toContain('Path.Combine(windows, "System32", "cmd.exe")');
    expect(processSource).not.toContain('Environment.GetEnvironmentVariable("ComSpec")');
    expect(processSource).toContain(
      '.Append(" /d /s /c \\"").Append(target.Arguments[3]).Append(\'"\')',
    );
    expect(processSource.indexOf('Native.ResumeThread(thread)')).toBeLessThan(
      processSource.indexOf('Native.Close(ref thread)'),
    );
    expect(authority.indexOf('AuthorityBinding.ReadArmed')).toBeLessThan(
      authority.indexOf('jobTarget.Resume()'),
    );
    expect(authority).toContain(
      'Hashing.Digest(WindowsContainmentBytes(targetPid, targetIdentity))',
    );
    expect(authority).not.toContain('Hashing.Utf8(StrictJson.Serialize(containment))');
    expect(authority).toContain('result.Baseline, "delegated baseline", 64 * 1024 * 1024');
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
    expect(authority).toContain('SendPrestartDrained(operationId, closeoutDeadline)');
    expect(authority).toContain('SendPrestartDrained(target.OperationId, closeoutDeadline)');
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
    const ctrlDriverScript = readFileSync(CTRL_C_DRIVER, 'utf8');
    const outerJobDriverScript = readFileSync(OUTER_JOB_DRIVER, 'utf8');
    const ctrlParent = readFileSync(CTRL_C_PARENT, 'utf8');
    const ctrlTarget = readFileSync(
      join(dirname(CTRL_C_PARENT), 'windows-ctrl-c-target.mjs'),
      'utf8',
    );
    expect(ctrlDriver).toContain('CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP');
    expect(ctrlDriver).toContain('GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)');
    expect(ctrlDriverScript).toContain('Add-Type -Path $resolvedAssembly');
    expect(outerJobDriverScript).toContain('Add-Type -Path $resolvedAssembly');
    expect(ctrlParent).toContain("process.on('SIGINT'");
    expect(ctrlParent).toContain("reason: 'user-interrupt'");
    expect(ctrlParent).toContain("const SUPERVISOR_EXECUTABLE = 'coding-x-windows-supervisor.exe'");
    expect(ctrlParent).toContain('detached: true');
    expect(ctrlParent).toContain("new URL('./windows-ctrl-c-target.mjs', import.meta.url)");
    expect(ctrlParent).not.toContain("args: ['-e'");
    expect(ctrlTarget).toContain("process.on('SIGINT'");
    expect(`${ctrlDriver}\n${ctrlParent}\n${ctrlTarget}`).not.toContain('process.kill');

    const breakaway = readFileSync(BREAKAWAY_SOURCE, 'utf8');
    const breakawayTarget = readFileSync(BREAKAWAY_TARGET, 'utf8');
    const handleInventory = readFileSync(HANDLE_INVENTORY_SOURCE, 'utf8');
    const parentCrash = readFileSync(PARENT_CRASH_PARENT, 'utf8');
    expect(breakaway).toContain('CREATE_BREAKAWAY_FROM_JOB');
    expect(breakaway).toContain('ERROR_ACCESS_DENIED = 5');
    expect(breakaway).toMatch(/dwFillAttribute;\s+internal uint dwFlags;/u);
    expect(breakawayTarget).toContain('Add-Type -Path $resolvedAssembly');
    expect(handleInventory).toContain('NtQuerySystemInformation');
    expect(handleInventory).toContain('HANDLE_FLAG_INHERIT');
    expect(handleInventory).toContain('OBJ_INHERIT');
    expect(handleInventory).toContain('AssertSnapshotCalibration');
    expect(handleInventory).toContain('OpenProcess');
    expect(handleInventory).toMatch(/dwFillAttribute;\s+internal uint dwFlags;/u);
    expect(handleInventory).toContain('public static int Main(string[] arguments)');
    expect(handleInventory).toContain('PROC_THREAD_ATTRIBUTE_HANDLE_LIST');
    expect(handleInventory).toContain('EXTENDED_STARTUPINFO_PRESENT');
    expect(handleInventory).toContain('CREATE_SUSPENDED');
    expect(handleInventory).toContain('ResumeThread');
    expect(handleInventory).toContain('runtime-standard-handles-v1');
    expect(handleInventory).toContain('WriteInspectorIdentity(arguments[5])');
    expect(handleInventory).toContain('IntPtr[] inherited = new IntPtr[]');
    expect(parentCrash).toContain('supervisorPid: bound.supervisorPid');
    expect(parentCrash).toContain(
      "const SUPERVISOR_EXECUTABLE = 'coding-x-windows-supervisor.exe'",
    );
    expect(parentCrash).toContain('detached: true');
    expect(parentCrash).toContain('executable: handleExecutable');
    expect(parentCrash).toContain("role: 'root-prestart'");
    expect(parentCrash).toContain("role: 'descendant-prestart'");
    expect(parentCrash).toContain("writeFileSync(descendantProceedPath, 'inspected')");
    expect(parentCrash).toContain('persistCleanupState');
    expect(parentCrash).toContain('inspectorIdentityPath');
    expect(parentCrash).toContain('writeCommittedJson(cleanupStatePath, cleanupState)');
    expect(parentCrash).not.toContain('powershell');
    expect(parentCrash).toContain("events.next('RESULT')");
    expect(parentCrash).toContain('target exited before ready');
    expect(parentCrash).toContain('await new Promise(() => {})');
    expect(`${breakaway}\n${handleInventory}\n${parentCrash}`).not.toContain('vi.mock');
  });
});

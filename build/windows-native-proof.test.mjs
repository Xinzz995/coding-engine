import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  combineWindowsNativeVitestReports,
  REQUIRED_WINDOWS_NATIVE_SUITES,
  summarizeFailedWindowsNativeVitestReport,
  verifyWindowsNativeSuiteReport,
  verifyWindowsNativeVitestReport,
  WINDOWS_NATIVE_TOTAL_TIMEOUT_MS,
} from './windows-native-proof.mjs';

function report(overrides = {}) {
  return {
    success: true,
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPendingTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numPassedTests: REQUIRED_WINDOWS_NATIVE_SUITES.length,
    testResults: REQUIRED_WINDOWS_NATIVE_SUITES.map((name) => ({
      name: `C:/a/coding-engine/src/workspace-safety/${name}`,
      status: 'passed',
      startTime: 100,
      endTime: 125,
      assertionResults: [{ status: 'passed' }],
    })),
    ...overrides,
  };
}

describe('Windows native proof report', () => {
  it('locks the exact native suites required for release evidence', () => {
    expect(REQUIRED_WINDOWS_NATIVE_SUITES).toEqual([
      'windows-supervisor.test.ts',
      'windows-supervisor.crash.test.ts',
      'windows-supervisor-integration.test.ts',
      'delegated-recovery.windows-crash.test.ts',
      'windows-reparse-point.windows.test.ts',
    ]);
  });

  it('accepts only a real passing result for every required native suite', () => {
    expect(verifyWindowsNativeVitestReport(report())).toEqual({
      passedTests: REQUIRED_WINDOWS_NATIVE_SUITES.length,
      suites: REQUIRED_WINDOWS_NATIVE_SUITES.map((name) => ({
        name,
        passedTests: 1,
        durationMs: 25,
      })),
    });
  });

  it('combines separately executed suites without losing fail or skip counters', () => {
    const separate = REQUIRED_WINDOWS_NATIVE_SUITES.map((name) => {
      const value = report();
      value.numPassedTests = 1;
      value.testResults = value.testResults.filter((entry) => entry.name.endsWith(name));
      return value;
    });

    expect(verifyWindowsNativeVitestReport(combineWindowsNativeVitestReports(separate))).toEqual({
      passedTests: REQUIRED_WINDOWS_NATIVE_SUITES.length,
      suites: REQUIRED_WINDOWS_NATIVE_SUITES.map((name) => ({
        name,
        passedTests: 1,
        durationMs: 25,
      })),
    });

    const malformed = separate.map((value) => structuredClone(value));
    malformed[0].numFailedTestSuites = null;
    expect(() => combineWindowsNativeVitestReports(malformed)).toThrow(/non-negative integer/u);

    const failed = separate.map((value) => structuredClone(value));
    failed[0].success = false;
    failed[0].numFailedTests = 1;
    expect(() =>
      verifyWindowsNativeVitestReport(combineWindowsNativeVitestReports(failed)),
    ).toThrow(/did not report success/u);

    expect(() => combineWindowsNativeVitestReports(separate.slice(1))).toThrow(
      /expected 5 reports/u,
    );
  });

  it('rejects an all-skip, missing, or partly skipped report', () => {
    expect(() =>
      verifyWindowsNativeVitestReport(
        report({
          numPendingTests: 4,
          numPassedTests: 0,
        }),
      ),
    ).toThrow(/numPendingTests/u);

    const missing = report();
    missing.testResults.pop();
    expect(() => verifyWindowsNativeVitestReport(missing)).toThrow(/suite results/u);

    const skipped = report();
    skipped.testResults[0].assertionResults[0].status = 'skipped';
    expect(() => verifyWindowsNativeVitestReport(skipped)).toThrow(/skipped or failed/u);

    const missingDuration = report();
    delete missingDuration.testResults[0].endTime;
    expect(() => verifyWindowsNativeVitestReport(missingDuration)).toThrow(/duration/u);

    const coercedDuration = report();
    coercedDuration.testResults[0].startTime = null;
    coercedDuration.testResults[0].endTime = null;
    expect(() => verifyWindowsNativeVitestReport(coercedDuration)).toThrow(/duration/u);

    const negativeDuration = report();
    negativeDuration.testResults[0].endTime = 99;
    expect(() => verifyWindowsNativeVitestReport(negativeDuration)).toThrow(/duration/u);
  });

  it('validates each separately executed suite before aggregation', () => {
    const single = report();
    single.numPassedTests = 1;
    single.testResults = [single.testResults[0]];
    expect(verifyWindowsNativeSuiteReport(single, REQUIRED_WINDOWS_NATIVE_SUITES[0])).toEqual({
      passedTests: 1,
      suites: [
        {
          name: REQUIRED_WINDOWS_NATIVE_SUITES[0],
          passedTests: 1,
          durationMs: 25,
        },
      ],
    });

    single.testResults[0].assertionResults[0].status = 'skipped';
    expect(() => verifyWindowsNativeSuiteReport(single, REQUIRED_WINDOWS_NATIVE_SUITES[0])).toThrow(
      /skipped or failed/u,
    );

    const mismatched = report();
    mismatched.numPassedTests += 1;
    expect(() => verifyWindowsNativeVitestReport(mismatched)).toThrow(/assertion count/u);
  });

  it('prints bounded failing test details when the hosted native proof fails', () => {
    const failed = report({ success: false, numFailedTestSuites: 1, numFailedTests: 1 });
    failed.testResults[0] = {
      ...failed.testResults[0],
      status: 'failed',
      assertionResults: [
        {
          status: 'failed',
          fullName: 'rejects a native reparse point',
          failureMessages: ['expected native rejection but received success'],
        },
      ],
      message: 'suite failed',
    };

    const summary = summarizeFailedWindowsNativeVitestReport(failed);
    expect(summary).toContain('windows-supervisor.test.ts');
    expect(summary).toContain('rejects a native reparse point');
    expect(summary).toContain('expected native rejection but received success');
    expect(summary).not.toContain('windows-supervisor.crash.test.ts');
  });

  it('runs through a disposable standard account and fails outside Server 2022 CI', () => {
    const script = readFileSync('build/run-windows-native-proof.ps1', 'utf8');
    const workflow = readFileSync('.github/workflows/quality-gate.yml', 'utf8');
    const nativeJob = workflow.slice(
      workflow.indexOf('  checks_windows-native-standard-user:'),
      workflow.indexOf('\n  quality-gate:'),
    );
    expect(script).toContain("$env:ImageOS -ne 'win22'");
    expect(script).toContain('-Credential $credential');
    expect(script).toContain('Remove-LocalUser -Name $userName');
    expect(script).not.toContain('runas.exe');
    expect(nativeJob).toContain('build / windows-supervisor-reproducibility');
    expect(nativeJob).toContain('native/windows-supervisor/build.ps1');
    expect(nativeJob.indexOf('windows-supervisor-reproducibility')).toBeLessThan(
      nativeJob.indexOf('windows-native-proof'),
    );
    expect(nativeJob).toContain('timeout-minutes: 20');
    expect(WINDOWS_NATIVE_TOTAL_TIMEOUT_MS).toBeLessThan(20 * 60_000);
  });

  it('forces an isolated native config that resolves only the production transport', () => {
    const runner = readFileSync('build/windows-native-proof.mjs', 'utf8');
    const nativeConfig = readFileSync('build/vitest.windows-native.config.mjs', 'utf8');
    expect(runner).toContain("join(projectRoot, 'build', 'vitest.windows-native.config.mjs')");
    expect(runner).toContain("'--config'");
    expect(runner).toContain("'--reporter=verbose'");
    expect(runner).toContain('WINDOWS_NATIVE_SUITE_TIMEOUT_MS');
    expect(runner).toContain('WINDOWS_NATIVE_TOTAL_TIMEOUT_MS');
    expect(runner).toContain('last stdout');
    expect(nativeConfig).toContain('windows-path-attributes-transport.ts');
    expect(nativeConfig).not.toMatch(/setupFiles|test-transport|process\.env/u);
  });
});

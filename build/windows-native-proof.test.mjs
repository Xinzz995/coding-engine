import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_WINDOWS_NATIVE_SUITES,
  summarizeFailedWindowsNativeVitestReport,
  verifyWindowsNativeVitestReport,
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
    expect(() => verifyWindowsNativeVitestReport(missing)).toThrow(/did not run/u);

    const skipped = report();
    skipped.testResults[0].assertionResults[0].status = 'skipped';
    expect(() => verifyWindowsNativeVitestReport(skipped)).toThrow(/skipped or failed/u);

    const missingDuration = report();
    delete missingDuration.testResults[0].endTime;
    expect(() => verifyWindowsNativeVitestReport(missingDuration)).toThrow(/duration/u);

    const negativeDuration = report();
    negativeDuration.testResults[0].endTime = 99;
    expect(() => verifyWindowsNativeVitestReport(negativeDuration)).toThrow(/duration/u);
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
    expect(script).toContain("$env:ImageOS -ne 'win22'");
    expect(script).toContain('-Credential $credential');
    expect(script).toContain('Remove-LocalUser -Name $userName');
    expect(script).not.toContain('runas.exe');
  });

  it('forces an isolated native config that resolves only the production transport', () => {
    const runner = readFileSync('build/windows-native-proof.mjs', 'utf8');
    const nativeConfig = readFileSync('build/vitest.windows-native.config.mjs', 'utf8');
    expect(runner).toContain("join(projectRoot, 'build', 'vitest.windows-native.config.mjs')");
    expect(runner).toContain("'--config'");
    expect(nativeConfig).toContain('windows-path-attributes-transport.ts');
    expect(nativeConfig).not.toMatch(/setupFiles|test-transport|process\.env/u);
  });
});

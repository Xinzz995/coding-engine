import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REQUIRED_WINDOWS_NATIVE_SUITES = [
  'windows-supervisor.test.ts',
  'windows-supervisor.crash.test.ts',
  'windows-supervisor-integration.test.ts',
  'delegated-recovery.windows-crash.test.ts',
  'windows-reparse-point.windows.test.ts',
];

function fail(message) {
  throw new Error(`Windows native proof failed: ${message}`);
}

export function verifyWindowsNativeVitestReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('report is not an object');
  if (value.success !== true) fail('Vitest did not report success');
  for (const key of [
    'numFailedTestSuites',
    'numFailedTests',
    'numPendingTestSuites',
    'numPendingTests',
    'numTodoTests',
  ]) {
    if (value[key] !== 0) fail(`${key} must be zero, received ${String(value[key])}`);
  }
  if (!Number.isInteger(value.numPassedTests) || value.numPassedTests <= 0) {
    fail('no native test actually passed');
  }
  if (!Array.isArray(value.testResults)) fail('testResults is missing');

  const byName = new Map(
    value.testResults.map((result) => [basename(String(result.name)), result]),
  );
  const suites = [];
  for (const name of REQUIRED_WINDOWS_NATIVE_SUITES) {
    const result = byName.get(name);
    if (!result) fail(`required suite did not run: ${name}`);
    if (result.status !== 'passed') fail(`required suite was not green: ${name}`);
    if (!Array.isArray(result.assertionResults) || result.assertionResults.length === 0) {
      fail(`required suite had no test result: ${name}`);
    }
    const nonPassed = result.assertionResults.filter((entry) => entry.status !== 'passed');
    if (nonPassed.length > 0) {
      fail(`required suite contains skipped or failed tests: ${name}`);
    }
    const durationMs = Number(result.endTime) - Number(result.startTime);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      fail(`required suite has no finite non-negative duration: ${name}`);
    }
    suites.push({ name, passedTests: result.assertionResults.length, durationMs });
  }
  return { passedTests: value.numPassedTests, suites };
}

function boundedText(value, maximum = 4_000) {
  const text = String(value ?? '');
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[truncated]`;
}

export function summarizeFailedWindowsNativeVitestReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Vitest JSON report is not an object';
  }
  const failedSuites = Array.isArray(value.testResults)
    ? value.testResults
        .filter(
          (result) =>
            result?.status !== 'passed' ||
            result?.assertionResults?.some((entry) => entry?.status !== 'passed'),
        )
        .slice(0, REQUIRED_WINDOWS_NATIVE_SUITES.length)
        .map((result) => ({
          name: basename(String(result?.name ?? 'unknown suite')),
          status: result?.status ?? null,
          failures: Array.isArray(result?.assertionResults)
            ? result.assertionResults
                .filter((entry) => entry?.status !== 'passed')
                .slice(0, 10)
                .map((entry) => ({
                  title: boundedText(entry?.fullName ?? entry?.title ?? 'unknown test', 1_000),
                  status: entry?.status ?? null,
                  messages: Array.isArray(entry?.failureMessages)
                    ? entry.failureMessages.slice(0, 3).map((message) => boundedText(message))
                    : [],
                }))
            : [],
          message: boundedText(result?.message),
        }))
    : [];
  return JSON.stringify(
    {
      success: value.success ?? null,
      numFailedTestSuites: value.numFailedTestSuites ?? null,
      numFailedTests: value.numFailedTests ?? null,
      numPendingTestSuites: value.numPendingTestSuites ?? null,
      numPendingTests: value.numPendingTests ?? null,
      failedSuites,
    },
    null,
    2,
  );
}

function readFailedVitestReport(reportPath) {
  try {
    return summarizeFailedWindowsNativeVitestReport(JSON.parse(readFileSync(reportPath, 'utf8')));
  } catch (error) {
    return `Vitest JSON report unavailable: ${boundedText(error instanceof Error ? error.message : error)}`;
  }
}

function parseArgs(argv) {
  const parsed = { expectedUser: undefined, result: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--expected-user' && flag !== '--result') fail(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (!value) fail(`${flag} requires a value`);
    if (flag === '--expected-user') parsed.expectedUser = value;
    else parsed.result = resolve(value);
    index += 1;
  }
  if (!parsed.expectedUser) fail('--expected-user is required');
  if (!parsed.result) fail('--result is required');
  return parsed;
}

function runWhoami(args) {
  const result = spawnSync('whoami.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`whoami ${args.join(' ')} exited ${String(result.status)}`);
  return result.stdout;
}

function assertStandardUser(expectedUser) {
  const actual = userInfo().username;
  if (actual.toLocaleLowerCase('en-US') !== expectedUser.toLocaleLowerCase('en-US')) {
    fail(`expected local user ${expectedUser}, received ${actual}`);
  }
  const groups = runWhoami(['/groups', '/fo', 'csv', '/nh']);
  if (/S-1-5-32-544/iu.test(groups)) {
    fail('the test token contains the built-in Administrators group');
  }
  return { actualUser: actual, userIdentity: runWhoami(['/user', '/fo', 'csv', '/nh']).trim() };
}

function main() {
  if (process.platform !== 'win32') fail(`requires Windows, received ${process.platform}`);
  const options = parseArgs(process.argv.slice(2));
  const identity = assertStandardUser(options.expectedUser);
  const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const vitest = join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const reportPath = `${options.result}.vitest.json`;
  const testPaths = REQUIRED_WINDOWS_NATIVE_SUITES.map((name) =>
    join(projectRoot, 'src', 'workspace-safety', name),
  );
  const startedAt = Date.now();
  const run = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      ...testPaths,
      '--reporter=json',
      `--outputFile=${reportPath}`,
      '--no-file-parallelism',
      '--config',
      join(projectRoot, 'build', 'vitest.windows-native.config.mjs'),
    ],
    {
      cwd: projectRoot,
      env: { ...process.env },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15 * 60_000,
      windowsHide: true,
      shell: false,
    },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    fail(
      `Vitest exited ${String(run.status)}\nreport:\n${readFailedVitestReport(reportPath)}\nstdout:\n${boundedText(run.stdout)}\nstderr:\n${boundedText(run.stderr)}`,
    );
  }
  const totalDurationMs = Date.now() - startedAt;
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const verified = verifyWindowsNativeVitestReport(report);
  const proof = {
    schemaVersion: 1,
    status: 'passed',
    platform: process.platform,
    node: process.version,
    runnerImage: process.env.ImageOS ?? null,
    runnerVersion: process.env.ImageVersion ?? null,
    ...identity,
    ...verified,
    totalDurationMs,
  };
  writeFileSync(options.result, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

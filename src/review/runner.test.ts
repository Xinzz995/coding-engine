import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  assertFrozenReviewRunner,
  codexReviewPermissionOverrides,
  freezeReviewRunner,
  parseCodexReviewJsonl,
  parseModelReviewOutput,
  readRunnerVersion,
  revalidateFrozenReviewRunner,
  runSafeReviewAxis,
} from './runner.js';
import type { ReviewPackage } from './package.js';

const originalClaudeBinary = process.env.CODING_X_CLAUDE_BIN;
const originalCodexBinary = process.env.CODING_X_CODEX_BIN;
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalShell = process.env.SHELL;
const originalTmpdir = process.env.TMPDIR;
const originalGoogleCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const originalClaudeVertex = process.env.CLAUDE_CODE_USE_VERTEX;
const originalClaudeBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
const originalAwsAccessKey = process.env.AWS_ACCESS_KEY_ID;

afterEach(() => {
  if (originalClaudeBinary === undefined) delete process.env.CODING_X_CLAUDE_BIN;
  else process.env.CODING_X_CLAUDE_BIN = originalClaudeBinary;
  if (originalCodexBinary === undefined) delete process.env.CODING_X_CODEX_BIN;
  else process.env.CODING_X_CODEX_BIN = originalCodexBinary;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  if (originalGoogleCredentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalGoogleCredentials;
  if (originalClaudeVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
  else process.env.CLAUDE_CODE_USE_VERTEX = originalClaudeVertex;
  if (originalClaudeBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
  else process.env.CLAUDE_CODE_USE_BEDROCK = originalClaudeBedrock;
  if (originalAwsAccessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
  else process.env.AWS_ACCESS_KEY_ID = originalAwsAccessKey;
});

function executable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function nativeRunner(path: string): void {
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, path);
  } else {
    const source = `${path}.c`;
    writeFileSync(source, `
#include <stdio.h>
#include <signal.h>
#include <string.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-review-runner 1.0.0");
      return 0;
    }
  }
  return 0;
}
`);
    execFileSync('cc', [source, '-o', path]);
  }
  chmodSync(path, 0o755);
}

const NATIVE_RUNNER_VERSION = process.platform === 'win32'
  ? process.version
  : 'native-review-runner 1.0.0';

function requireDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function fakeClaudeSource(options: {
  version: string;
  marker?: string;
  versionFile?: string;
  versionCwdFile?: string;
}): string {
  const marker = options.marker
    ? `require('node:fs').writeFileSync(${JSON.stringify(options.marker)}, 'called\\n');`
    : '';
  const version = options.versionFile
    ? `require('node:fs').readFileSync(${JSON.stringify(options.versionFile)}, 'utf8').trim()`
    : JSON.stringify(options.version);
  return `#!/usr/bin/env node
${marker}
if (process.argv.includes('--version')) {
  ${options.versionCwdFile
    ? `require('node:fs').appendFileSync(${JSON.stringify(options.versionCwdFile)}, process.cwd() + '\\n');`
    : ''}
  console.log(${version});
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const structured_output = input.includes('Runner 隔离反向测试')
    ? {
        outsideSecret: null,
        fileWriteSucceeded: false,
        dangerousCommandSucceeded: false,
        externalToolSucceeded: false,
      }
    : {
        status: 'passed',
        summary: 'frozen runner reviewed the package',
        requestDeepReview: false,
        unverifiableReason: null,
        findings: [],
      };
  console.log(JSON.stringify({ structured_output }));
});
`;
}

function valid(over: Record<string, unknown> = {}) {
  return {
    status: 'failed', summary: '发现一个阻断问题', requestDeepReview: false,
    unverifiableReason: null,
    findings: [{
      severity: 'P1', title: '错误传播丢失', location: { path: 'src/a.ts', line: 4, symbol: null },
      ruleSource: 'AGENTS.md', impact: '调用方会收到假成功', recommendation: '保留失败状态',
      requiresHumanDecision: false,
    }],
    ...over,
  };
}

describe('frozen Review runner identity', () => {
  it('refuses an unscoped version lookup instead of resolving an ambient project PATH', () => {
    expect(() => readRunnerVersion('claude')).toThrow('冻结身份或明确的 projectRoot');
  });

  it.runIf(process.platform !== 'win32')(
    'freezes an absolute realpath, streaming digest, file identity and version',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-identity-'));
      try {
        const real = join(root, 'real-claude');
        const link = join(root, 'claude');
        nativeRunner(real);
        symlinkSync(real, link);
        process.env.CODING_X_CLAUDE_BIN = link;

        const frozen = freezeReviewRunner('claude');

        expect(frozen).toMatchObject({
          runner: 'claude',
          executablePath: realpathSync.native(real),
          version: NATIVE_RUNNER_VERSION,
          executableSha256: `sha256:${createHash('sha256').update(readFileSync(real)).digest('hex')}`,
        });
        expect(frozen.fileIdentity).toMatchObject({
          size: String(readFileSync(real).byteLength),
        });
        expect(Object.values(frozen.fileIdentity).every((value) => /^\d+$/.test(value))).toBe(true);
        expect(Object.isFrozen(frozen)).toBe(true);
        expect(Object.isFrozen(frozen.fileIdentity)).toBe(true);
        expect(revalidateFrozenReviewRunner(frozen)).toEqual({ ok: true });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')('rejects a Node shebang before executing it because its dynamic package cannot be frozen', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-script-'));
    try {
      const runner = join(root, 'claude');
      const marker = join(root, 'script-was-executed');
      executable(
        runner,
        fakeClaudeSource({
          version: 'claude-test 1.0.0',
          marker,
        }),
      );
      process.env.CODING_X_CLAUDE_BIN = runner;

      expect(() => freezeReviewRunner('claude')).toThrow('原生单文件可执行程序');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects an executable script without a shebang before executing it',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-no-shebang-'));
      try {
        const runner = join(root, 'claude');
        const marker = join(root, 'no-shebang-script-was-executed');
        executable(runner, `printf executed > ${JSON.stringify(marker)}\n`);
        process.env.CODING_X_CLAUDE_BIN = runner;

        expect(() => freezeReviewRunner('claude')).toThrow('原生单文件可执行程序');
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')('rejects changed bytes before executing the changed runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-bytes-'));
    try {
      const runner = join(root, 'claude');
      const marker = join(root, 'changed-runner-was-executed');
      nativeRunner(runner);
      process.env.CODING_X_CLAUDE_BIN = runner;
      const frozen = freezeReviewRunner('claude');

      executable(runner, fakeClaudeSource({ version: 'claude-test 2.0.0', marker }));
      const result = revalidateFrozenReviewRunner(frozen);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join('；')).toContain('SHA-256 已变化');
      expect(() => assertFrozenReviewRunner(frozen)).toThrow('Runner 已失效');
      expect(() => readRunnerVersion('claude', frozen)).toThrow('Runner 已失效');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('rejects a PATH-selected Runner inside the project before executing its version command', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-project-path-'));
    try {
      const bin = join(root, 'node_modules', '.bin');
      const marker = join(root, 'project-runner-was-executed');
      requireDirectory(bin);
      const candidate = join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      if (process.platform === 'win32') {
        writeFileSync(candidate, `@echo off\r\necho executed>${marker}\r\nexit /b 0\r\n`);
      } else {
        executable(
          candidate,
          `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nprintf 'claude-project 1.0.0\\n'\n`,
        );
      }
      process.env.CODING_X_CLAUDE_BIN = 'claude';
      process.env.PATH = [bin, originalPath ?? ''].filter(Boolean).join(delimiter);

      expect(() => freezeReviewRunner('claude', { projectRoot: root })).toThrow(
        '位于不可信项目根内',
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'skips a nonexistent project PATH candidate and freezes the external native Runner',
    () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-empty-project-path-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-external-path-'));
      try {
        const projectBin = join(projectRoot, 'node_modules', '.bin');
        const externalBin = join(externalRoot, 'bin');
        requireDirectory(projectBin);
        requireDirectory(externalBin);
        const runner = join(externalBin, 'claude');
        nativeRunner(runner);
        process.env.CODING_X_CLAUDE_BIN = 'claude';
        process.env.PATH = [projectBin, externalBin, originalPath ?? '']
          .filter(Boolean)
          .join(delimiter);

        const frozen = freezeReviewRunner('claude', { projectRoot });

        expect(frozen.executablePath).toBe(realpathSync.native(runner));
        expect(frozen.trustedPath.split(delimiter)).not.toContain(realpathSync.native(projectBin));
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a project PATH symlink even when its realpath points outside the project',
    () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-project-link-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-external-link-'));
      try {
        const bin = join(projectRoot, 'node_modules', '.bin');
        const external = join(externalRoot, 'codex');
        const marker = join(externalRoot, 'external-runner-was-executed');
        requireDirectory(bin);
        executable(
          external,
          `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nprintf 'codex-fake 1.0.0\\n'\n`,
        );
        symlinkSync(external, join(bin, 'codex'));
        process.env.CODING_X_CLAUDE_BIN = 'codex';
        process.env.PATH = [bin, originalPath ?? ''].filter(Boolean).join(delimiter);

        expect(() => freezeReviewRunner('claude', {
          projectRoot: realpathSync.native(projectRoot),
        })).toThrow(
          '候选路径位于不可信项目根内',
        );
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'fails closed for a shell-wrapper shebang instead of pretending the downstream chain is frozen',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-shell-wrapper-'));
      try {
        const runner = join(root, 'claude');
        const marker = join(root, 'shell-wrapper-was-executed');
        executable(
          runner,
          `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nprintf 'claude-shell 1.0.0\\n'\n`,
        );
        process.env.CODING_X_CLAUDE_BIN = runner;

        expect(() => freezeReviewRunner('claude')).toThrow('原生单文件可执行程序');
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'returns unverifiable on Windows before executing any configured Runner',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-cmd-wrapper-'));
      try {
        const runner = join(root, 'claude.cmd');
        const marker = join(root, 'cmd-wrapper-was-executed');
        writeFileSync(runner, `@echo off\r\necho executed>${marker}\r\nexit /b 0\r\n`);
        process.env.CODING_X_CLAUDE_BIN = runner;

        expect(() => freezeReviewRunner('claude')).toThrow('尚无 Job Object');
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects an atomic file replacement even when the replacement bytes are identical',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-replaced-'));
      try {
        const runner = join(root, 'claude');
        const replacement = join(root, 'replacement');
        nativeRunner(runner);
        process.env.CODING_X_CLAUDE_BIN = runner;
        const frozen = freezeReviewRunner('claude');

        copyFileSync(runner, replacement);
        chmodSync(replacement, 0o755);
        renameSync(replacement, runner);
        const result = revalidateFrozenReviewRunner(frozen);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors).toContain('Runner 可执行文件身份已变化');
          expect(result.errors).not.toContain('Runner 可执行文件 SHA-256 已变化');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')('uses the frozen absolute native executable after the configured PATH target changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-invocation-'));
    try {
      const trusted = join(root, 'trusted-claude');
      const replacement = join(root, 'replacement-claude');
      const replacementMarker = join(root, 'replacement-was-executed');
      nativeRunner(trusted);
      executable(replacement, fakeClaudeSource({
        version: 'claude-test 1.0.0',
        marker: replacementMarker,
      }));
      process.env.CODING_X_CLAUDE_BIN = trusted;
      const frozen = freezeReviewRunner('claude');
      process.env.CODING_X_CLAUDE_BIN = replacement;

      expect(readRunnerVersion('claude', frozen)).toBe(NATIVE_RUNNER_VERSION);
      expect(existsSync(replacementMarker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'revalidates only the frozen file identity without executing the Runner again',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-pure-revalidation-'));
      try {
        const runner = join(root, 'claude');
        const source = join(root, 'claude.c');
        const versionCalls = join(root, 'version-calls');
        writeFileSync(source, `
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      FILE *calls = fopen(${JSON.stringify(versionCalls)}, "a");
      fputs("version\\n", calls); fclose(calls);
      puts("native-review-runner 1.0.0");
      return 0;
    }
  }
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CLAUDE_BIN = runner;

        const frozen = freezeReviewRunner('claude');
        expect(revalidateFrozenReviewRunner(frozen)).toEqual({ ok: true });
        assertFrozenReviewRunner(frozen);
        expect(readRunnerVersion('claude', frozen)).toBe('native-review-runner 1.0.0');
        expect(readFileSync(versionCalls, 'utf8')).toBe('version\n');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'removes project directories from the PATH inherited by every formal Review invocation',
    async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-untrusted-path-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-trusted-path-'));
      try {
        const projectBin = join(projectRoot, 'node_modules', '.bin');
        const runner = join(externalRoot, 'claude');
        const source = join(externalRoot, 'claude.c');
        const projectMarker = join(projectRoot, 'project-helper-executed');
        const runnerDirectoryMarker = join(externalRoot, 'runner-directory-helper-executed');
        requireDirectory(projectBin);
        writeFileSync(source, `
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/wait.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-review-runner 1.0.0");
      return 0;
    }
  }
  pid_t child = fork();
  if (child == 0) {
    execlp("review-helper", "review-helper", (char *)NULL);
    _exit(127);
  }
  int status = 0;
  waitpid(child, &status, 0);
  puts("{\\\"structured_output\\\":{\\\"status\\\":\\\"passed\\\",\\\"summary\\\":\\\"trusted path\\\",\\\"requestDeepReview\\\":false,\\\"unverifiableReason\\\":null,\\\"findings\\\":[]}}");
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CLAUDE_BIN = runner;
        process.env.PATH = [projectBin, originalPath ?? ''].filter(Boolean).join(delimiter);
        const frozen = freezeReviewRunner('claude', { projectRoot });
        executable(
          join(projectBin, 'review-helper'),
          `#!/bin/sh\nprintf executed > ${JSON.stringify(projectMarker)}\n`,
        );
        executable(
          join(externalRoot, 'review-helper'),
          `#!/bin/sh\nprintf executed > ${JSON.stringify(runnerDirectoryMarker)}\n`,
        );
        const packageRoot = join(externalRoot, 'package');
        requireDirectory(packageRoot);
        const schemaPath = join(packageRoot, 'response-schema.json');
        writeFileSync(schemaPath, '{}\n');
        const reviewPackage: ReviewPackage = {
          root: packageRoot,
          inputPath: join(packageRoot, 'review-input.json'),
          schemaPath,
          manifestPath: join(packageRoot, 'manifest.json'),
          input: '{}',
          inputBytes: 2,
          digest: 'sha256:test',
          cleanup: () => {},
          assertUnchanged: () => {},
        };

        const result = await runSafeReviewAxis({
          runner: 'claude',
          model: 'test-model',
          runnerVersion: frozen.version,
          frozenRunner: frozen,
          axis: 'spec',
          reviewPackage,
          timeoutMs: 5_000,
        });

        expect(result.output.status).toBe('passed');
        expect(frozen.trustedPath.split(delimiter)).not.toContain(realpathSync.native(projectBin));
        expect(frozen.trustedPath.split(delimiter)).not.toContain(realpathSync.native(externalRoot));
        expect(existsSync(projectMarker)).toBe(false);
        expect(existsSync(runnerDirectoryMarker)).toBe(false);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'uses a fresh controlled HOME and temp directory without inheriting the project shell',
    async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-controlled-env-project-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-controlled-env-external-'));
      try {
        const runner = join(externalRoot, 'claude');
        const source = join(externalRoot, 'claude.c');
        const captured = join(externalRoot, 'environment.txt');
        writeFileSync(source, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-review-runner 1.0.0");
      return 0;
    }
  }
  FILE *output = fopen(${JSON.stringify(captured)}, "w");
  fprintf(output, "HOME=%s\\nTMPDIR=%s\\nSHELL=%s\\n",
    getenv("HOME") ? getenv("HOME") : "missing",
    getenv("TMPDIR") ? getenv("TMPDIR") : "missing",
    getenv("SHELL") ? getenv("SHELL") : "missing");
  fclose(output);
  puts("{\\\"structured_output\\\":{\\\"status\\\":\\\"passed\\\",\\\"summary\\\":\\\"controlled env\\\",\\\"requestDeepReview\\\":false,\\\"unverifiableReason\\\":null,\\\"findings\\\":[]}}");
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CLAUDE_BIN = runner;
        process.env.SHELL = join(projectRoot, 'fake-shell');
        process.env.TMPDIR = projectRoot;
        const frozen = freezeReviewRunner('claude', { projectRoot });
        const packageRoot = join(externalRoot, 'package');
        requireDirectory(packageRoot);
        const schemaPath = join(packageRoot, 'response-schema.json');
        writeFileSync(schemaPath, '{}\n');
        const reviewPackage: ReviewPackage = {
          root: packageRoot,
          inputPath: join(packageRoot, 'review-input.json'),
          schemaPath,
          manifestPath: join(packageRoot, 'manifest.json'),
          input: '{}',
          inputBytes: 2,
          digest: 'sha256:test',
          cleanup: () => {},
          assertUnchanged: () => {},
        };

        await runSafeReviewAxis({
          runner: 'claude',
          model: 'test-model',
          runnerVersion: frozen.version,
          frozenRunner: frozen,
          axis: 'engineering',
          reviewPackage,
          timeoutMs: 5_000,
        });

        const environment = Object.fromEntries(
          readFileSync(captured, 'utf8').trim().split('\n').map((line) => line.split('=', 2)),
        );
        expect(environment.HOME).not.toBe(originalHome);
        expect(environment.HOME.startsWith(projectRoot)).toBe(false);
        expect(environment.TMPDIR.startsWith(projectRoot)).toBe(false);
        expect(environment.SHELL).toBe('missing');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not expose unrelated Google credentials to a Codex Reviewer',
    async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-codex-google-project-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-codex-google-external-'));
      try {
        const runner = join(externalRoot, 'codex');
        const source = join(externalRoot, 'codex.c');
        const exposedMarker = join(externalRoot, 'google-exposed');
        const credential = join(projectRoot, 'google-credential.json');
        writeFileSync(credential, '{"fixture":true}\n');
        writeFileSync(source, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (getenv("GOOGLE_APPLICATION_CREDENTIALS") != NULL) {
    FILE *marker = fopen(${JSON.stringify(exposedMarker)}, "w");
    if (marker != NULL) { fputs("exposed", marker); fclose(marker); }
  }
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-codex-runner 1.0.0");
      return 0;
    }
  }
  puts("{\\\"type\\\":\\\"item.completed\\\",\\\"item\\\":{\\\"type\\\":\\\"agent_message\\\",\\\"text\\\":\\\"{\\\\\\\"status\\\\\\\":\\\\\\\"passed\\\\\\\",\\\\\\\"summary\\\\\\\":\\\\\\\"credential isolated\\\\\\\",\\\\\\\"requestDeepReview\\\\\\\":false,\\\\\\\"unverifiableReason\\\\\\\":null,\\\\\\\"findings\\\\\\\":[]}\\\"}}");
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CODEX_BIN = runner;
        process.env.GOOGLE_APPLICATION_CREDENTIALS = credential;

        const frozen = freezeReviewRunner('codex', { projectRoot });
        const packageRoot = join(externalRoot, 'package');
        requireDirectory(packageRoot);
        const schemaPath = join(packageRoot, 'response-schema.json');
        writeFileSync(schemaPath, '{}\n');
        const reviewPackage: ReviewPackage = {
          root: packageRoot,
          inputPath: join(packageRoot, 'review-input.json'),
          schemaPath,
          manifestPath: join(packageRoot, 'manifest.json'),
          input: '{}',
          inputBytes: 2,
          digest: 'sha256:test',
          cleanup: () => {},
          assertUnchanged: () => {},
        };

        const result = await runSafeReviewAxis({
          runner: 'codex',
          model: 'test-model',
          runnerVersion: frozen.version,
          frozenRunner: frozen,
          axis: 'spec',
          reviewPackage,
          timeoutMs: 5_000,
        });

        expect(result.output.status).toBe('passed');
        expect(existsSync(exposedMarker)).toBe(false);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not expose Google or AWS credentials to Claude when their services are not explicitly enabled',
    async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-claude-cloud-project-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-claude-cloud-external-'));
      try {
        const runner = join(externalRoot, 'claude');
        const source = join(externalRoot, 'claude.c');
        const exposedMarker = join(externalRoot, 'cloud-exposed');
        const credential = join(projectRoot, 'google-credential.json');
        writeFileSync(credential, '{"fixture":true}\n');
        writeFileSync(source, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (getenv("GOOGLE_APPLICATION_CREDENTIALS") != NULL || getenv("AWS_ACCESS_KEY_ID") != NULL) {
    FILE *marker = fopen(${JSON.stringify(exposedMarker)}, "w");
    if (marker != NULL) { fputs("exposed", marker); fclose(marker); }
  }
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-claude-runner 1.0.0");
      return 0;
    }
  }
  puts("{\\\"structured_output\\\":{\\\"status\\\":\\\"passed\\\",\\\"summary\\\":\\\"cloud credential isolated\\\",\\\"requestDeepReview\\\":false,\\\"unverifiableReason\\\":null,\\\"findings\\\":[]}}");
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CLAUDE_BIN = runner;
        process.env.GOOGLE_APPLICATION_CREDENTIALS = credential;
        process.env.AWS_ACCESS_KEY_ID = 'fixture-access-key';
        delete process.env.CLAUDE_CODE_USE_VERTEX;
        delete process.env.CLAUDE_CODE_USE_BEDROCK;

        const frozen = freezeReviewRunner('claude', { projectRoot });
        const packageRoot = join(externalRoot, 'package');
        requireDirectory(packageRoot);
        const schemaPath = join(packageRoot, 'response-schema.json');
        writeFileSync(schemaPath, '{}\n');
        const reviewPackage: ReviewPackage = {
          root: packageRoot,
          inputPath: join(packageRoot, 'review-input.json'),
          schemaPath,
          manifestPath: join(packageRoot, 'manifest.json'),
          input: '{}',
          inputBytes: 2,
          digest: 'sha256:test',
          cleanup: () => {},
          assertUnchanged: () => {},
        };

        const result = await runSafeReviewAxis({
          runner: 'claude',
          model: 'test-model',
          runnerVersion: frozen.version,
          frozenRunner: frozen,
          axis: 'engineering',
          reviewPackage,
          timeoutMs: 5_000,
        });

        expect(result.output.status).toBe('passed');
        expect(existsSync(exposedMarker)).toBe(false);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'materializes only controlled Google and AWS credentials when Vertex and Bedrock are explicitly enabled',
    async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-claude-cloud-enabled-project-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-claude-cloud-enabled-external-'));
      try {
        const runner = join(externalRoot, 'claude');
        const source = join(externalRoot, 'claude.c');
        const captured = join(externalRoot, 'cloud-environment');
        const credential = join(externalRoot, 'google-credential.json');
        writeFileSync(credential, 'fixture-google-credential\n');
        writeFileSync(source, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-claude-runner 1.0.0");
      return 0;
    }
  }
  const char *google = getenv("GOOGLE_APPLICATION_CREDENTIALS");
  const char *aws = getenv("AWS_ACCESS_KEY_ID");
  char content[128] = "missing";
  if (google != NULL) {
    FILE *input = fopen(google, "r");
    if (input != NULL) { fgets(content, sizeof(content), input); fclose(input); }
  }
  FILE *output = fopen(${JSON.stringify(captured)}, "w");
  if (output != NULL) {
    fprintf(output, "%s|%s|%s", google != NULL ? google : "missing", aws != NULL ? aws : "missing", content);
    fclose(output);
  }
  puts("{\\\"structured_output\\\":{\\\"status\\\":\\\"passed\\\",\\\"summary\\\":\\\"cloud credential controlled\\\",\\\"requestDeepReview\\\":false,\\\"unverifiableReason\\\":null,\\\"findings\\\":[]}}");
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CLAUDE_BIN = runner;
        process.env.CLAUDE_CODE_USE_VERTEX = 'true';
        process.env.CLAUDE_CODE_USE_BEDROCK = '1';
        process.env.GOOGLE_APPLICATION_CREDENTIALS = credential;
        process.env.AWS_ACCESS_KEY_ID = 'fixture-access-key';

        const frozen = freezeReviewRunner('claude', { projectRoot });
        const packageRoot = join(externalRoot, 'package');
        requireDirectory(packageRoot);
        const schemaPath = join(packageRoot, 'response-schema.json');
        writeFileSync(schemaPath, '{}\n');
        const reviewPackage: ReviewPackage = {
          root: packageRoot,
          inputPath: join(packageRoot, 'review-input.json'),
          schemaPath,
          manifestPath: join(packageRoot, 'manifest.json'),
          input: '{}',
          inputBytes: 2,
          digest: 'sha256:test',
          cleanup: () => {},
          assertUnchanged: () => {},
        };

        await runSafeReviewAxis({
          runner: 'claude',
          model: 'test-model',
          runnerVersion: frozen.version,
          frozenRunner: frozen,
          axis: 'engineering',
          reviewPackage,
          timeoutMs: 5_000,
        });

        const [materializedGoogle, awsAccessKey, googleContent] = readFileSync(captured, 'utf8')
          .trim()
          .split('|');
        expect(materializedGoogle).not.toBe(credential);
        expect(materializedGoogle.startsWith(projectRoot)).toBe(false);
        expect(existsSync(materializedGoogle)).toBe(false);
        expect(awsAccessKey).toBe('fixture-access-key');
        expect(googleContent).toBe('fixture-google-credential');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects an authentication HOME rooted inside the project before executing the Runner',
    () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-project-home-'));
      const externalRoot = mkdtempSync(join(tmpdir(), 'coding-x-runner-project-home-external-'));
      try {
        const runner = join(externalRoot, 'claude');
        const marker = join(externalRoot, 'runner-executed');
        const source = join(externalRoot, 'claude.c');
        writeFileSync(source, `
#include <stdio.h>
int main(void) {
  FILE *marker = fopen(${JSON.stringify(marker)}, "w");
  fputs("executed", marker); fclose(marker);
  puts("native-review-runner 1.0.0");
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CLAUDE_BIN = runner;
        process.env.HOME = projectRoot;

        expect(() => freezeReviewRunner('claude', { projectRoot })).toThrow(
          /环境变量 HOME .*不可信项目根内/,
        );
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(externalRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'preserves a UTF-8 character split across stdout chunks',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-utf8-chunks-'));
      try {
        const runner = join(root, 'claude');
        const source = join(root, 'claude.c');
        const payloadPath = join(root, 'payload.json');
        const payload = Buffer.from(JSON.stringify({
          structured_output: {
            status: 'passed',
            summary: '边界正常',
            requestDeepReview: false,
            unverifiableReason: null,
            findings: [],
          },
        }));
        const split = payload.indexOf(Buffer.from('边')) + 1;
        expect(split).toBeGreaterThan(0);
        writeFileSync(payloadPath, payload);
        writeFileSync(source, `
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-review-runner 1.0.0");
      return 0;
    }
  }
  FILE *payload = fopen(${JSON.stringify(payloadPath)}, "rb");
  unsigned char buffer[4096];
  size_t count = fread(buffer, 1, sizeof(buffer), payload);
  fclose(payload);
  fwrite(buffer, 1, ${split}, stdout); fflush(stdout);
  usleep(100000);
  fwrite(buffer + ${split}, 1, count - ${split}, stdout); fflush(stdout);
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CLAUDE_BIN = runner;
        const frozen = freezeReviewRunner('claude');
        const schemaPath = join(root, 'response-schema.json');
        writeFileSync(schemaPath, '{}\n');
        const reviewPackage: ReviewPackage = {
          root,
          inputPath: join(root, 'review-input.json'),
          schemaPath,
          manifestPath: join(root, 'manifest.json'),
          input: '{}',
          inputBytes: 2,
          digest: 'sha256:test',
          cleanup: () => {},
          assertUnchanged: () => {},
        };

        const result = await runSafeReviewAxis({
          runner: 'claude',
          model: 'test-model',
          runnerVersion: frozen.version,
          frozenRunner: frozen,
          axis: 'spec',
          reviewPackage,
          timeoutMs: 5_000,
        });

        expect(result.output.summary).toBe('边界正常');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'kills background descendants and stops without retry after the Reviewer root exits',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-background-descendant-'));
      try {
        const runner = join(root, 'claude');
        const source = join(root, 'claude.c');
        const invocations = join(root, 'invocations');
        const descendantMarker = join(root, 'descendant-survived');
        writeFileSync(source, `
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-review-runner 1.0.0");
      return 0;
    }
  }
  FILE *calls = fopen(${JSON.stringify(invocations)}, "a");
  if (calls != NULL) { fputs("call\\n", calls); fclose(calls); }
  pid_t descendant = fork();
  if (descendant == 0) {
    close(0); close(1); close(2);
    usleep(350000);
    FILE *marker = fopen(${JSON.stringify(descendantMarker)}, "w");
    if (marker != NULL) { fputs("survived", marker); fclose(marker); }
    _exit(0);
  }
  puts("{\\\"structured_output\\\":{\\\"status\\\":\\\"passed\\\",\\\"summary\\\":\\\"must not pass\\\",\\\"requestDeepReview\\\":false,\\\"unverifiableReason\\\":null,\\\"findings\\\":[]}}");
  return 0;
}
`);
        execFileSync('cc', [source, '-o', runner]);
        chmodSync(runner, 0o755);
        process.env.CODING_X_CLAUDE_BIN = runner;
        const frozen = freezeReviewRunner('claude');
        const packageRoot = join(root, 'package');
        requireDirectory(packageRoot);
        const schemaPath = join(packageRoot, 'response-schema.json');
        writeFileSync(schemaPath, '{}\n');
        const reviewPackage: ReviewPackage = {
          root: packageRoot,
          inputPath: join(packageRoot, 'review-input.json'),
          schemaPath,
          manifestPath: join(packageRoot, 'manifest.json'),
          input: '{}',
          inputBytes: 2,
          digest: 'sha256:test',
          cleanup: () => {},
          assertUnchanged: () => {},
        };

        let rejection: unknown;
        try {
          await runSafeReviewAxis({
            runner: 'claude',
            model: 'test-model',
            runnerVersion: frozen.version,
            frozenRunner: frozen,
            axis: 'engineering',
            reviewPackage,
            timeoutMs: 5_000,
          });
        } catch (error) {
          rejection = error;
        }

        expect(rejection).toBeInstanceOf(Error);
        expect((rejection as Error).message).toContain('安全策略违规立即停止');
        expect((rejection as Error).message).toContain('仍有后台后代');
        expect((rejection as Error).message).not.toContain('重试一次后');
        expect(readFileSync(invocations, 'utf8').trim().split('\n')).toHaveLength(1);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        expect(existsSync(descendantMarker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'kills the process tree and fails when an early forbidden Codex event is followed by over 4 MiB of valid events and a valid final message',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-runner-output-limit-'));
      try {
        const helper = join(root, 'codex-output-helper');
        const source = join(root, 'codex-output-helper.c');
        const payloadPath = join(root, 'payload.jsonl');
        const descendantMarker = join(root, 'descendant-survived');
        const forbidden = JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'must never be hidden by truncation' },
        });
        const passive = JSON.stringify({
          type: 'item.completed',
          item: { type: 'reasoning', text: 'x'.repeat(4096) },
        });
        const finalMessage = JSON.stringify({
          status: 'passed',
          summary: 'apparently valid final result',
          requestDeepReview: false,
          unverifiableReason: null,
          findings: [],
        });
        const finalEvent = JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: finalMessage },
        });
        const passiveCount = Math.ceil((4 * 1024 * 1024) / Buffer.byteLength(`${passive}\n`)) + 4;
        const payload = `${forbidden}\n${`${passive}\n`.repeat(passiveCount)}${finalEvent}\n`;
        expect(Buffer.byteLength(payload)).toBeGreaterThan(4 * 1024 * 1024);
        writeFileSync(payloadPath, payload);
        writeFileSync(source, `
#include <stdio.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("codex-output-helper 1.0.0");
      return 0;
    }
  }
  signal(SIGTERM, SIG_IGN);
  pid_t descendant = fork();
  if (descendant == 0) {
    close(1); close(2);
    usleep(750000);
    FILE *marker = fopen(${JSON.stringify(descendantMarker)}, "w");
    if (marker != NULL) { fputs("survived", marker); fclose(marker); }
    _exit(0);
  }
  FILE *payload = fopen(${JSON.stringify(payloadPath)}, "rb");
  char buffer[65536];
  size_t count;
  while ((count = fread(buffer, 1, sizeof(buffer), payload)) > 0) {
    fwrite(buffer, 1, count, stdout);
  }
  fclose(payload);
  fflush(stdout);
  return 0;
}
`);
        execFileSync('cc', [source, '-o', helper]);
        process.env.CODING_X_CODEX_BIN = helper;
        const frozen = freezeReviewRunner('codex');
        const schemaPath = join(root, 'response-schema.json');
        writeFileSync(schemaPath, '{}\n');
        const reviewPackage: ReviewPackage = {
          root,
          inputPath: join(root, 'review-input.json'),
          schemaPath,
          manifestPath: join(root, 'manifest.json'),
          input: '{}',
          inputBytes: 2,
          digest: 'sha256:test',
          cleanup: () => {},
          assertUnchanged: () => {},
        };

        const started = Date.now();
        let rejection: unknown;
        try {
          await runSafeReviewAxis({
            runner: 'codex',
            model: 'test-model',
            runnerVersion: frozen.version,
            frozenRunner: frozen,
            axis: 'spec',
            reviewPackage,
            timeoutMs: 5_000,
          });
        } catch (error) {
          rejection = error;
        }
        expect(rejection).toBeInstanceOf(Error);
        const message = (rejection as Error).message;
        expect(message).toContain('安全策略违规立即停止');
        expect(message).toContain('stdout 超过 4194304 bytes 安全上限');
        expect(message).not.toContain('重试一次后');
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(existsSync(descendantMarker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('parseModelReviewOutput', () => {
  it('derives blocking status from findings instead of trusting a passed claim', () => {
    expect(parseModelReviewOutput(valid({ status: 'passed' })).status).toBe('failed');
  });

  it('allows non-blocking findings while deriving passed', () => {
    const output = valid({
      status: 'failed',
      findings: [{
        severity: 'P2', title: '命名可读性', location: { path: 'src/a.ts', line: null, symbol: null },
        ruleSource: 'engineering baseline', impact: '增加理解成本', recommendation: '后续改名',
        requiresHumanDecision: false,
      }],
    });
    expect(parseModelReviewOutput(output).status).toBe('passed');
  });

  it('normalizes nullable structured-output fields to absent optional values', () => {
    expect(parseModelReviewOutput({
      status: 'passed', summary: '没有问题', requestDeepReview: false,
      unverifiableReason: null, findings: [],
    })).toEqual({
      status: 'passed', summary: '没有问题', requestDeepReview: false, findings: [],
    });
    expect(parseModelReviewOutput(valid({
      unverifiableReason: null,
      findings: [{
        ...valid().findings[0],
        location: { path: 'src/a.ts', line: null, symbol: null },
      }],
    })).findings[0].location).toEqual({ path: 'src/a.ts' });
  });

  it('rejects malformed, unbound or ambiguous output shapes', () => {
    const { unverifiableReason: _reason, ...withoutReason } = valid();
    const { line: _line, ...withoutLine } = valid().findings[0].location;
    const { symbol: _symbol, ...withoutSymbol } = valid().findings[0].location;
    expect(() => parseModelReviewOutput(withoutReason)).toThrow('缺少 unverifiableReason');
    expect(() => parseModelReviewOutput(valid({
      findings: [{ ...valid().findings[0], location: withoutLine }],
    }))).toThrow('缺少 line');
    expect(() => parseModelReviewOutput(valid({
      findings: [{ ...valid().findings[0], location: withoutSymbol }],
    }))).toThrow('缺少 symbol');
    expect(() => parseModelReviewOutput(valid({ extra: true }))).toThrow('未知字段');
    expect(() => parseModelReviewOutput(valid({ status: 'unverifiable', findings: [] })))
      .toThrow('提供原因');
    expect(() => parseModelReviewOutput(valid({ findings: [], status: 'failed' })))
      .toThrow('failed 必须包含');
    expect(() => parseModelReviewOutput(valid({
      findings: [{ ...valid().findings[0], location: { path: '../secret', line: null, symbol: null } }],
    }))).toThrow('仓库相对路径');
    expect(() => parseModelReviewOutput(valid({
      findings: [{ ...valid().findings[0], location: { path: 'src/a.ts', line: 0, symbol: null } }],
    }))).toThrow('正整数');
  });
});

describe('parseCodexReviewJsonl', () => {
  it('extracts only a structured final agent message', () => {
    const answer = { status: 'passed', summary: 'ok', requestDeepReview: false, findings: [] };
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'checked' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    expect(parseCodexReviewJsonl(stdout)).toEqual(answer);
  });

  it('allows Codex internal todo metadata without treating it as an external tool call', () => {
    const answer = { status: 'passed', summary: 'ok', requestDeepReview: false, findings: [] };
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'todo_list', items: [{ text: 'inspect supplied review data', completed: true }] },
      }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    expect(parseCodexReviewJsonl(stdout)).toEqual(answer);
  });

  it.each(['command_execution', 'mcp_tool_call', 'web_search', 'file_change'])(
    'rejects an observed %s tool event even if a final answer exists',
    (type) => {
      const stdout = [
        JSON.stringify({ type: 'item.started', item: { type } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }),
      ].join('\n');
      expect(() => parseCodexReviewJsonl(stdout)).toThrow(`禁用工具事件：${type}`);
    },
  );

  it('rejects an unrecognized item type so future capabilities fail closed', () => {
    const stdout = JSON.stringify({
      type: 'item.started', item: { type: 'future_capability' },
    });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('禁用工具事件：future_capability');
  });

  it('rejects an unrecognized top-level event even when a valid final answer follows', () => {
    const answer = { status: 'passed', summary: 'ok', requestDeepReview: false, findings: [] };
    const stdout = [
      JSON.stringify({ type: 'future.event', payload: 'unknown capability' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } }),
    ].join('\n');
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('未知顶层事件：future.event');
  });

  it('rejects an item event whose item payload is missing', () => {
    const stdout = JSON.stringify({ type: 'item.started' });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('item.started 缺少 item');
  });

  it('rejects a passive top-level event that unexpectedly carries a tool item', () => {
    const stdout = JSON.stringify({
      type: 'turn.completed', item: { type: 'command_execution', command: 'whoami' },
    });
    expect(() => parseCodexReviewJsonl(stdout)).toThrow('turn.completed 含非预期 item');
  });
});

describe('codexReviewPermissionOverrides', () => {
  it('defaults to deny and grants read-only access only to the exact review package root', () => {
    const cwd = '/tmp/review package';
    expect(codexReviewPermissionOverrides(cwd)).toEqual([
      '-c', 'default_permissions="coding_x_review"',
      '-c', `permissions.coding_x_review.filesystem={ ":minimal" = "read", ${JSON.stringify(resolve(cwd))} = "read" }`,
      '-c', 'permissions.coding_x_review.network.enabled=true',
    ]);
  });
});

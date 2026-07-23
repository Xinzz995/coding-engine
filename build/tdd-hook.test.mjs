import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const HOOK = join(ROOT, 'hooks', 'tdd-commit-check.mjs');
const cleanups = [];

afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
});

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixture({ enabled = true, policySource = 'process.exit(0);\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coding-x hook repo with spaces-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'hook@example.com');
  git(root, 'config', 'user.name', 'Hook Fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  mkdirSync(join(root, '.workspace'), { recursive: true });
  const policyPath = join(root, 'scripts', 'coverage.mjs');
  writeFileSync(policyPath, policySource);
  writeFileSync(join(root, 'src', 'index.js'), 'export const value = 1;\n');
  git(root, 'add', 'scripts', 'src');
  git(root, 'commit', '-qm', 'baseline');
  const baselineRef = git(root, 'rev-parse', 'HEAD');
  const prd = {
    project: 'fixture',
    branchName: 'fixture/tdd',
    description: 'fixture',
    userStories: [],
    ...(enabled ? {
      tdd: {
        coverageCheck: 'node scripts/coverage.mjs',
        sourcePathspecs: [':(glob)src/**'],
        policyFiles: [{ path: 'scripts/coverage.mjs', sha256: hash(policyPath) }],
        baselineRef,
        forbiddenAddedPatterns: ['c8 ignore', 'istanbul ignore'],
      },
    } : {}),
  };
  writeFileSync(join(root, '.workspace', 'prd.json'), JSON.stringify(prd));
  return { root, policyPath, baselineRef, prd };
}

function runHook(cwd, payload, env = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      CODING_X_TDD_HOOK_TIMEOUT_MS: '1000',
      ...env,
    },
  });
}

const nestedCommit = (cwd) => ({
  hook_event_name: 'PreToolUse',
  cwd,
  tool_name: 'Bash',
  tool_input: { command: 'git commit -m "story"' },
});

const cursorCommit = (cwd) => ({
  hook_event_name: 'beforeShellExecution',
  cwd,
  command: 'git commit -m "story"',
});

describe('TDD commit hook', () => {
  it('is a no-op for non-commit commands and projects without TDD', () => {
    const enabled = fixture();
    expect(runHook(enabled.root, {
      ...nestedCommit(enabled.root),
      tool_input: { command: 'npm test' },
    }).status).toBe(0);

    const disabled = fixture({ enabled: false });
    expect(runHook(disabled.root, nestedCommit(disabled.root)).status).toBe(0);
  });

  it('accepts Codex/Claude nested payloads and Cursor flat payloads from a subdirectory', () => {
    const value = fixture();
    const subdir = join(value.root, 'src', 'nested');
    expect(runHook(subdir, nestedCommit(subdir))).toMatchObject({
      status: 0,
      stderr: '',
      stdout: '',
    });
    expect(runHook(subdir, cursorCommit(subdir))).toMatchObject({
      status: 0,
      stderr: '',
      stdout: '{"permission":"allow"}\n',
    });
  });

  it('blocks a failing coverage command with exit 2 and a bounded diagnostic', () => {
    const value = fixture({
      policySource: `console.error('${'x'.repeat(2500)}TAIL-END');\nprocess.exit(7);\n`,
    });
    const result = runHook(value.root, nestedCommit(value.root));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('TDD');
    expect(result.stderr).toContain('TAIL-END');
    expect(result.stderr.length).toBeLessThan(2600);
  });

  it('blocks malformed config, policy drift, and a forbidden marker added after baseline', () => {
    const malformed = fixture();
    malformed.prd.tdd.coverageCheck = '';
    writeFileSync(join(malformed.root, '.workspace', 'prd.json'), JSON.stringify(malformed.prd));
    expect(runHook(malformed.root, nestedCommit(malformed.root)).status).toBe(2);

    const drift = fixture();
    writeFileSync(drift.policyPath, 'process.exit(1);\n');
    expect(runHook(drift.root, nestedCommit(drift.root))).toMatchObject({
      status: 2,
      stderr: expect.stringContaining('摘要'),
    });

    const ignore = fixture();
    writeFileSync(
      join(ignore.root, 'src', 'index.js'),
      '/* c8 ignore next */\nexport const value = 1;\n',
    );
    git(ignore.root, 'add', 'src/index.js');
    git(ignore.root, 'commit', '-qm', 'attempt bypass');
    expect(runHook(ignore.root, cursorCommit(ignore.root))).toMatchObject({
      status: 2,
      stderr: expect.stringContaining('c8 ignore'),
    });
  });

  it('uses an external custom workspace only when the paired project root matches', () => {
    const value = fixture({ enabled: false });
    const outside = mkdtempSync(join(tmpdir(), 'coding-x external workspace-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const enabledPrd = { ...value.prd, tdd: {
      coverageCheck: 'node scripts/coverage.mjs',
      sourcePathspecs: [':(glob)src/**'],
      policyFiles: [{ path: 'scripts/coverage.mjs', sha256: hash(value.policyPath) }],
      baselineRef: value.baselineRef,
      forbiddenAddedPatterns: ['c8 ignore'],
    } };
    writeFileSync(join(outside, 'prd.json'), JSON.stringify(enabledPrd));
    writeFileSync(value.policyPath, 'process.exit(9);\n');

    const matched = runHook(value.root, nestedCommit(value.root), {
      CODING_X_PROJECT_ROOT: value.root,
      CODING_X_WORKSPACE: outside,
    });
    expect(matched.status).toBe(2);

    const stale = runHook(value.root, nestedCommit(value.root), {
      CODING_X_PROJECT_ROOT: join(value.root, 'another-project'),
      CODING_X_WORKSPACE: outside,
    });
    expect(stale.status).toBe(0);
  });

  it('does not silently pass malformed commit-like JSON', () => {
    const value = fixture();
    expect(runHook(value.root, '{"command":"git commit -m broken"').status).toBe(2);
    expect(runHook(value.root, '{"command":"npm test"').status).toBe(0);
  });

  it('blocks a timed-out coverage command', () => {
    const value = fixture({ policySource: 'setInterval(() => {}, 1000);\n' });
    const result = runHook(value.root, nestedCommit(value.root), {
      CODING_X_TDD_HOOK_TIMEOUT_MS: '200',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('超时');
  });

  it.runIf(process.platform !== 'win32')('does not return from timeout while a stubborn descendant survives', () => {
    const childSource = [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync('coverage-child.pid', String(child.pid));",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n');
    const value = fixture({ policySource: childSource });
    const marker = join(value.root, 'coverage-child.pid');
    let childPid = null;
    let childGone = false;
    try {
      const result = runHook(value.root, nestedCommit(value.root), {
        CODING_X_TDD_HOOK_TIMEOUT_MS: '300',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('超时');
      expect(existsSync(marker)).toBe(true);
      childPid = Number(readFileSync(marker, 'utf8'));
      let code;
      try { process.kill(childPid, 0); } catch (error) {
        code = error.code;
      }
      childGone = code === 'ESRCH';
      expect(code).toBe('ESRCH');
    } finally {
      if (!childGone && Number.isSafeInteger(childPid) && childPid > 0) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });
});

describe('hook host manifests', () => {
  it('uses the shared Codex/Claude PreToolUse Bash configuration', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    expect(config.hooks.PreToolUse[0]).toMatchObject({
      matcher: 'Bash',
      hooks: [{
        type: 'command',
        command: expect.stringContaining('tdd-commit-check.mjs'),
        timeout: 620,
      }],
    });
  });

  it('keeps Cursor plugin discovery hook-free because the CLI uses project configuration', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, '.cursor-plugin', 'plugin.json'), 'utf8'));
    expect(manifest).not.toHaveProperty('hooks');
    const codex = JSON.parse(readFileSync(join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(codex).not.toHaveProperty('hooks');
    expect(codex).not.toHaveProperty('commands');
    expect(codex.interface).toMatchObject({
      displayName: 'coding-x',
      capabilities: expect.arrayContaining(['Interactive', 'Write']),
    });
  });
});

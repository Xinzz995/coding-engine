import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Prd } from './prd.js';
import {
  checkTddPolicy,
  readTddConfig,
  runTddGate,
  type TddConfig,
} from './tdd-gate.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
});

function prdWith(tdd?: unknown): Prd {
  return {
    project: 'fixture',
    branchName: 'fixture/tdd',
    description: 'fixture',
    userStories: [],
    ...(tdd === undefined ? {} : { tdd }),
  } as unknown as Prd;
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coverageCheck: 'node scripts/coverage.mjs',
    sourcePathspecs: [':(glob)src/**'],
    policyFiles: [{ path: 'scripts/coverage.mjs', sha256: 'a'.repeat(64) }],
    baselineRef: 'b'.repeat(40),
    forbiddenAddedPatterns: ['istanbul ignore', 'c8 ignore'],
    ...overrides,
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function repo(): {
  root: string;
  policyPath: string;
  baselineRef: string;
  config: TddConfig;
} {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-tdd-gate-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const policyPath = join(root, 'scripts', 'coverage.mjs');
  writeFileSync(policyPath, 'process.exit(0);\n');
  writeFileSync(join(root, 'src', 'index.js'), 'export const value = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  const baselineRef = git(root, 'rev-parse', 'HEAD');
  return {
    root,
    policyPath,
    baselineRef,
    config: {
      coverageCheck: 'node scripts/coverage.mjs',
      sourcePathspecs: [':(glob)src/**'],
      policyFiles: [{ path: 'scripts/coverage.mjs', sha256: hash(policyPath) }],
      baselineRef,
      forbiddenAddedPatterns: ['istanbul ignore', 'c8 ignore'],
    },
  };
}

describe('readTddConfig', () => {
  it('treats a missing tdd field as disabled and accepts the exact schema', () => {
    expect(readTddConfig(prdWith())).toEqual({ status: 'disabled' });
    expect(readTddConfig(prdWith(baseConfig()))).toEqual({
      status: 'enabled',
      config: baseConfig(),
    });
  });

  it.each([
    ['non-object', 'enabled'],
    ['unknown key', baseConfig({ extra: true })],
    ['empty command', baseConfig({ coverageCheck: '  ' })],
    ['empty source list', baseConfig({ sourcePathspecs: [] })],
    ['non-string source pathspec', baseConfig({ sourcePathspecs: [7] })],
    ['duplicate source pathspec', baseConfig({ sourcePathspecs: ['src/**', 'src/**'] })],
    ['absolute source pathspec', baseConfig({ sourcePathspecs: ['/tmp/src/**'] })],
    ['parent source pathspec', baseConfig({ sourcePathspecs: ['src/../secret/**'] })],
    ['exclude-only source pathspec', baseConfig({ sourcePathspecs: [':(exclude)src/**'] })],
    ['non-array policy files', baseConfig({ policyFiles: {} })],
    ['duplicate policy path', baseConfig({
      policyFiles: [
        { path: 'coverage.mjs', sha256: 'a'.repeat(64) },
        { path: 'coverage.mjs', sha256: 'b'.repeat(64) },
      ],
    })],
    ['absolute policy path', baseConfig({
      policyFiles: [{ path: '/tmp/coverage.mjs', sha256: 'a'.repeat(64) }],
    })],
    ['parent policy path', baseConfig({
      policyFiles: [{ path: '../coverage.mjs', sha256: 'a'.repeat(64) }],
    })],
    ['invalid policy sha', baseConfig({
      policyFiles: [{ path: 'coverage.mjs', sha256: 'ABC' }],
    })],
    ['invalid baseline', baseConfig({ baselineRef: 'HEAD' })],
    ['empty forbidden patterns', baseConfig({ forbiddenAddedPatterns: [] })],
    ['blank forbidden pattern', baseConfig({ forbiddenAddedPatterns: [''] })],
    ['duplicate forbidden pattern', baseConfig({
      forbiddenAddedPatterns: ['c8 ignore', 'c8 ignore'],
    })],
  ])('fails closed for %s', (_label, value) => {
    const result = readTddConfig(prdWith(value));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.error.length).toBeGreaterThan(0);
  });
});

describe('checkTddPolicy', () => {
  it('accepts a reachable baseline and matching in-repository policy file', () => {
    const fixture = repo();
    expect(checkTddPolicy(fixture.config, fixture.root)).toMatchObject({
      ok: true,
      failure: null,
    });
  });

  it('fails closed when the baseline is unreachable', () => {
    const fixture = repo();
    const result = checkTddPolicy({
      ...fixture.config,
      baselineRef: 'f'.repeat(40),
    }, fixture.root);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'baseline-unreachable' },
    });
  });

  it('detects missing, changed, and out-of-repository policy files', () => {
    const missing = repo();
    rmSync(missing.policyPath);
    expect(checkTddPolicy(missing.config, missing.root)).toMatchObject({
      ok: false,
      failure: { code: 'policy-file-missing' },
    });

    const changed = repo();
    writeFileSync(changed.policyPath, 'process.exit(1);\n');
    expect(checkTddPolicy(changed.config, changed.root)).toMatchObject({
      ok: false,
      failure: { code: 'policy-hash-mismatch' },
    });

    const linked = repo();
    const outside = mkdtempSync(join(tmpdir(), 'coding-x-tdd-policy-outside-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const outsideFile = join(outside, 'coverage.mjs');
    writeFileSync(outsideFile, 'process.exit(0);\n');
    rmSync(linked.policyPath);
    symlinkSync(outsideFile, linked.policyPath);
    expect(checkTddPolicy({
      ...linked.config,
      policyFiles: [{ path: 'scripts/coverage.mjs', sha256: hash(outsideFile) }],
    }, linked.root)).toMatchObject({
      ok: false,
      failure: { code: 'policy-file-outside-root' },
    });
  });

  it('detects a forbidden marker added after the frozen baseline, including committed additions', () => {
    const fixture = repo();
    writeFileSync(
      join(fixture.root, 'src', 'index.js'),
      '/* c8 ignore next */\nexport const value = 1;\n',
    );
    git(fixture.root, 'add', '.');
    git(fixture.root, 'commit', '-qm', 'attempt bypass');

    expect(checkTddPolicy(fixture.config, fixture.root)).toMatchObject({
      ok: false,
      failure: {
        code: 'forbidden-pattern-added',
        outputTail: expect.stringContaining('c8 ignore'),
      },
    });
  });

  it('scans only approved production pathspecs', () => {
    const fixture = repo();
    mkdirSync(join(fixture.root, 'test'), { recursive: true });
    writeFileSync(join(fixture.root, 'test', 'fixture.js'), '/* c8 ignore next */\n');

    expect(checkTddPolicy(fixture.config, fixture.root)).toMatchObject({
      ok: true,
      failure: null,
    });
  });
});

describe('runTddGate', () => {
  it('runs the approved command only after policy integrity succeeds', async () => {
    const fixture = repo();
    const marker = join(fixture.root, 'coverage-ran');
    writeFileSync(
      fixture.policyPath,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'yes');\n`,
    );
    const config = {
      ...fixture.config,
      policyFiles: [{ path: 'scripts/coverage.mjs', sha256: hash(fixture.policyPath) }],
    };

    expect(await runTddGate(config, fixture.root)).toMatchObject({
      ok: true,
      policyOk: true,
      commandRan: true,
      failure: null,
    });
    expect(readFileSync(marker, 'utf8')).toBe('yes');
  });

  it('returns command failure and a bounded diagnostic', async () => {
    const fixture = repo();
    writeFileSync(
      fixture.policyPath,
      `console.error('${'x'.repeat(2500)}TAIL-END');\nprocess.exit(7);\n`,
    );
    const config = {
      ...fixture.config,
      policyFiles: [{ path: 'scripts/coverage.mjs', sha256: hash(fixture.policyPath) }],
    };

    const result = await runTddGate(config, fixture.root);
    expect(result).toMatchObject({
      ok: false,
      policyOk: true,
      commandRan: true,
      failure: { code: 'coverage-check-failed', exitCode: 7, timedOut: false },
    });
    expect(result.failure?.outputTail.length).toBeLessThanOrEqual(2000);
    expect(result.failure?.outputTail).toContain('TAIL-END');
  });

  it('does not run coverage when policy integrity fails', async () => {
    const fixture = repo();
    const marker = join(fixture.root, 'should-not-exist');
    const config = {
      ...fixture.config,
      coverageCheck: `node -e "require('node:fs').writeFileSync('${marker}', 'bad')"`,
      policyFiles: [{ path: 'scripts/coverage.mjs', sha256: '0'.repeat(64) }],
    };

    expect(await runTddGate(config, fixture.root)).toMatchObject({
      ok: false,
      policyOk: false,
      commandRan: false,
      failure: { code: 'policy-hash-mismatch' },
    });
    expect(() => readFileSync(marker)).toThrow();
  });

  it('times out the coverage command through the shared gate runner', async () => {
    const fixture = repo();
    writeFileSync(fixture.policyPath, 'setInterval(() => {}, 1000);\n');
    const config = {
      ...fixture.config,
      policyFiles: [{ path: 'scripts/coverage.mjs', sha256: hash(fixture.policyPath) }],
    };

    expect(await runTddGate(config, fixture.root, 200)).toMatchObject({
      ok: false,
      policyOk: true,
      commandRan: true,
      failure: { code: 'coverage-check-failed', exitCode: null, timedOut: true },
    });
  });
});

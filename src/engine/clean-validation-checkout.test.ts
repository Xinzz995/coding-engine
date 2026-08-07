import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
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
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { QualityContract } from '../quality/contract.js';
import { runDoctor } from '../doctor/doctor.js';
import { createManagedProcessTestSession } from './managed-process-test-support.js';
import {
  CleanValidationCheckoutManager,
  createCleanValidationCheckout,
  remainingCleanValidationGitTimeoutForTests,
} from './clean-validation-checkout.js';
import { assertCleanValidationTreeHasNoMountPoints } from './clean-validation-mounts.js';

const roots: string[] = [];
const LIVE_TEMPORARY_HARD_LINKS_TRUSTED = (() => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
  const root = mkdtempSync(join(tmpdir(), 'coding-x-hard-link-platform-'));
  try {
    return assertCleanValidationTreeHasNoMountPoints(root).hardLinksTrusted;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

function repository(files: Record<string, string>): { root: string; head: () => string } {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-clean-source-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'clean validation test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'clean-validation@example.invalid'], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root });
  return {
    root,
    head: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  };
}

function contract(over: Partial<QualityContract['localValidation']> = {}): QualityContract {
  return {
    generatedPaths: ['dist/**'],
    localValidation: {
      prepare: [],
      allowedPaths: ['node_modules/**'],
      ...over,
    },
  } as unknown as QualityContract;
}

const PYTHON_EXECUTABLE = (() => {
  for (const candidate of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try {
      const executable = execFileSync(
        candidate,
        ['-c', 'import os,sys; print(os.path.realpath(sys.executable))'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (executable) return executable;
    } catch {
      // Try the next platform-native launcher.
    }
  }
  return null;
})();

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.runIf(
  process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32',
)('clean validation checkout', () => {
  it('shares one absolute timeout across both Git establishment phases', () => {
    const deadline = 600_000;
    expect(remainingCleanValidationGitTimeoutForTests(deadline, 0)).toBe(600_000);
    expect(remainingCleanValidationGitTimeoutForTests(deadline, 425_000)).toBe(175_000);
    expect(() => remainingCleanValidationGitTimeoutForTests(deadline, deadline)).toThrow(
      '十分钟总时限',
    );
  });

  it('excludes ignored developer files and accepts only declared artifact directories', async () => {
    const source = repository({
      '.gitignore': '.env\n.claude/\nnode_modules/\nignored-source.js\ndist/\n',
      'source.txt': 'tracked\n',
    });
    writeFileSync(join(source.root, '.env'), 'DEVELOPER_SECRET=1\n');
    mkdirSync(join(source.root, '.claude'));
    writeFileSync(join(source.root, '.claude', 'settings.json'), '{}\n');
    mkdirSync(join(source.root, 'node_modules'));
    writeFileSync(join(source.root, 'node_modules', 'stale.js'), 'throw new Error("stale")\n');
    writeFileSync(join(source.root, 'ignored-source.js'), 'export const injected = true\n');
    const managed = await createManagedProcessTestSession();
    try {
      const checkout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      expect(relative(source.root, checkout.root).startsWith('..')).toBe(true);
      expect(existsSync(join(checkout.root, '.env'))).toBe(false);
      expect(existsSync(join(checkout.root, '.claude'))).toBe(false);
      expect(existsSync(join(checkout.root, 'node_modules'))).toBe(false);
      expect(existsSync(join(checkout.root, 'ignored-source.js'))).toBe(false);

      mkdirSync(join(checkout.root, 'node_modules'));
      writeFileSync(join(checkout.root, 'node_modules', 'fresh.js'), 'ok\n');
      mkdirSync(join(checkout.root, 'dist'));
      writeFileSync(join(checkout.root, 'dist', 'output.js'), 'ok\n');
      await checkout.assertCurrent('允许产物测试');

      mkdirSync(join(checkout.root, 'empty-pollution'));
      await expect(checkout.assertCurrent('空目录污染测试')).rejects.toMatchObject({
        code: 'artifact-boundary-violated',
      });
      rmSync(join(checkout.root, 'empty-pollution'), { recursive: true });

      writeFileSync(join(checkout.root, 'ignored-source.js'), 'malicious\n');
      await expect(checkout.assertCurrent('ignored 源码测试')).rejects.toMatchObject({
        code: 'artifact-boundary-violated',
      });
      expect(checkout.cleanup()).toMatchObject({ status: 'removed' });
      expect(existsSync(checkout.root)).toBe(false);
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('preserves the source repository commit that last changed each tracked path', async () => {
    const source = repository({ 'stable.txt': 'first commit\n' });
    const stableCommit = source.head();
    writeFileSync(join(source.root, 'later.txt'), 'second commit\n');
    execFileSync('git', ['add', 'later.txt'], { cwd: source.root });
    execFileSync('git', ['commit', '-q', '-m', 'later change'], { cwd: source.root });
    const head = source.head();
    const managed = await createManagedProcessTestSession();
    let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
    try {
      checkout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head,
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      expect(
        execFileSync('git', ['rev-list', '-1', 'HEAD', '--', 'stable.txt'], {
          cwd: checkout.root,
          encoding: 'utf8',
        }).trim(),
      ).toBe(stableCommit);
      expect(
        execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
          cwd: checkout.root,
          encoding: 'utf8',
        }).trim(),
      ).toBe('false');
    } finally {
      checkout?.cleanup();
      await managed.close();
    }
  }, 60_000);

  it('preserves reachable path history in a SHA-256 repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-clean-sha256-source-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'clean validation test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'clean-validation@example.invalid'], {
      cwd: root,
    });
    writeFileSync(join(root, 'stable.txt'), 'first commit\n');
    execFileSync('git', ['add', 'stable.txt'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: root });
    const stableCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(root, 'later.txt'), 'second commit\n');
    execFileSync('git', ['add', 'later.txt'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'later'], { cwd: root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    expect(head).toHaveLength(64);

    const managed = await createManagedProcessTestSession();
    let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
    try {
      checkout = await createCleanValidationCheckout({
        sourceRoot: root,
        head,
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      expect(
        execFileSync('git', ['rev-list', '-1', 'HEAD', '--', 'stable.txt'], {
          cwd: checkout.root,
          encoding: 'utf8',
        }).trim(),
      ).toBe(stableCommit);
    } finally {
      checkout?.cleanup();
      await managed.close();
    }
  }, 60_000);

  it('does not make repository health treat unchanged documents as changed at HEAD', async () => {
    const source = repository({
      'docs/decision.md': [
        '---',
        'title: retained history',
        'status: active',
        'updated: 2026-07-03',
        'scope: root',
        '---',
        '',
        '# Still current',
      ].join('\n'),
    });
    execFileSync('git', ['commit', '--amend', '-q', '--no-edit', '--date=2026-07-03T00:00:00Z'], {
      cwd: source.root,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-07-03T00:00:00Z' },
    });
    writeFileSync(join(source.root, 'later.txt'), 'unrelated change\n');
    execFileSync('git', ['add', 'later.txt'], { cwd: source.root });
    execFileSync('git', ['commit', '-q', '-m', 'later change'], {
      cwd: source.root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-08-04T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-08-04T00:00:00Z',
      },
    });
    const managed = await createManagedProcessTestSession();
    let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
    try {
      checkout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      expect(runDoctor(checkout.root, { staleDays: 30 }).freshness?.issues).toEqual([]);
    } finally {
      checkout?.cleanup();
      await managed.close();
    }
  }, 60_000);

  it('fails closed when the developer repository has only shallow history', async () => {
    const source = repository({ 'stable.txt': 'first commit\n' });
    writeFileSync(join(source.root, 'later.txt'), 'second commit\n');
    execFileSync('git', ['add', 'later.txt'], { cwd: source.root });
    execFileSync('git', ['commit', '-q', '-m', 'later change'], { cwd: source.root });
    const shallowRoot = mkdtempSync(join(tmpdir(), 'coding-x-clean-shallow-'));
    roots.push(shallowRoot);
    rmSync(shallowRoot, { recursive: true });
    execFileSync(
      'git',
      ['clone', '-q', '--depth=1', pathToFileURL(source.root).href, shallowRoot],
      { cwd: tmpdir() },
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: shallowRoot,
      encoding: 'utf8',
    }).trim();
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: shallowRoot,
          head,
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({
        code: 'history-unverifiable',
        message: expect.stringContaining('shallow'),
      });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('fails closed without lazy fetching when the developer repository is partial/promisor', async () => {
    const source = repository({ 'source.txt': 'tracked payload\n'.repeat(24_000) });
    execFileSync('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: source.root });
    const blob = execFileSync('git', ['rev-parse', 'HEAD:source.txt'], {
      cwd: source.root,
      encoding: 'utf8',
    }).trim();
    const partialRoot = mkdtempSync(join(tmpdir(), 'coding-x-clean-partial-'));
    roots.push(partialRoot);
    rmSync(partialRoot, { recursive: true });
    execFileSync(
      'git',
      [
        'clone',
        '-q',
        '--filter=blob:none',
        '--no-checkout',
        pathToFileURL(source.root).href,
        partialRoot,
      ],
      { cwd: tmpdir() },
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: partialRoot,
      encoding: 'utf8',
    }).trim();
    const localObjects = (): string[] =>
      execFileSync('git', ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], {
        cwd: partialRoot,
        encoding: 'utf8',
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/u)
        .filter(Boolean)
        .sort();
    const objectsBefore = localObjects();
    expect(objectsBefore).not.toContain(blob);
    const missingPromisor = pathToFileURL(join(partialRoot, 'missing-promisor-source')).href;
    execFileSync('git', ['remote', 'set-url', 'origin', missingPromisor], { cwd: partialRoot });
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: partialRoot,
          head,
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({
        code: 'history-unverifiable',
        message: expect.stringContaining('partial/promisor'),
      });
      expect(localObjects()).toEqual(objectsBefore);
      expect(localObjects()).not.toContain(blob);
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('detects promisor configuration stored in config.worktree', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: source.root });
    execFileSync('git', ['config', '--worktree', 'remote.trap.promisor', 'true'], {
      cwd: source.root,
    });
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({
        code: 'history-unverifiable',
        message: expect.stringContaining('partial/promisor'),
      });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('fails closed when a reachable source object is missing', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const blob = execFileSync('git', ['rev-parse', 'HEAD:source.txt'], {
      cwd: source.root,
      encoding: 'utf8',
    }).trim();
    const objectPath = execFileSync(
      'git',
      ['rev-parse', '--git-path', `objects/${blob.slice(0, 2)}/${blob.slice(2)}`],
      { cwd: source.root, encoding: 'utf8' },
    ).trim();
    rmSync(resolve(source.root, objectPath));
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({
        code: 'history-unverifiable',
        message: expect.stringContaining('历史'),
      });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('rejects source replace refs instead of preflighting a different history graph', async () => {
    const source = repository({ 'stable.txt': 'first commit\n' });
    const original = source.head();
    writeFileSync(join(source.root, 'later.txt'), 'second commit\n');
    execFileSync('git', ['add', 'later.txt'], { cwd: source.root });
    execFileSync('git', ['commit', '-q', '-m', 'later change'], { cwd: source.root });
    execFileSync('git', ['replace', source.head(), original], { cwd: source.root });
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({
        code: 'history-unverifiable',
        message: expect.stringContaining('replace refs'),
      });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('rejects source grafts instead of preflighting a rewritten ancestry', async () => {
    const source = repository({ 'stable.txt': 'first commit\n' });
    writeFileSync(join(source.root, 'later.txt'), 'second commit\n');
    execFileSync('git', ['add', 'later.txt'], { cwd: source.root });
    execFileSync('git', ['commit', '-q', '-m', 'later change'], { cwd: source.root });
    const graftPath = execFileSync('git', ['rev-parse', '--git-path', 'info/grafts'], {
      cwd: source.root,
      encoding: 'utf8',
    }).trim();
    const absoluteGraftPath = resolve(source.root, graftPath);
    mkdirSync(dirname(absoluteGraftPath), { recursive: true });
    writeFileSync(absoluteGraftPath, `${source.head()}\n`);
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({
        code: 'history-unverifiable',
        message: expect.stringContaining('grafts'),
      });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('fetches only requested ancestry without copying unrelated refs or tag objects', async () => {
    const source = repository({ 'base.txt': 'base\n' });
    const base = source.head();
    writeFileSync(join(source.root, 'main.txt'), 'main\n');
    execFileSync('git', ['add', 'main.txt'], { cwd: source.root });
    execFileSync('git', ['commit', '-q', '-m', 'main change'], { cwd: source.root });
    const main = source.head();

    execFileSync('git', ['checkout', '-q', '-b', 'additional', base], { cwd: source.root });
    writeFileSync(join(source.root, 'additional.txt'), 'additional\n');
    execFileSync('git', ['add', 'additional.txt'], { cwd: source.root });
    execFileSync('git', ['commit', '-q', '-m', 'additional change'], { cwd: source.root });
    const additional = source.head();

    execFileSync('git', ['checkout', '-q', '-b', 'unrelated', base], { cwd: source.root });
    writeFileSync(join(source.root, 'unrelated.txt'), 'unrelated\n');
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: source.root });
    execFileSync('git', ['commit', '-q', '-m', 'unrelated change'], { cwd: source.root });
    const unrelated = source.head();
    const unrelatedBlob = execFileSync('git', ['rev-parse', 'HEAD:unrelated.txt'], {
      cwd: source.root,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['tag', '-a', 'unrelated-tag', '-m', 'unrelated tag'], {
      cwd: source.root,
    });
    const unrelatedTag = execFileSync('git', ['rev-parse', 'unrelated-tag'], {
      cwd: source.root,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: source.root });

    const managed = await createManagedProcessTestSession();
    let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
    try {
      checkout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: main,
        additionalRefs: [additional],
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      expect(
        execFileSync('git', ['merge-base', main, additional], {
          cwd: checkout.root,
          encoding: 'utf8',
        }).trim(),
      ).toBe(base);
      expect(
        execFileSync('git', ['for-each-ref', '--format=%(refname)'], {
          cwd: checkout.root,
          encoding: 'utf8',
        }),
      ).toBe('');
      for (const object of [unrelated, unrelatedBlob, unrelatedTag]) {
        expect(() =>
          execFileSync('git', ['cat-file', '-e', object], {
            cwd: checkout!.root,
            stdio: 'ignore',
          }),
        ).toThrow();
      }
    } finally {
      checkout?.cleanup();
      await managed.close();
    }
  }, 60_000);

  it('bounds history by logical object size even when source delta storage is tiny', async () => {
    const source = repository({ 'anchor.txt': 'anchor\n' });
    const basePayload = Buffer.alloc(1024 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < basePayload.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      basePayload[index] = state & 0xff;
    }
    const changedPayload = Buffer.from(basePayload);
    for (let index = 0; index < 64; index += 1) changedPayload[1024 + index] ^= 0xff;
    const writeObject = (args: string[], input: Buffer | string): string =>
      execFileSync('git', args, {
        cwd: source.root,
        input,
        encoding: 'utf8',
      }).trim();
    const firstBlob = writeObject(['hash-object', '-w', '--stdin'], basePayload);
    const secondBlob = writeObject(['hash-object', '-w', '--stdin'], changedPayload);
    const firstTree = writeObject(['mktree'], `100644 blob ${firstBlob}\tpayload.bin\n`);
    const secondTree = writeObject(['mktree'], `100644 blob ${secondBlob}\tpayload.bin\n`);
    const firstCommit = execFileSync('git', ['commit-tree', firstTree, '-m', 'delta first'], {
      cwd: source.root,
      encoding: 'utf8',
    }).trim();
    const secondCommit = execFileSync('git', ['commit-tree', secondTree, '-m', 'delta second'], {
      cwd: source.root,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/delta-first', firstCommit], {
      cwd: source.root,
    });
    execFileSync('git', ['update-ref', 'refs/heads/delta-second', secondCommit], {
      cwd: source.root,
    });
    execFileSync('git', ['repack', '-q', '-a', '-d', '-f', '--window=250', '--depth=50'], {
      cwd: source.root,
    });
    const metadata = writeObject(
      ['cat-file', '--batch-check=%(objectname) %(objectsize) %(objectsize:disk) %(deltabase)'],
      `${firstBlob}\n${secondBlob}\n`,
    )
      .split(/\r?\n/u)
      .map((line) => line.split(' '));
    const delta = metadata.find(
      ([object, , , deltaBase]) =>
        (object === firstBlob || object === secondBlob) && !/^0+$/u.test(deltaBase),
    );
    expect(delta, 'fixture must contain a packed delta').toBeDefined();
    const target = delta![0] === firstBlob ? firstCommit : secondCommit;
    const maxBytes = 64 * 1024;
    expect(Number(delta![2])).toBeLessThan(maxBytes);
    expect(Number(delta![1])).toBeGreaterThan(maxBytes);

    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: source.root,
          head: target,
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
          historyLimitsForTests: { maxBytes },
          repositoryUrlForTests: pathToFileURL(join(source.root, 'does-not-exist.git')).href,
        }),
      ).rejects.toMatchObject({
        code: 'history-unverifiable',
        message: expect.stringContaining('保守容量估算'),
      });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('rejects an unbounded number of requested history roots', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const additionalRefs = Array.from({ length: 16 }, (_, index) =>
      (index + 1).toString(16).padStart(40, '0'),
    );
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          additionalRefs,
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({
        code: 'invalid-source',
        message: expect.stringContaining('16'),
      });
    } finally {
      await managed.close();
    }
  });

  it.each([
    {
      label: 'reachable object count',
      limits: { maxObjects: 1 },
      diagnostic: 'Git 对象',
    },
    {
      label: 'reachable object conservative capacity',
      limits: { maxBytes: 1 },
      diagnostic: 'Git 历史保守容量估算',
    },
  ])(
    'fails closed before fetch when $label exceeds its budget',
    async ({ limits, diagnostic }) => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const missingRepository = pathToFileURL(join(source.root, 'does-not-exist.git')).href;
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          createCleanValidationCheckout({
            sourceRoot: source.root,
            head: source.head(),
            contract: contract(),
            managed: { session: managed.session, kind: 'quality-check' },
            historyLimitsForTests: limits,
            repositoryUrlForTests: missingRepository,
          }),
        ).rejects.toMatchObject({
          code: 'history-unverifiable',
          message: expect.stringContaining(diagnostic),
        });
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'does not treat a POSIX backslash filename as a child of an allowed directory',
    async () => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
      try {
        checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        writeFileSync(join(checkout.root, 'dist\\escaped.txt'), 'outside dist on POSIX\n');
        await expect(checkout.assertCurrent('POSIX 反斜杠路径测试')).rejects.toMatchObject({
          code: 'artifact-boundary-violated',
        });
      } finally {
        checkout?.cleanup();
        await managed.close();
      }
    },
    60_000,
  );

  it('rejects a hard link in an allowed artifact tree without changing its external target', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const managed = await createManagedProcessTestSession();
    try {
      const checkout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      mkdirSync(join(checkout.root, 'node_modules'));
      linkSync(
        join(source.root, 'source.txt'),
        join(checkout.root, 'node_modules', 'external-hard-link.txt'),
      );
      await expect(checkout.assertCurrent('hard link 产物测试')).rejects.toMatchObject({
        code: 'topology-unverifiable',
        message: expect.stringContaining('hard link'),
      });
      expect(checkout.cleanup()).toMatchObject({ status: 'removed' });
      expect(readFileSync(join(source.root, 'source.txt'), 'utf8')).toBe('tracked\n');
    } finally {
      await managed.close();
    }
  }, 60_000);

  it.runIf(LIVE_TEMPORARY_HARD_LINKS_TRUSTED)(
    'accepts complete hard link groups contained in one declared artifact root',
    async () => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
      try {
        checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        const first = join(checkout.root, 'node_modules', 'esbuild', 'bin', 'esbuild');
        const firstAlias = join(
          checkout.root,
          'node_modules',
          '@esbuild',
          'platform',
          'bin',
          'esbuild',
        );
        const second = join(checkout.root, 'node_modules', 'tsx', 'node_modules', 'esbuild', 'bin');
        const secondAlias = join(
          checkout.root,
          'node_modules',
          'tsx',
          'node_modules',
          '@esbuild',
          'platform',
          'bin',
        );
        mkdirSync(dirname(first), { recursive: true });
        mkdirSync(dirname(firstAlias), { recursive: true });
        mkdirSync(dirname(second), { recursive: true });
        mkdirSync(dirname(secondAlias), { recursive: true });
        writeFileSync(first, 'first binary\n');
        linkSync(first, firstAlias);
        writeFileSync(second, 'second binary\n');
        linkSync(second, secondAlias);

        await expect(checkout.assertCurrent('完整 hard link 组测试')).resolves.toBeUndefined();
      } finally {
        checkout?.cleanup();
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'rejects a complete hard link group that crosses declared artifact roots',
    async () => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
      try {
        checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        const dependency = join(checkout.root, 'node_modules', 'shared.bin');
        const output = join(checkout.root, 'dist', 'shared.bin');
        mkdirSync(dirname(dependency), { recursive: true });
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(dependency, 'shared\n');
        linkSync(dependency, output);

        await expect(checkout.assertCurrent('跨产物根 hard link 测试')).rejects.toMatchObject({
          code: 'topology-unverifiable',
          message: expect.stringContaining('跨越多个产物根'),
        });
      } finally {
        checkout?.cleanup();
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'rejects a hard link group that aliases tracked source into an artifact root',
    async () => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
      try {
        checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        const alias = join(checkout.root, 'node_modules', 'source-alias.txt');
        mkdirSync(dirname(alias), { recursive: true });
        linkSync(join(checkout.root, 'source.txt'), alias);

        await expect(checkout.assertCurrent('源码 hard link 别名测试')).rejects.toMatchObject({
          code: 'topology-unverifiable',
          message: expect.stringContaining('包含未声明为产物的路径'),
        });
      } finally {
        checkout?.cleanup();
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a special file in an allowed artifact tree',
    async () => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      try {
        const checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        mkdirSync(join(checkout.root, 'node_modules'));
        execFileSync('mkfifo', [join(checkout.root, 'node_modules', 'special-pipe')]);
        await expect(checkout.assertCurrent('特殊产物测试')).rejects.toMatchObject({
          code: 'topology-unverifiable',
          message: expect.stringContaining('特殊文件'),
        });
        expect(checkout.cleanup()).toMatchObject({ status: 'removed' });
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it('reports retained evidence when the checkout directory identity is replaced', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const escaped = mkdtempSync(join(tmpdir(), 'coding-x-escaped-placeholder-'));
    rmSync(escaped, { recursive: true });
    const managed = await createManagedProcessTestSession();
    try {
      const checkout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      const container = dirname(checkout.root);
      renameSync(checkout.root, escaped);
      mkdirSync(checkout.root);
      const cleanup = checkout.cleanup();
      expect(cleanup.status).toBe('location-unverifiable');
      expect(realpathSync(dirname(cleanup.path))).toBe(realpathSync(dirname(container)));
      expect(realpathSync(cleanup.path)).toBe(realpathSync(container));
      expect(cleanup.reason).toContain('实际位置');
      expect(managed.session.state).toBe('isolated');
      expect(existsSync(escaped)).toBe(true);
      rmSync(escaped, { recursive: true, force: true });
      rmSync(container, { recursive: true, force: true });
    } finally {
      await expect(managed.close()).rejects.toMatchObject({ code: 'isolated' });
    }
  }, 60_000);

  it('keeps a failed manager cleanup as an isolation fence for later acquisitions', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const escaped = mkdtempSync(join(tmpdir(), 'coding-x-manager-escaped-'));
    rmSync(escaped, { recursive: true });
    const managed = await createManagedProcessTestSession();
    let container = '';
    try {
      const manager = new CleanValidationCheckoutManager(source.root, contract(), {
        session: managed.session,
        kind: 'quality-check',
      });
      const checkout = await manager.acquire(source.head());
      container = dirname(checkout.root);
      renameSync(checkout.root, escaped);
      mkdirSync(checkout.root);
      expect(manager.dispose()).toMatchObject({ status: 'location-unverifiable' });
      expect(managed.session.state).toBe('isolated');
      await expect(manager.acquire(source.head())).rejects.toMatchObject({
        code: 'cleanup-unverifiable',
      });
      expect(manager.dispose()).toMatchObject({ status: 'location-unverifiable' });
      rmSync(escaped, { recursive: true, force: true });
      rmSync(container, { recursive: true, force: true });
    } finally {
      if (existsSync(escaped)) rmSync(escaped, { recursive: true, force: true });
      if (container && existsSync(container)) rmSync(container, { recursive: true, force: true });
      await expect(managed.close()).rejects.toMatchObject({ code: 'isolated' });
    }
  }, 60_000);

  it('rejects tracked changes and rebuilds every acquisition, including the same HEAD', async () => {
    const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'H1\n' });
    const managed = await createManagedProcessTestSession();
    try {
      const manager = new CleanValidationCheckoutManager(source.root, contract(), {
        session: managed.session,
        kind: 'quality-check',
      });
      const h1 = source.head();
      const first = await manager.acquire(h1);
      mkdirSync(join(first.root, 'node_modules'));
      writeFileSync(join(first.root, 'node_modules', 'polluted.js'), 'polluted\n');
      writeFileSync(join(first.root, 'source.txt'), 'changed\n');
      await expect(first.assertCurrent('tracked 改写测试')).rejects.toMatchObject({
        code: 'tracked-content-changed',
      });
      const sameHead = await manager.acquire(h1, [h1, h1]);
      expect(sameHead.root).not.toBe(first.root);
      expect(sameHead.additionalRefs).toEqual([]);
      expect(existsSync(first.root)).toBe(false);
      expect(existsSync(join(sameHead.root, 'node_modules'))).toBe(false);
      writeFileSync(join(source.root, 'source.txt'), 'H2\n');
      execFileSync('git', ['add', 'source.txt'], { cwd: source.root });
      execFileSync('git', ['commit', '-q', '-m', 'H2'], { cwd: source.root });
      const nextHead = await manager.acquire(source.head());
      expect(nextHead.root).not.toBe(sameHead.root);
      expect(existsSync(sameHead.root)).toBe(false);
      expect(readFileSync(join(nextHead.root, 'source.txt'), 'utf8')).toBe('H2\n');
      expect(manager.dispose()).toMatchObject({ status: 'removed' });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('cleans a newly created checkout before rejecting a wrong returned digest', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const managed = await createManagedProcessTestSession();
    let createdRoot = '';
    let cleanupCalls = 0;
    try {
      const manager = new CleanValidationCheckoutManager(
        source.root,
        contract(),
        { session: managed.session, kind: 'quality-check' },
        async (options) => {
          const created = await createCleanValidationCheckout(options);
          createdRoot = created.root;
          return {
            ...created,
            environmentDigest: `sha256:${'0'.repeat(64)}`,
            cleanup: () => {
              cleanupCalls += 1;
              return created.cleanup();
            },
          };
        },
      );
      await expect(manager.acquire(source.head())).rejects.toMatchObject({
        code: 'identity-changed',
      });
      expect(cleanupCalls).toBe(1);
      expect(createdRoot).not.toBe('');
      expect(existsSync(createdRoot)).toBe(false);
      expect(manager.dispose()).toBeNull();
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('freezes the manager contract before asynchronous checkout work begins', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const rules = contract();
    const managed = await createManagedProcessTestSession();
    try {
      const manager = new CleanValidationCheckoutManager(source.root, rules, {
        session: managed.session,
        kind: 'quality-check',
      });
      rules.generatedPaths.push('escaped/**');
      const checkout = await manager.acquire(source.head());
      mkdirSync(join(checkout.root, 'escaped'));
      writeFileSync(join(checkout.root, 'escaped', 'output.txt'), 'not approved\n');
      await expect(checkout.assertCurrent('冻结契约测试')).rejects.toMatchObject({
        code: 'artifact-boundary-violated',
      });
      expect(manager.dispose()).toMatchObject({ status: 'removed' });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('rejects changes to private Git policy controls before later validation stages', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const managed = await createManagedProcessTestSession();
    try {
      const checkout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      const replaceDirectory = join(checkout.root, '.git', 'refs', 'replace');
      mkdirSync(replaceDirectory, { recursive: true });
      writeFileSync(join(replaceDirectory, source.head()), `${source.head()}\n`);
      await expect(checkout.assertCurrent('Git replace 攻击测试')).rejects.toMatchObject({
        code: 'identity-changed',
      });
      expect(checkout.cleanup()).toMatchObject({ status: 'removed' });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('binds the complete Git index and object database hidden state', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const managed = await createManagedProcessTestSession();
    try {
      const indexCheckout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      const indexPath = join(indexCheckout.root, '.git', 'index');
      writeFileSync(indexPath, Buffer.concat([readFileSync(indexPath), Buffer.from('hidden')]));
      await expect(indexCheckout.assertCurrent('Git index 隐藏状态测试')).rejects.toMatchObject({
        code: 'identity-changed',
      });
      expect(indexCheckout.cleanup()).toMatchObject({ status: 'removed' });

      const objectCheckout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract(),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      const hiddenObjectDirectory = join(objectCheckout.root, '.git', 'objects', 'aa');
      mkdirSync(hiddenObjectDirectory, { recursive: true });
      writeFileSync(join(hiddenObjectDirectory, '0'.repeat(38)), 'hidden object state');
      await expect(
        objectCheckout.assertCurrent('Git object DB 隐藏状态测试'),
      ).rejects.toMatchObject({ code: 'identity-changed' });
      expect(objectCheckout.cleanup()).toMatchObject({ status: 'removed' });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('removes project-scoped process environment from preparation', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const external = mkdtempSync(join(tmpdir(), 'coding-x-external-config-'));
    const names = [
      'VIRTUAL_ENV',
      'PYTHONPATH',
      'NODE_PATH',
      'NODE_OPTIONS',
      'GOWORK',
      'GOFLAGS',
      'MAKEFILES',
      'BABEL_CONFIG_FILE',
      'PATH',
    ] as const;
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.VIRTUAL_ENV = join(source.root, '.venv');
    process.env.PYTHONPATH = source.root;
    process.env.NODE_PATH = join(source.root, 'node_modules');
    process.env.NODE_OPTIONS = `--require=${join(source.root, 'ignored-hook.cjs')}`;
    process.env.GOWORK = join(external, 'old-go.work');
    process.env.GOFLAGS = `-overlay=${join(external, 'old-overlay.json')}`;
    process.env.MAKEFILES = join(external, 'old.mk');
    process.env.BABEL_CONFIG_FILE = join(external, 'old-babel.json');
    process.env.PATH = `${join(source.root, '.venv', 'bin')}${delimiter}${saved.PATH ?? ''}`;
    const managed = await createManagedProcessTestSession();
    let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
    try {
      checkout = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract({
          prepare: [
            {
              executable: process.execPath,
              args: [
                '-e',
                "require('node:fs').mkdirSync('dist'); require('node:fs').writeFileSync('dist/env.json', JSON.stringify({ cwd: process.cwd(), projectRoot: process.env.CODING_X_PROJECT_ROOT, virtualEnv: process.env.VIRTUAL_ENV ?? null, pythonPath: process.env.PYTHONPATH ?? null, nodePath: process.env.NODE_PATH ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, goWork: process.env.GOWORK ?? null, goFlags: process.env.GOFLAGS ?? null, makefiles: process.env.MAKEFILES ?? null, babelConfig: process.env.BABEL_CONFIG_FILE ?? null, path: process.env.PATH }))",
              ],
              cwd: '.',
              platforms:
                process.platform === 'win32'
                  ? ['windows']
                  : process.platform === 'darwin'
                    ? ['macos']
                    : ['linux'],
              timeoutMs: 5_000,
            },
          ],
        }),
        managed: { session: managed.session, kind: 'quality-check' },
      });
      const observed = JSON.parse(
        readFileSync(join(checkout.root, 'dist', 'env.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(observed).toMatchObject({
        cwd: checkout.root,
        projectRoot: checkout.root,
        virtualEnv: null,
        pythonPath: null,
        nodePath: null,
        nodeOptions: null,
        goWork: null,
        goFlags: null,
        makefiles: null,
        babelConfig: null,
      });
      expect(String(observed.path)).not.toContain(source.root);
    } finally {
      for (const name of names) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      checkout?.cleanup();
      await managed.close();
      rmSync(external, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(PYTHON_EXECUTABLE !== null)(
    'runs an explicit Python monorepo venv contract without host project environment',
    async () => {
      const source = repository({
        '.gitignore': '.coding-x-validation/\n',
        'packages/api/pyproject.toml': '[project]\nname="api"\nversion="0.1.0"\n',
        'packages/worker/pyproject.toml': '[project]\nname="worker"\nversion="0.1.0"\n',
      });
      const validationDirectory = '.coding-x-validation';
      const venvDirectory = join(validationDirectory, 'venv');
      const venvPython = join(
        venvDirectory,
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      );
      const platform =
        process.platform === 'win32'
          ? 'windows'
          : process.platform === 'darwin'
            ? 'macos'
            : 'linux';
      const previousVirtualEnv = process.env.VIRTUAL_ENV;
      const previousPythonPath = process.env.PYTHONPATH;
      process.env.VIRTUAL_ENV = join(source.root, '.host-venv');
      process.env.PYTHONPATH = join(source.root, 'host-python-path');
      const managed = await createManagedProcessTestSession();
      let checkout: Awaited<ReturnType<typeof createCleanValidationCheckout>> | null = null;
      try {
        checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract({
            allowedPaths: [`${validationDirectory}/**`],
            prepare: [
              {
                executable: PYTHON_EXECUTABLE!,
                args: ['-m', 'venv', venvDirectory],
                cwd: '.',
                platforms: [platform],
                timeoutMs: 60_000,
              },
              {
                executable: venvPython,
                args: [
                  '-c',
                  "import json,os,pathlib; pathlib.Path('.coding-x-validation/observed.json').write_text(json.dumps({'cwd': os.getcwd(), 'virtualEnv': os.environ.get('VIRTUAL_ENV'), 'pythonPath': os.environ.get('PYTHONPATH')}))",
                ],
                cwd: '.',
                platforms: [platform],
                timeoutMs: 10_000,
              },
            ],
          }),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        expect(existsSync(join(checkout.root, 'packages/api/pyproject.toml'))).toBe(true);
        expect(existsSync(join(checkout.root, 'packages/worker/pyproject.toml'))).toBe(true);
        expect(
          JSON.parse(
            readFileSync(join(checkout.root, validationDirectory, 'observed.json'), 'utf8'),
          ),
        ).toEqual({ cwd: checkout.root, virtualEnv: null, pythonPath: null });
        await checkout.assertCurrent('Python venv fixture');
      } finally {
        if (previousVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
        else process.env.VIRTUAL_ENV = previousVirtualEnv;
        if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
        else process.env.PYTHONPATH = previousPythonPath;
        checkout?.cleanup();
        await managed.close();
      }
    },
    90_000,
  );

  it.runIf(process.platform !== 'win32')(
    'rejects an external directory link before later validation can write through it',
    async () => {
      const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'tracked\n' });
      const external = mkdtempSync(join(tmpdir(), 'coding-x-external-artifact-'));
      roots.push(external);
      const escaped = join(external, 'escaped.txt');
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          (async () => {
            const checkout = await createCleanValidationCheckout({
              sourceRoot: source.root,
              head: source.head(),
              contract: contract({
                prepare: [
                  {
                    executable: process.execPath,
                    args: [
                      '-e',
                      `require('node:fs').mkdirSync('node_modules'); require('node:fs').symlinkSync(${JSON.stringify(external)}, 'node_modules/external', 'dir')`,
                    ],
                    cwd: '.',
                    platforms: ['linux', 'macos'],
                    timeoutMs: 5_000,
                  },
                ],
              }),
              managed: { session: managed.session, kind: 'quality-check' },
            });
            try {
              writeFileSync(
                join(checkout.root, 'node_modules', 'external', 'escaped.txt'),
                'escape\n',
              );
              await checkout.assertCurrent('外部目录链接写入测试');
            } finally {
              checkout.cleanup();
            }
          })(),
        ).rejects.toMatchObject({ code: 'topology-unverifiable' });
        expect(existsSync(escaped)).toBe(false);
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a prepared link into the checkout Git control file',
    async () => {
      const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          createCleanValidationCheckout({
            sourceRoot: source.root,
            head: source.head(),
            contract: contract({
              prepare: [
                {
                  executable: process.execPath,
                  args: [
                    '-e',
                    "require('node:fs').mkdirSync('node_modules'); require('node:fs').symlinkSync('../.git', 'node_modules/git-control')",
                  ],
                  cwd: '.',
                  platforms: ['linux', 'macos'],
                  timeoutMs: 5_000,
                },
              ],
            }),
            managed: { session: managed.session, kind: 'quality-check' },
          }),
        ).rejects.toMatchObject({
          code: 'topology-unverifiable',
          message: expect.stringMatching(/Git control directory|Git 控制/u),
        });
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'accepts many stable npm-style links to plain files inside the checkout',
    async () => {
      const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      try {
        const checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract({
            prepare: [
              {
                executable: process.execPath,
                args: [
                  '-e',
                  "const fs=require('node:fs'); fs.mkdirSync('node_modules/.bin',{recursive:true}); for(let i=0;i<64;i++){fs.mkdirSync('node_modules/tool-'+i,{recursive:true}); fs.writeFileSync('node_modules/tool-'+i+'/cli.js','tool '+i+'\\n'); fs.symlinkSync('../tool-'+i+'/cli.js','node_modules/.bin/tool-'+i)}",
                ],
                cwd: '.',
                platforms: ['linux', 'macos'],
                timeoutMs: 10_000,
              },
            ],
          }),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        try {
          await checkout.assertCurrent('大量内部命令链接复核');
          expect(realpathSync(join(checkout.root, 'node_modules', '.bin', 'tool-63'))).toBe(
            join(checkout.root, 'node_modules', 'tool-63', 'cli.js'),
          );
        } finally {
          expect(checkout.cleanup()).toMatchObject({ status: 'removed' });
        }
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'bounds prepared external file links even when they share one target',
    async () => {
      const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          createCleanValidationCheckout({
            sourceRoot: source.root,
            head: source.head(),
            contract: contract({
              prepare: [
                {
                  executable: process.execPath,
                  args: [
                    '-e',
                    `const fs=require('node:fs'); fs.mkdirSync('node_modules'); for(let i=0;i<1025;i++) fs.symlinkSync(${JSON.stringify(process.execPath)}, 'node_modules/tool-'+i)`,
                  ],
                  cwd: '.',
                  platforms: ['linux', 'macos'],
                  timeoutMs: 10_000,
                },
              ],
            }),
            managed: { session: managed.session, kind: 'quality-check' },
          }),
        ).rejects.toMatchObject({
          code: 'topology-unverifiable',
          message: expect.stringContaining('需受管核对的普通文件链接超过 1024 条'),
        });
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'rejects links to the developer tree but permits a prepared system interpreter link',
    async () => {
      const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'tracked\n' });
      mkdirSync(join(source.root, 'node_modules'));
      writeFileSync(join(source.root, 'node_modules', 'stale.js'), 'stale\n');
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          createCleanValidationCheckout({
            sourceRoot: source.root,
            head: source.head(),
            contract: contract({
              prepare: [
                {
                  executable: process.execPath,
                  args: [
                    '-e',
                    `require('node:fs').mkdirSync('node_modules'); require('node:fs').symlinkSync(${JSON.stringify(join(source.root, 'node_modules'))}, 'node_modules/stale')`,
                  ],
                  cwd: '.',
                  platforms: ['linux', 'macos'],
                  timeoutMs: 5_000,
                },
              ],
            }),
            managed: { session: managed.session, kind: 'quality-check' },
          }),
        ).rejects.toMatchObject({ code: 'prepare-failed' });

        const prepared = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract({
            prepare: [
              {
                executable: process.execPath,
                args: [
                  '-e',
                  `require('node:fs').mkdirSync('node_modules'); require('node:fs').symlinkSync(${JSON.stringify(process.execPath)}, 'node_modules/system-node')`,
                ],
                cwd: '.',
                platforms: ['linux', 'macos'],
                timeoutMs: 5_000,
              },
            ],
          }),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        await prepared.assertCurrent('外部普通文件链接复核');
        rmSync(join(prepared.root, 'node_modules', 'system-node'));
        symlinkSync(process.execPath, join(prepared.root, 'node_modules', 'system-node'));
        await expect(prepared.assertCurrent('外部普通文件链接替换后')).rejects.toMatchObject({
          code: 'topology-unverifiable',
        });
        expect(prepared.cleanup()).toMatchObject({ status: 'removed' });
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'invalidates a prepared external file link when its target is written',
    async () => {
      const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'tracked\n' });
      const external = mkdtempSync(join(tmpdir(), 'coding-x-external-file-'));
      roots.push(external);
      const target = join(external, 'tool');
      writeFileSync(target, 'original\n');
      const managed = await createManagedProcessTestSession();
      try {
        const checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract({
            prepare: [
              {
                executable: process.execPath,
                args: [
                  '-e',
                  `require('node:fs').mkdirSync('node_modules'); require('node:fs').symlinkSync(${JSON.stringify(target)}, 'node_modules/tool')`,
                ],
                cwd: '.',
                platforms: ['linux', 'macos'],
                timeoutMs: 5_000,
              },
            ],
          }),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        try {
          await checkout.assertCurrent('外部普通文件链接写入前');
          writeFileSync(join(checkout.root, 'node_modules', 'tool'), 'changed\n');
          await expect(checkout.assertCurrent('外部普通文件链接写入后')).rejects.toMatchObject({
            code: 'topology-unverifiable',
          });
        } finally {
          expect(checkout.cleanup()).toMatchObject({ status: 'removed' });
        }
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform === 'linux')(
    'rejects a procfs magic link whose self target changes between consumers',
    async () => {
      const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          createCleanValidationCheckout({
            sourceRoot: source.root,
            head: source.head(),
            contract: contract({
              prepare: [
                {
                  executable: process.execPath,
                  args: [
                    '-e',
                    "require('node:fs').mkdirSync('node_modules'); require('node:fs').symlinkSync('/proc/self/exe', 'node_modules/runtime')",
                  ],
                  cwd: '.',
                  platforms: ['linux'],
                  timeoutMs: 5_000,
                },
              ],
            }),
            managed: { session: managed.session, kind: 'quality-check' },
          }),
        ).rejects.toMatchObject({ code: 'topology-unverifiable' });
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'invalidates a prepared external file link when its target is replaced with identical content',
    async () => {
      const source = repository({ '.gitignore': 'node_modules/\n', 'source.txt': 'tracked\n' });
      const external = mkdtempSync(join(tmpdir(), 'coding-x-external-file-'));
      roots.push(external);
      const target = join(external, 'tool');
      const replacement = join(external, 'replacement');
      writeFileSync(target, 'original\n');
      const originalIdentity = lstatSync(target, { bigint: true });
      const managed = await createManagedProcessTestSession();
      try {
        const checkout = await createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract({
            prepare: [
              {
                executable: process.execPath,
                args: [
                  '-e',
                  `require('node:fs').mkdirSync('node_modules'); require('node:fs').symlinkSync(${JSON.stringify(target)}, 'node_modules/tool')`,
                ],
                cwd: '.',
                platforms: ['linux', 'macos'],
                timeoutMs: 5_000,
              },
            ],
          }),
          managed: { session: managed.session, kind: 'quality-check' },
        });
        try {
          writeFileSync(replacement, 'original\n');
          const replacementIdentity = lstatSync(replacement, { bigint: true });
          expect({ dev: replacementIdentity.dev, ino: replacementIdentity.ino }).not.toEqual({
            dev: originalIdentity.dev,
            ino: originalIdentity.ino,
          });
          renameSync(replacement, target);
          expect(realpathSync(join(checkout.root, 'node_modules', 'tool'))).toBe(
            realpathSync(target),
          );
          await expect(checkout.assertCurrent('外部普通文件链接目标替换后')).rejects.toMatchObject({
            code: 'topology-unverifiable',
          });
        } finally {
          expect(checkout.cleanup()).toMatchObject({ status: 'removed' });
        }
      } finally {
        await managed.close();
      }
    },
    60_000,
  );

  it('fails closed for submodules and checkout filters', async () => {
    const filtered = repository({
      '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
      'payload.bin': 'version https://git-lfs.github.com/spec/v1\n',
    });
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: filtered.root,
          head: filtered.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({ code: 'unsupported-git-content' });

      const pointerOnly = repository({
        'payload.bin': [
          'version https://git-lfs.github.com/spec/v1',
          `oid sha256:${'0'.repeat(64)}`,
          'size 123',
          '',
        ].join('\n'),
      });
      await expect(
        createCleanValidationCheckout({
          sourceRoot: pointerOnly.root,
          head: pointerOnly.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({ code: 'unsupported-git-content' });

      const submodule = repository({ 'source.txt': 'root\n' });
      const commit = submodule.head();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${commit},vendor/sub`], {
        cwd: submodule.root,
      });
      execFileSync('git', ['commit', '-q', '-m', 'gitlink'], { cwd: submodule.root });
      await expect(
        createCleanValidationCheckout({
          sourceRoot: submodule.root,
          head: submodule.head(),
          contract: contract(),
          managed: { session: managed.session, kind: 'quality-check' },
        }),
      ).rejects.toMatchObject({ code: 'unsupported-git-content' });
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('cleans failed or source-mutating preparation without accepting the environment', async () => {
    const source = repository({ 'source.txt': 'tracked\n' });
    const created: string[] = [];
    const managed = await createManagedProcessTestSession();
    try {
      await expect(
        createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract({
            prepare: [
              {
                executable: process.execPath,
                args: ['-e', 'process.exit(4)'],
                cwd: '.',
                platforms:
                  process.platform === 'win32'
                    ? ['windows']
                    : process.platform === 'darwin'
                      ? ['macos']
                      : ['linux'],
                timeoutMs: 5_000,
              },
            ],
          }),
          managed: { session: managed.session, kind: 'quality-check' },
          onContainerCreatedForTests: (path) => created.push(path),
        }),
      ).rejects.toMatchObject({ code: 'prepare-failed' });

      await expect(
        createCleanValidationCheckout({
          sourceRoot: source.root,
          head: source.head(),
          contract: contract({
            prepare: [
              {
                executable: process.execPath,
                args: [
                  '-e',
                  "require('node:fs').writeFileSync('source.txt', 'changed by prepare\\n')",
                ],
                cwd: '.',
                platforms:
                  process.platform === 'win32'
                    ? ['windows']
                    : process.platform === 'darwin'
                      ? ['macos']
                      : ['linux'],
                timeoutMs: 5_000,
              },
            ],
          }),
          managed: { session: managed.session, kind: 'quality-check' },
          onContainerCreatedForTests: (path) => created.push(path),
        }),
      ).rejects.toMatchObject({ code: 'tracked-content-changed' });

      const prepared = await createCleanValidationCheckout({
        sourceRoot: source.root,
        head: source.head(),
        contract: contract({
          prepare: [
            {
              executable: process.execPath,
              args: [
                '-e',
                "require('node:fs').mkdirSync('node_modules', { recursive: true }); require('node:fs').writeFileSync('node_modules/prepared.txt', 'ok\\n')",
              ],
              cwd: '.',
              platforms:
                process.platform === 'win32'
                  ? ['windows']
                  : process.platform === 'darwin'
                    ? ['macos']
                    : ['linux'],
              timeoutMs: 5_000,
            },
          ],
        }),
        managed: { session: managed.session, kind: 'quality-check' },
        onContainerCreatedForTests: (path) => created.push(path),
      });
      expect(readFileSync(join(prepared.root, 'node_modules', 'prepared.txt'), 'utf8')).toBe(
        'ok\n',
      );
      expect(prepared.cleanup()).toMatchObject({ status: 'removed' });
      expect(created).toHaveLength(3);
      expect(created.every((path) => !existsSync(path))).toBe(true);
    } finally {
      await managed.close();
    }
  }, 60_000);

  it.runIf(process.platform !== 'win32')(
    'reports an unverifiable location when preparation moves the checkout before creation fails',
    async () => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const managed = await createManagedProcessTestSession();
      let container = '';
      try {
        await expect(
          createCleanValidationCheckout({
            sourceRoot: source.root,
            head: source.head(),
            contract: contract({
              prepare: [
                {
                  executable: process.execPath,
                  args: [
                    '-e',
                    "const fs=require('node:fs'); const cwd=process.cwd(); fs.renameSync(cwd, cwd + '-escaped'); fs.mkdirSync(cwd); process.exit(4)",
                  ],
                  cwd: '.',
                  platforms: ['linux', 'macos'],
                  timeoutMs: 5_000,
                },
              ],
            }),
            managed: { session: managed.session, kind: 'quality-check' },
            onContainerCreatedForTests: (path) => {
              container = path;
            },
          }),
        ).rejects.toMatchObject({
          code: 'prepare-failed',
          message: expect.stringContaining('实际位置无法确认'),
        });
        expect(existsSync(join(container, 'checkout-escaped'))).toBe(true);
      } finally {
        if (container) rmSync(container, { recursive: true, force: true });
        await expect(managed.close()).rejects.toMatchObject({ code: 'isolated' });
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a TMPDIR alias that resolves inside the developer tree',
    async () => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const sourceTemporary = join(source.root, '.local-tmp');
      mkdirSync(sourceTemporary);
      const aliasContainer = mkdtempSync(join(tmpdir(), 'coding-x-tmp-alias-'));
      const alias = join(aliasContainer, 'external-looking-tmp');
      symlinkSync(sourceTemporary, alias, 'dir');
      const managed = await createManagedProcessTestSession();
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = alias;
      try {
        await expect(
          createCleanValidationCheckout({
            sourceRoot: source.root,
            head: source.head(),
            contract: contract(),
            managed: { session: managed.session, kind: 'quality-check' },
          }),
        ).rejects.toMatchObject({ code: 'invalid-source' });
        expect(existsSync(join(sourceTemporary, 'checkout'))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        rmSync(aliasContainer, { recursive: true, force: true });
        await managed.close();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'rejects an external PATH entry whose Git link resolves into the developer tree',
    async () => {
      const source = repository({ 'source.txt': 'tracked\n' });
      const head = source.head();
      const maliciousGit = join(source.root, 'developer-git');
      const marker = join(source.root, 'developer-git-ran');
      writeFileSync(maliciousGit, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`);
      chmodSync(maliciousGit, 0o755);
      const externalBin = mkdtempSync(join(tmpdir(), 'coding-x-external-bin-'));
      symlinkSync(maliciousGit, join(externalBin, 'git'));
      const managed = await createManagedProcessTestSession();
      const previousPath = process.env.PATH;
      process.env.PATH = `${externalBin}${delimiter}${previousPath ?? ''}`;
      try {
        await expect(
          createCleanValidationCheckout({
            sourceRoot: source.root,
            head,
            contract: contract(),
            managed: { session: managed.session, kind: 'quality-check' },
          }),
        ).rejects.toMatchObject({ code: 'invalid-source' });
        expect(existsSync(marker)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(externalBin, { recursive: true, force: true });
        await managed.close();
      }
    },
    60_000,
  );
});

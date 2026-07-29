import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertTrustedGhEnvironment,
  execTrustedToolSync,
  readTrustedGitBlobUtf8Sync,
  TrustedGitBlobUtf8Error,
} from './trusted-tool.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('trusted Git execution', () => {
  it('strictly preserves valid UTF-8 blob bytes and rejects invalid encoding', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-git-blob-utf8-'));
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'trusted-git@test.local']);
      git(root, ['config', 'user.name', 'trusted-git-test']);
      const valid = Buffer.from('\ufeffvalid \ufffd text\n', 'utf8');
      writeFileSync(join(root, 'source.txt'), valid);
      git(root, ['add', 'source.txt']);
      git(root, ['commit', '-q', '-m', 'valid utf8']);
      const validHead = git(root, ['rev-parse', 'HEAD']);

      const read = readTrustedGitBlobUtf8Sync(root, validHead, 'source.txt');
      expect(read.bytes).toBe(valid.length);
      expect(Buffer.from(read.content, 'utf8')).toEqual(valid);
      expect(read.content).toContain('\ufffd');

      writeFileSync(join(root, 'source.txt'), Buffer.from([0x76, 0x61, 0x6c, 0x69, 0x64, 0xff]));
      git(root, ['add', 'source.txt']);
      git(root, ['commit', '-q', '-m', 'invalid utf8']);
      const invalidHead = git(root, ['rev-parse', 'HEAD']);
      expect(() => readTrustedGitBlobUtf8Sync(root, invalidHead, 'source.txt')).toThrow(
        TrustedGitBlobUtf8Error,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops all inherited GIT_* controls before invoking Git', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-git-environment-'));
    try {
      git(root, ['init', '-q', '-b', 'main']);
      const trace = join(root, 'git-trace.log');
      execTrustedToolSync('git', ['status', '--porcelain=v1'], {
        cwd: root,
        projectRoot: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TRACE: trace, GIT_SHALLOW_FILE: join(root, 'shallow') },
      });
      expect(existsSync(trace)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an oversized repository control file without loading it unboundedly', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-git-large-config-'));
    try {
      git(root, ['init', '-q', '-b', 'main']);
      appendFileSync(join(root, '.git', 'config'), `\n# ${'x'.repeat(4 * 1024 * 1024)}\n`);
      expect(() =>
        execTrustedToolSync('git', ['status', '--porcelain=v1'], {
          cwd: root,
          projectRoot: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow(/超过/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'times out on a FIFO Git control file and leaves later invocations usable',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'trusted-git-fifo-'));
      const head = join(root, '.git', 'HEAD');
      const saved = join(root, '.git', 'HEAD.saved');
      try {
        git(root, ['init', '-q', '-b', 'main']);
        renameSync(head, saved);
        execFileSync('mkfifo', [head]);
        const started = Date.now();
        expect(() =>
          execTrustedToolSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
            cwd: root,
            projectRoot: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 250,
          }),
        ).toThrow();
        expect(Date.now() - started).toBeLessThan(2_000);

        rmSync(head, { force: true });
        renameSync(saved, head);
        expect(
          execTrustedToolSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
            cwd: root,
            projectRoot: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 1_000,
          }).trim(),
        ).toBe('main');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('rejects local Git includes before they can load mutable project configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-git-include-'));
    try {
      git(root, ['init', '-q', '-b', 'main']);
      writeFileSync(join(root, 'project.gitconfig'), '[filter "unsafe"]\nclean = ./project-code\n');
      appendFileSync(join(root, '.git', 'config'), '\n[include]\n\tpath = ../project.gitconfig\n');

      expect(() =>
        execTrustedToolSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          projectRoot: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow('动态 include');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows a Husky-style local hooksPath while disabling it for trusted Git', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-git-hooks-path-'));
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'core.hooksPath', '.husky/_']);

      const configured = execTrustedToolSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        projectRoot: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

      expect(configured).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
      expect(
        execTrustedToolSync('git', ['status', '--porcelain=v1'], {
          cwd: root,
          projectRoot: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a pre-existing alternate core.worktree instead of freezing it as trusted', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-git-worktree-'));
    const alternate = mkdtempSync(join(tmpdir(), 'trusted-git-worktree-alt-'));
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'core.worktree', alternate]);

      expect(() =>
        execTrustedToolSync('git', ['status', '--porcelain=v1'], {
          cwd: root,
          projectRoot: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow('core.worktree');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(alternate, { recursive: true, force: true });
    }
  });

  it('reads the real bound commit even when the repository already contains a replace ref', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-git-replace-'));
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'trusted-git@test.local']);
      git(root, ['config', 'user.name', 'trusted-git-test']);
      git(root, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(root, 'source.txt'), 'real content\n');
      git(root, ['add', 'source.txt']);
      git(root, ['commit', '-q', '-m', 'real']);
      const realHead = git(root, ['rev-parse', 'HEAD']);

      writeFileSync(join(root, 'source.txt'), 'replacement content\n');
      git(root, ['add', 'source.txt']);
      git(root, ['commit', '-q', '-m', 'replacement']);
      const replacement = git(root, ['rev-parse', 'HEAD']);
      git(root, ['reset', '--hard', '-q', realHead]);
      git(root, ['replace', realHead, replacement]);

      const content = execTrustedToolSync('git', ['show', `${realHead}:source.txt`], {
        cwd: root,
        projectRoot: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(content).toBe('real content\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an oversized replace-ref directory while applying the entry bound during traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-git-replace-limit-'));
    try {
      git(root, ['init', '-q', '-b', 'main']);
      const replaceRoot = join(root, '.git', 'refs', 'replace');
      mkdirSync(replaceRoot, { recursive: true });
      for (let index = 0; index < 10_000; index += 1) {
        writeFileSync(join(replaceRoot, `entry-${index.toString().padStart(5, '0')}`), '');
      }

      expect(() =>
        execTrustedToolSync('git', ['status', '--porcelain=v1'], {
          cwd: root,
          projectRoot: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow('Git replace refs 控制目录条目过多');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('trusted gh environment', () => {
  it('rejects lexical and real configuration roots inside the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'trusted-gh-environment-'));
    const outside = mkdtempSync(join(tmpdir(), 'trusted-gh-environment-link-'));
    try {
      expect(() => assertTrustedGhEnvironment(root, { GH_CONFIG_DIR: join(root, '.gh') })).toThrow(
        /GH_CONFIG_DIR/,
      );
      if (process.platform !== 'win32') {
        const linked = join(outside, 'linked-home');
        symlinkSync(root, linked, 'dir');
        expect(() => assertTrustedGhEnvironment(root, { HOME: linked })).toThrow(/真实路径/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

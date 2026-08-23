import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  freezeCleanValidationHardLinks,
  observeCleanValidationHardLink,
  snapshotCleanValidationHardLinks,
} from './clean-validation-hard-links.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')(
  'clean validation hard link proof',
  () => {
    it('freezes a complete three-name group inside one artifact root', () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-hard-links-complete-'));
      roots.push(root);
      const paths = ['one', 'two', 'three'].map((name) => join(root, 'node_modules', name));
      mkdirSync(join(root, 'node_modules'));
      writeFileSync(paths[0], 'content\n');
      linkSync(paths[0], paths[1]);
      linkSync(paths[0], paths[2]);
      const observations = paths.map((path, index) =>
        observeCleanValidationHardLink(
          `node_modules/${['one', 'two', 'three'][index]}`,
          'node_modules',
          lstatSync(path, { bigint: true }),
        ),
      );

      expect(freezeCleanValidationHardLinks(observations)).toMatchObject({ groups: 1 });
    });

    it('rejects an incomplete group with an unobserved name outside the checkout', () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-hard-links-incomplete-'));
      roots.push(root);
      const checkout = join(root, 'checkout');
      const artifact = join(checkout, 'node_modules', 'tool');
      const external = join(root, 'external-tool');
      mkdirSync(join(checkout, 'node_modules'), { recursive: true });
      writeFileSync(artifact, 'content\n');
      linkSync(artifact, external);

      expect(() =>
        freezeCleanValidationHardLinks([
          observeCleanValidationHardLink(
            'node_modules/tool',
            'node_modules',
            lstatSync(artifact, { bigint: true }),
          ),
        ]),
      ).toThrow(/组不完整/u);
    });

    it('changes the proof when a new alias appears between scans', () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-hard-links-race-'));
      roots.push(root);
      const nodeModules = join(root, 'node_modules');
      mkdirSync(nodeModules);
      const first = join(nodeModules, 'first');
      const second = join(nodeModules, 'second');
      writeFileSync(first, 'content\n');
      linkSync(first, second);
      const initial = snapshotCleanValidationHardLinks({
        root,
        owningRoot: (path) => (path.startsWith('node_modules/') ? 'node_modules' : null),
        maxEntries: 100,
      });
      linkSync(first, join(nodeModules, 'third'));
      const current = snapshotCleanValidationHardLinks({
        root,
        owningRoot: (path) => (path.startsWith('node_modules/') ? 'node_modules' : null),
        maxEntries: 100,
      });

      expect(current.groups).toBe(1);
      expect(current.digest).not.toBe(initial.digest);
    });

    it('changes the whole-tree proof when an artifact directory becomes a symbolic link', () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-topology-symlink-'));
      roots.push(root);
      const nodeModules = join(root, 'node_modules');
      const dist = join(root, 'dist');
      const external = join(root, 'external');
      mkdirSync(nodeModules);
      mkdirSync(dist);
      mkdirSync(external);
      writeFileSync(join(nodeModules, 'first'), 'content\n');
      linkSync(join(nodeModules, 'first'), join(nodeModules, 'second'));
      const owningRoot = (path: string) => {
        if (path === 'node_modules' || path.startsWith('node_modules/')) return 'node_modules';
        if (path === 'dist' || path.startsWith('dist/')) return 'dist';
        return null;
      };
      const initial = snapshotCleanValidationHardLinks({
        root,
        owningRoot,
        maxEntries: 100,
      });
      rmSync(dist, { recursive: true });
      symlinkSync(external, dist, 'dir');
      const current = snapshotCleanValidationHardLinks({
        root,
        owningRoot,
        maxEntries: 100,
      });

      expect(initial.groups).toBe(1);
      expect(current.groups).toBe(1);
      expect(current.digest).not.toBe(initial.digest);
    });

    it('checks the shared external-link deadline during recursive topology traversal', () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-topology-deadline-'));
      roots.push(root);
      mkdirSync(join(root, 'nested'));
      writeFileSync(join(root, 'nested', 'first'), 'first\n');
      writeFileSync(join(root, 'nested', 'second'), 'second\n');
      let checkpoints = 0;

      expect(() =>
        snapshotCleanValidationHardLinks({
          root,
          owningRoot: () => null,
          maxEntries: 100,
          checkpoint: () => {
            checkpoints += 1;
            if (checkpoints === 3) throw new Error('shared-deadline-expired');
          },
        }),
      ).toThrow('shared-deadline-expired');
      expect(checkpoints).toBe(3);
    });
  },
);

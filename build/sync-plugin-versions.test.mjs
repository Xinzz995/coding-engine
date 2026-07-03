import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PLUGIN_MANIFESTS, syncPluginVersions } from './sync-plugin-versions.mjs';

// 仿真实清单格式：author 单行对象、2 空格缩进、尾换行——同步必须保留这些
const manifest = (version) => `{
  "name": "coding-x",
  "version": "${version}",
  "description": "Ralph auto-coding workflow",
  "author": { "name": "Xinzz" }
}
`;

function withFixtureRoot(contents, fn) {
  const root = mkdtempSync(join(tmpdir(), 'sync-plugin-'));
  try {
    for (const [rel, text] of Object.entries(contents)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const allManifests = (version) =>
  Object.fromEntries(PLUGIN_MANIFESTS.map((rel) => [rel, manifest(version)]));

describe('syncPluginVersions', () => {
  it('lists the three per-tool plugin manifests', () => {
    expect(PLUGIN_MANIFESTS).toEqual([
      '.claude-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
      '.codex-plugin/plugin.json',
    ]);
  });

  it('syncs every manifest to the given version and reports them as changed', () => {
    withFixtureRoot(allManifests('0.5.1'), (root) => {
      const changed = syncPluginVersions(root, '9.9.9');
      expect(changed).toEqual(PLUGIN_MANIFESTS);
      for (const rel of PLUGIN_MANIFESTS) {
        const parsed = JSON.parse(readFileSync(join(root, rel), 'utf8'));
        expect(parsed.version).toBe('9.9.9');
      }
    });
  });

  it('skips manifests already at the target version, leaving them byte-identical', () => {
    const contents = allManifests('0.5.1');
    contents[PLUGIN_MANIFESTS[1]] = manifest('9.9.9');
    withFixtureRoot(contents, (root) => {
      const changed = syncPluginVersions(root, '9.9.9');
      expect(changed).toEqual([PLUGIN_MANIFESTS[0], PLUGIN_MANIFESTS[2]]);
      expect(readFileSync(join(root, PLUGIN_MANIFESTS[1]), 'utf8')).toBe(manifest('9.9.9'));
    });
  });

  it('only rewrites the version line, preserving all other formatting', () => {
    withFixtureRoot(allManifests('0.5.1'), (root) => {
      syncPluginVersions(root, '9.9.9');
      const after = readFileSync(join(root, PLUGIN_MANIFESTS[0]), 'utf8');
      expect(after).toBe(manifest('9.9.9')); // author 单行、键序、尾换行原样保留
    });
  });

  it('throws naming the file when a manifest has no version field', () => {
    const contents = allManifests('0.5.1');
    contents[PLUGIN_MANIFESTS[2]] = '{\n  "name": "coding-x"\n}\n';
    withFixtureRoot(contents, (root) => {
      expect(() => syncPluginVersions(root, '9.9.9')).toThrow(PLUGIN_MANIFESTS[2]);
    });
  });
});

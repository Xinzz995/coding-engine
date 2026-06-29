import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncAssets } from './sync-assets.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function fixtureSource(): string {
  const src = mkdtempSync(join(tmpdir(), 'src-'));
  cleanup.push(() => rmSync(src, { recursive: true, force: true }));
  mkdirSync(join(src, 'skills', 'prd'), { recursive: true });
  mkdirSync(join(src, 'commands'), { recursive: true });
  writeFileSync(join(src, 'skills', 'prd', 'SKILL.md'), '---\nname: prd\n---\nbody');
  writeFileSync(join(src, 'commands', 'prime.md'), '# prime');
  return src;
}

describe('syncAssets', () => {
  it('generates skills and commands into each target', () => {
    const src = fixtureSource();
    const out = mkdtempSync(join(tmpdir(), 'out-'));
    cleanup.push(() => rmSync(out, { recursive: true, force: true }));
    const target = { dir: out, skillsSubdir: 'skills', commandsSubdir: 'commands' };

    syncAssets({ sourceDir: src, targets: [target] });

    expect(existsSync(join(out, 'skills', 'prd', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(out, 'commands', 'prime.md'), 'utf-8')).toBe('# prime');
  });

  it('is idempotent (second run yields identical output)', () => {
    const src = fixtureSource();
    const out = mkdtempSync(join(tmpdir(), 'out2-'));
    cleanup.push(() => rmSync(out, { recursive: true, force: true }));
    const target = { dir: out, skillsSubdir: 'skills', commandsSubdir: 'commands' };
    syncAssets({ sourceDir: src, targets: [target] });
    const first = readFileSync(join(out, 'skills', 'prd', 'SKILL.md'), 'utf-8');
    syncAssets({ sourceDir: src, targets: [target] });
    const second = readFileSync(join(out, 'skills', 'prd', 'SKILL.md'), 'utf-8');
    expect(second).toBe(first);
  });
});

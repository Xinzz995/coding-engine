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
  writeFileSync(join(src, 'AGENTS-template.md'), '# AGENTS template\n');
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

    // AGENTS-template.md is copied from the source root to each target dir root.
    expect(existsSync(join(out, 'AGENTS-template.md'))).toBe(true);
    expect(readFileSync(join(out, 'AGENTS-template.md'), 'utf-8')).toBe('# AGENTS template\n');
  });

  it('is idempotent (second run yields identical output)', () => {
    const src = fixtureSource();
    const out = mkdtempSync(join(tmpdir(), 'out2-'));
    cleanup.push(() => rmSync(out, { recursive: true, force: true }));
    const target = { dir: out, skillsSubdir: 'skills', commandsSubdir: 'commands' };
    syncAssets({ sourceDir: src, targets: [target] });
    const firstSkill = readFileSync(join(out, 'skills', 'prd', 'SKILL.md'), 'utf-8');
    const firstTpl = readFileSync(join(out, 'AGENTS-template.md'), 'utf-8');
    syncAssets({ sourceDir: src, targets: [target] });
    const secondSkill = readFileSync(join(out, 'skills', 'prd', 'SKILL.md'), 'utf-8');
    const secondTpl = readFileSync(join(out, 'AGENTS-template.md'), 'utf-8');
    expect(secondSkill).toBe(firstSkill);
    expect(secondTpl).toBe(firstTpl);
  });

  it('does not require AGENTS-template.md at the source (no template → no copy, no throw)', () => {
    const src = mkdtempSync(join(tmpdir(), 'src-notpl-'));
    cleanup.push(() => rmSync(src, { recursive: true, force: true }));
    mkdirSync(join(src, 'skills', 'prd'), { recursive: true });
    writeFileSync(join(src, 'skills', 'prd', 'SKILL.md'), '---\nname: prd\n---\nbody');
    const out = mkdtempSync(join(tmpdir(), 'out-notpl-'));
    cleanup.push(() => rmSync(out, { recursive: true, force: true }));
    const target = { dir: out, skillsSubdir: 'skills', commandsSubdir: 'commands' };

    expect(() => syncAssets({ sourceDir: src, targets: [target] })).not.toThrow();
    expect(existsSync(join(out, 'AGENTS-template.md'))).toBe(false);
    expect(existsSync(join(out, 'skills', 'prd', 'SKILL.md'))).toBe(true);
  });
});

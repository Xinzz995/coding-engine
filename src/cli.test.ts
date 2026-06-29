import { describe, it, expect } from 'vitest';
import { parseCliArgs, permissionWarning } from './cli.js';

describe('parseCliArgs', () => {
  it('defaults to claude run with standard timeouts', () => {
    const c = parseCliArgs([]);
    expect(c.command).toBe('run');
    expect(c.kind).toBe('claude');
    expect(c.maxIterations).toBe(50);
    expect(c.devTimeoutMs).toBe(30 * 60 * 1000);
    expect(c.valTimeoutMs).toBe(60 * 60 * 1000);
    expect(c.openBrowser).toBe(true);
  });
  it('parses codex positional and flag overrides', () => {
    const c = parseCliArgs(['codex', '--max-iter', '3', '--dev-timeout', '10', '--no-open']);
    expect(c.kind).toBe('codex');
    expect(c.maxIterations).toBe(3);
    expect(c.devTimeoutMs).toBe(10 * 60 * 1000);
    expect(c.openBrowser).toBe(false);
  });
  it('recognizes the repair subcommand', () => {
    expect(parseCliArgs(['repair']).command).toBe('repair');
  });
});

describe('permissionWarning', () => {
  it('mentions skip-permissions for claude', () => {
    expect(permissionWarning('claude')).toMatch(/--dangerously-skip-permissions/);
  });
});

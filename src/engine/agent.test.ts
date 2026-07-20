import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAgentArgs, resolveBinary, runAgent } from './agent.js';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, '__fixtures__', 'fake-agent.mjs');

describe('buildAgentArgs', () => {
  it('builds claude print command by default', () => {
    expect(buildAgentArgs('claude', 'P')).toEqual([
      'claude', '--print', '--dangerously-skip-permissions', 'P',
    ]);
  });
  it('builds codex exec command', () => {
    expect(buildAgentArgs('codex', 'P')).toEqual([
      'codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', 'P',
    ]);
  });
  it('builds cursor headless force command', () => {
    expect(buildAgentArgs('cursor', 'P')).toEqual([
      'cursor-agent', '-p', '--force', 'P',
    ]);
  });
  it('appends --model before the prompt for claude when a model is given', () => {
    expect(buildAgentArgs('claude', 'P', 'opus')).toEqual([
      'claude', '--print', '--dangerously-skip-permissions', '--model', 'opus', 'P',
    ]);
  });
  it('appends --model before the prompt for codex when a model is given', () => {
    expect(buildAgentArgs('codex', 'P', 'gpt-5')).toEqual([
      'codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5', 'P',
    ]);
  });
  it('appends --model before the prompt for cursor when a model is given', () => {
    expect(buildAgentArgs('cursor', 'P', 'composer-1')).toEqual([
      'cursor-agent', '-p', '--force', '--model', 'composer-1', 'P',
    ]);
  });
});

describe('resolveBinary', () => {
  it('honors all runner env overrides', () => {
    process.env.CODING_X_CLAUDE_BIN = '/tmp/x';
    process.env.CODING_X_CODEX_BIN = '/tmp/y';
    process.env.CODING_X_CURSOR_BIN = '/tmp/z';
    expect(resolveBinary('claude')).toBe('/tmp/x');
    expect(resolveBinary('codex')).toBe('/tmp/y');
    expect(resolveBinary('cursor')).toBe('/tmp/z');
    delete process.env.CODING_X_CLAUDE_BIN;
    delete process.env.CODING_X_CODEX_BIN;
    delete process.env.CODING_X_CURSOR_BIN;
  });
});

describe('runAgent', () => {
  it('resolves timedOut=false when the process exits in time', async () => {
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} ok`;
    const r = await runAgent({ kind: 'claude', prompt: '', cwd: here, timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('resolves timedOut=true and kills a hanging process', async () => {
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} hang`;
    const r = await runAgent({ kind: 'claude', prompt: '', cwd: here, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    delete process.env.CODING_X_CLAUDE_BIN;
  });
});

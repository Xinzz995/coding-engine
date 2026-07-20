import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRunnerReady, discoverModels, renderModelDiscoveryJson, renderModelDiscoveryText,
} from './model-discovery.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-codex-app-server.mjs');
const fakeCommand = `node ${fixture}`;

afterEach(() => {
  delete process.env.CODING_X_CODEX_BIN;
  delete process.env.CODING_X_CLAUDE_BIN;
  delete process.env.CODING_X_CURSOR_BIN;
  delete process.env.CODING_X_FAKE_DISCOVERY_MODE;
});

describe('runner readiness', () => {
  it('uses public auth/status entry points for all runners', async () => {
    process.env.CODING_X_CLAUDE_BIN = fakeCommand;
    process.env.CODING_X_CODEX_BIN = fakeCommand;
    process.env.CODING_X_CURSOR_BIN = fakeCommand;
    await expect(checkRunnerReady('claude')).resolves.toEqual({ ready: true });
    await expect(checkRunnerReady('codex')).resolves.toEqual({ ready: true });
    await expect(checkRunnerReady('cursor')).resolves.toEqual({ ready: true });
  });

  it('reports auth failure without leaking command output', async () => {
    process.env.CODING_X_CLAUDE_BIN = fakeCommand;
    process.env.CODING_X_FAKE_DISCOVERY_MODE = 'auth-error';
    const result = await checkRunnerReady('claude');
    expect(result).toEqual({ ready: false, error: expect.stringContaining('未认证') });
  });
});

describe('discoverModels', () => {
  it('paginates Codex model/list, ignores noise, de-duplicates and rejects blank ids', async () => {
    process.env.CODING_X_CODEX_BIN = fakeCommand;
    process.env.CODING_X_FAKE_DISCOVERY_MODE = 'noise';
    const result = await discoverModels('codex');
    expect(result).toEqual({
      status: 'available', runner: 'codex', source: 'codex-app-server:model/list',
      models: [
        { id: 'model-a', displayName: 'Model A', isDefault: true },
        { id: 'model-b', displayName: 'Model B', isDefault: false },
      ],
    });
  });

  it.each(['rpc-error', 'empty', 'app-exit'])(
    'returns a safe error for Codex adapter failure: %s', async (mode) => {
      process.env.CODING_X_CODEX_BIN = fakeCommand;
      process.env.CODING_X_FAKE_DISCOVERY_MODE = mode;
      const result = await discoverModels('codex', { timeoutMs: 2_000 });
      expect(result.status).toBe('error');
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(JSON.stringify(result)).not.toContain('secret.invalid');
    },
  );

  it('returns error when app-server times out', async () => {
    process.env.CODING_X_CODEX_BIN = fakeCommand;
    process.env.CODING_X_FAKE_DISCOVERY_MODE = 'hang';
    const result = await discoverModels('codex', { timeoutMs: 50 });
    expect(result).toMatchObject({ status: 'error', runner: 'codex' });
  });

  it('returns unsupported for authenticated Claude and Cursor without scraping TUI', async () => {
    process.env.CODING_X_CLAUDE_BIN = fakeCommand;
    process.env.CODING_X_CURSOR_BIN = fakeCommand;
    await expect(discoverModels('claude')).resolves.toMatchObject({ status: 'unsupported', runner: 'claude' });
    const cursor = await discoverModels('cursor');
    expect(cursor).toMatchObject({ status: 'unsupported', runner: 'cursor' });
    expect(cursor.status === 'unsupported' ? cursor.reason : '').toContain('/model');
  });
});

describe('discovery rendering', () => {
  it('emits one parseable JSON object and safe human text', () => {
    const result = {
      status: 'available' as const, runner: 'codex' as const, source: 'fixture',
      models: [{ id: 'm', displayName: 'M', isDefault: true }],
    };
    expect(JSON.parse(renderModelDiscoveryJson(result))).toEqual(result);
    expect(renderModelDiscoveryText(result)).toContain('m — M');
    expect(renderModelDiscoveryText(result)).toContain('runner 默认');
  });
});

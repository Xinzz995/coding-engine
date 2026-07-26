import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initializeGlobalModelConfig,
  listConfiguredModels,
  readGlobalModelConfig,
  renderModelCatalogJson,
  renderModelCatalogText,
  resolveGlobalConfigPath,
} from './model-catalog.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-catalog-'));
  dirs.push(dir);
  return dir;
}

function writeConfig(value: unknown): string {
  const path = join(tempDir(), 'config.json');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveGlobalConfigPath', () => {
  it('defaults to ~/.config/coding-x/config.json', () => {
    expect(resolveGlobalConfigPath({}, '/home/example'))
      .toBe(join('/home/example', '.config', 'coding-x', 'config.json'));
  });

  it('lets CODING_X_CONFIG override the default and resolves relative paths', () => {
    expect(resolveGlobalConfigPath({ CODING_X_CONFIG: './custom/models.json' }, '/ignored'))
      .toBe(resolve('./custom/models.json'));
    expect(resolveGlobalConfigPath({ CODING_X_CONFIG: '/absolute/models.json' }, '/ignored'))
      .toBe('/absolute/models.json');
  });

  it('ignores a blank override', () => {
    expect(resolveGlobalConfigPath({ CODING_X_CONFIG: '   ' }, '/home/example'))
      .toBe(join('/home/example', '.config', 'coding-x', 'config.json'));
  });
});

describe('readGlobalModelConfig', () => {
  it('reads a strict versioned model catalog with optional labels', () => {
    const path = writeConfig({
      version: 1,
      models: {
        claude: [{ id: 'sonnet', label: 'Sonnet' }],
        codex: [{ id: 'gpt-5.6-codex' }],
      },
    });
    expect(readGlobalModelConfig(path)).toEqual({
      status: 'available', path,
      config: {
        version: 1,
        models: {
          claude: [{ id: 'sonnet', label: 'Sonnet' }],
          codex: [{ id: 'gpt-5.6-codex' }],
        },
      },
    });
  });

  it('accepts an empty models object and an explicitly empty runner array at file level', () => {
    const empty = writeConfig({ version: 1, models: {} });
    expect(readGlobalModelConfig(empty)).toMatchObject({ status: 'available' });
    const emptyRunner = writeConfig({ version: 1, models: { cursor: [] } });
    expect(readGlobalModelConfig(emptyRunner)).toMatchObject({
      status: 'available', config: { models: { cursor: [] } },
    });
  });

  it('treats a missing file as a safe configuration error', () => {
    const path = join(tempDir(), 'missing.json');
    expect(readGlobalModelConfig(path)).toEqual({
      status: 'error', path,
      errors: [`未找到全局模型配置：${path}`],
    });
  });

  it('reports malformed JSON without echoing file contents', () => {
    const path = join(tempDir(), 'config.json');
    writeFileSync(path, '{ "token": "SECRET",');
    const result = readGlobalModelConfig(path);
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).toContain('JSON');
  });

  it('reports an unreadable config path without throwing', () => {
    const path = tempDir();
    expect(readGlobalModelConfig(path)).toEqual({
      status: 'error', path, errors: [`无法读取全局模型配置：${path}`],
    });
  });

  it.each([
    [null, '全局模型配置必须是对象'],
    [{ version: 1 }, 'models 必须是对象'],
    [{ version: 1, models: [] }, 'models 必须是对象'],
    [{ version: 2, models: {} }, 'version 必须是 1'],
    [{ version: 1, models: {}, extra: true }, '未知字段 extra'],
    [{ version: 1, models: { other: [] } }, 'models 未知 runner other'],
    [{ version: 1, models: { claude: 'sonnet' } }, 'models.claude 必须是数组'],
    [{ version: 1, models: { claude: ['sonnet'] } }, 'models.claude[0] 必须是对象'],
    [{ version: 1, models: { claude: [{ id: '' }] } }, 'models.claude[0].id 必须是非空字符串'],
    [{ version: 1, models: { claude: [{ id: ' sonnet' }] } }, '不得包含首尾空白'],
    [{ version: 1, models: { claude: [{ id: 'sonnet', label: '' }] } }, 'label 必须是非空字符串'],
    [{ version: 1, models: { claude: [{ id: 'sonnet', label: ' Sonnet ' }] } }, 'label 必须是非空字符串'],
    [{ version: 1, models: { claude: [{ id: 'sonnet', label: 42 }] } }, 'label 必须是非空字符串'],
    [{ version: 1, models: { claude: [{ id: 'sonnet', cost: 1 }] } }, '未知字段 cost'],
    [{ version: 1, models: { claude: [{ id: 'sonnet' }, { id: 'sonnet' }] } }, '重复模型 ID sonnet'],
  ])('rejects invalid schema: %s', (value, message) => {
    const result = readGlobalModelConfig(writeConfig(value));
    expect(result.status).toBe('error');
    expect(result.status === 'error' ? result.errors.join('\n') : '').toContain(message);
  });
});

describe('listConfiguredModels and rendering', () => {
  it('returns only the selected runner catalog from global config', () => {
    const path = writeConfig({
      version: 1,
      models: {
        codex: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b' }],
        cursor: [{ id: 'cursor-a' }],
      },
    });
    const result = listConfiguredModels('codex', path);
    expect(result).toEqual({
      status: 'available', runner: 'codex', source: 'global-config', configPath: path,
      models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b' }],
    });
    expect(JSON.parse(renderModelCatalogJson(result))).toEqual(result);
    expect(renderModelCatalogText(result)).toContain('model-a — Model A');
    expect(renderModelCatalogText(result)).toContain(path);
    expect(renderModelCatalogText(result)).not.toContain('当前可用');
  });

  it('fails when the requested runner has no declared models', () => {
    const path = writeConfig({ version: 1, models: { claude: [] } });
    const result = listConfiguredModels('claude', path);
    expect(result).toMatchObject({ status: 'error', runner: 'claude', configPath: path });
    expect(result.status === 'error' ? result.error : '').toContain('未配置任何模型');
    expect(renderModelCatalogText(result)).toContain('❌');
  });
});

describe('initializeGlobalModelConfig', () => {
  it('creates parent directories and a valid empty template without overwriting', () => {
    const path = join(tempDir(), 'nested', 'config.json');
    expect(initializeGlobalModelConfig(path)).toEqual({ status: 'created', path });
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ version: 1, models: {} });
    expect(readGlobalModelConfig(path).status).toBe('available');
    expect(initializeGlobalModelConfig(path)).toEqual({ status: 'exists', path });
  });

  it('reports an IO error when a parent path is a file', () => {
    const parent = join(tempDir(), 'not-a-directory');
    writeFileSync(parent, 'occupied');
    const path = join(parent, 'config.json');
    const result = initializeGlobalModelConfig(path);
    expect(result).toMatchObject({ status: 'error', path });
  });

  it('never overwrites an existing configuration', () => {
    const path = join(tempDir(), 'config.json');
    const original = '{"version":1,"models":{"codex":[{"id":"keep-me"}]}}\n';
    writeFileSync(path, original);

    expect(initializeGlobalModelConfig(path)).toEqual({ status: 'exists', path });
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});

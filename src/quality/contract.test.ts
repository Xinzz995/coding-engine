import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  QUALITY_CONTRACT_PATH,
  parseQualityContract,
  readQualityContract,
  parseQualityExceptions,
} from './contract.js';

function validContract(): unknown {
  return {
    version: 1,
    checks: [{ id: 'test', command: 'pytest -q', cwd: '.', paths: ['src/', 'tests/'] }],
    review: {
      model: 'openai/gpt-4.1',
      specSources: ['docs/specs/'],
      standardsSources: ['AGENTS.md'],
      deepReview: {
        highRiskPaths: ['.github/', '.coding-x/'],
        changedProductionLines: 400,
        largeFileLines: 1000,
      },
    },
    github: {
      repository: 'owner/repo',
      defaultBranch: 'main',
      releaseRefs: ['refs/tags/v*'],
      codingXVersion: '0.30.0',
      requiredChecks: ['coding-x / project-checks'],
    },
    exceptionPolicy: { deferrableSeverities: ['medium'] },
    exceptionsFile: '.coding-x/exceptions.json',
  };
}

describe('quality contract', () => {
  it('strictly accepts a valid cross-language contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-contract-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'tests'));
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '# rules');
    const result = parseQualityContract(validContract(), root);
    expect(result).toMatchObject({ status: 'valid' });
    if (result.status === 'valid') {
      expect(result.contract.checks[0].command).toBe('pytest -q');
      expect(result.contract.review.model).toBe('openai/gpt-4.1');
    }
  });

  it.each([
    ['unknown root key', { ...validContract() as object, surprise: true }],
    ['wrong version', { ...validContract() as object, version: 2 }],
    ['empty checks', { ...validContract() as object, checks: [] }],
    ['duplicate check id', {
      ...validContract() as object,
      checks: [
        { id: 'test', command: 'one', cwd: '.', paths: ['src/'] },
        { id: 'test', command: 'two', cwd: '.', paths: ['src/'] },
      ],
    }],
    ['absolute cwd', {
      ...validContract() as object,
      checks: [{ id: 'test', command: 'pytest', cwd: '/tmp', paths: ['src/'] }],
    }],
    ['parent source', {
      ...validContract() as object,
      review: {
        ...(validContract() as { review: object }).review,
        specSources: ['../secret'],
      },
    }],
    ['bad repository', {
      ...validContract() as object,
      github: {
        ...(validContract() as { github: object }).github,
        repository: 'not-a-repository',
      },
    }],
    ['floating coding-x version', {
      ...validContract() as object,
      github: {
        ...(validContract() as { github: object }).github,
        codingXVersion: 'latest',
      },
    }],
    ['unsafe default branch', {
      ...validContract() as object,
      github: {
        ...(validContract() as { github: object }).github,
        defaultBranch: '../main',
      },
    }],
    ['non-tag release ref', {
      ...validContract() as object,
      github: {
        ...(validContract() as { github: object }).github,
        releaseRefs: ['refs/heads/v*'],
      },
    }],
    ['duplicate required check', {
      ...validContract() as object,
      github: {
        ...(validContract() as { github: object }).github,
        requiredChecks: ['same', 'same'],
      },
    }],
  ])('rejects %s', (_name, input) => {
    const root = mkdtempSync(join(tmpdir(), 'quality-contract-invalid-'));
    const result = parseQualityContract(input, root);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an existing symlink that escapes the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-contract-symlink-'));
    symlinkSync(tmpdir(), join(root, 'outside'));
    const input = validContract() as {
      checks: Array<{ id: string; command: string; cwd: string; paths: string[] }>;
    };
    input.checks[0].cwd = 'outside';
    const result = parseQualityContract(input, root);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.errors.join(' ')).toContain('项目根');
  });

  it('distinguishes missing and malformed tracked contracts', () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-contract-read-'));
    expect(readQualityContract(root)).toEqual({
      status: 'missing',
      path: join(root, QUALITY_CONTRACT_PATH),
    });
    mkdirSync(join(root, '.coding-x'));
    writeFileSync(join(root, QUALITY_CONTRACT_PATH), '{ broken');
    const result = readQualityContract(root);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.errors[0]).toContain('JSON');
  });
});

describe('quality exceptions', () => {
  it('accepts a complete optional head-bound exception', () => {
    const result = parseQualityExceptions({
      version: 1,
      exceptions: [{
        id: 'EX-1',
        findingId: 'standards:src/app.py:missing-timeout',
        reason: '等待供应商修复',
        owner: 'xinzz',
        expiresAt: '2026-08-01T00:00:00.000Z',
        followUpUrl: 'https://github.com/owner/repo/issues/1',
        headSha: 'a'.repeat(40),
      }],
      deliveries: [],
    });
    expect(result.status).toBe('valid');
  });

  it.each([
    { version: 1, exceptions: [{ id: 'x' }], deliveries: [] },
    { version: 1, exceptions: [{ id: 'x', findingId: 'f', reason: 'r', owner: 'o', expiresAt: 'tomorrow', followUpUrl: 'x' }], deliveries: [] },
    { version: 1, exceptions: [{ id: 'x', findingId: 'f', reason: 'r', owner: 'o', expiresAt: '2026-08-01', followUpUrl: 'https://x' }], deliveries: [] },
    { version: 1, exceptions: [{ id: 'x', findingId: 'f', reason: 'r', owner: 'o', expiresAt: '2026-08-01T00:00:00Z', followUpUrl: 'https://x', extra: true }], deliveries: [] },
    { version: 1, exceptions: [], deliveries: [], extra: true },
  ])('rejects incomplete or unknown exception fields', (input) => {
    expect(parseQualityExceptions(input).status).toBe('invalid');
  });

  it('accepts a complete emergency delivery record and rejects incomplete audit identity', () => {
    const valid = {
      version: 1,
      exceptions: [],
      deliveries: [{
        id: 'DELIVERY-1',
        commitSha: 'b'.repeat(40),
        reason: 'restore production',
        owner: 'xinzz',
        expiresAt: '2026-08-01T00:00:00Z',
        followUpUrl: 'https://github.com/owner/repo/issues/2',
        auditUrl: 'https://github.com/owner/repo/settings/rules',
      }],
    };
    expect(parseQualityExceptions(valid).status).toBe('valid');
    expect(parseQualityExceptions({
      ...valid,
      deliveries: [{ ...valid.deliveries[0], auditUrl: '' }],
    }).status).toBe('invalid');
  });
});

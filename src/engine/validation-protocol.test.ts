import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Story } from './prd.js';
import {
  VALIDATION_RESULT_MAX_BYTES,
  acceptanceHash,
  clearValidationResult,
  createValidationRequest,
  readGitHead,
  readValidationResult,
  renderValidatorInstruction,
  type ValidationRequest,
  type ValidationResult,
} from './validation-protocol.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'validation-protocol-'));
  dirs.push(dir);
  return dir;
}

const story: Story = {
  id: 'US-007',
  title: '绑定验收目标',
  description: 'Validator 必须验证引擎指定目标',
  acceptanceCriteria: ['返回 401', '审计日志包含 request id'],
  priority: 1,
};

function request(dir: string): ValidationRequest {
  return createValidationRequest(story, dir, 'a'.repeat(40), 'request-123');
}

function resultFor(req: ValidationRequest, overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    version: 1,
    requestId: req.requestId,
    storyId: req.storyId,
    acceptanceHash: req.acceptanceHash,
    gitHead: req.gitHead,
    verdict: 'passed',
    checks: [
      { acIndex: 1, passed: true, evidence: 'integration test returned 401' },
      { acIndex: 2, passed: true, evidence: 'audit assertion matched request-123' },
    ],
    summary: '全部验收标准通过',
    ...overrides,
  };
}

function writeResult(req: ValidationRequest, value: unknown): void {
  writeFileSync(req.resultPath, JSON.stringify(value));
}

describe('validation request', () => {
  it('reads a real Git HEAD and reports non-Git directories as unavailable', () => {
    expect(readGitHead(process.cwd())).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    expect(readGitHead(tempDir())).toBeNull();
  });

  it('reads linked-worktree loose and packed refs without launching Git', () => {
    const root = tempDir();
    const checkout = join(root, 'checkout');
    const gitDirectory = join(root, 'git-common', 'worktrees', 'fixture');
    const commonDirectory = join(root, 'git-common');
    mkdirSync(checkout);
    mkdirSync(join(gitDirectory), { recursive: true });
    mkdirSync(join(commonDirectory, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(checkout, '.git'), 'gitdir: ../git-common/worktrees/fixture\n');
    writeFileSync(join(gitDirectory, 'commondir'), '../..\n');
    writeFileSync(join(gitDirectory, 'HEAD'), 'ref: refs/heads/feature\n');
    writeFileSync(join(commonDirectory, 'refs', 'heads', 'feature'), `${'a'.repeat(40)}\n`);

    expect(readGitHead(checkout)).toBe('a'.repeat(40));

    rmSync(join(commonDirectory, 'refs', 'heads', 'feature'));
    writeFileSync(
      join(commonDirectory, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled\n${'b'.repeat(64)} refs/heads/feature\n`,
    );
    expect(readGitHead(checkout)).toBe('b'.repeat(64));
  });

  it('binds one request to the exact story, AC snapshot, artifact and workspace path', () => {
    const dir = tempDir();
    const req = request(dir);

    expect(req).toEqual({
      version: 1,
      requestId: 'request-123',
      storyId: 'US-007',
      acceptanceHash: acceptanceHash('US-007', story.acceptanceCriteria),
      acceptanceCriteria: story.acceptanceCriteria,
      gitHead: 'a'.repeat(40),
      resultPath: join(dir, 'validation-result.json'),
    });
    expect(req.acceptanceCriteria).not.toBe(story.acceptanceCriteria);
    expect(req.acceptanceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('appends an engine-owned, runner-neutral contract to custom instructions', () => {
    const dir = tempDir();
    const req = request(dir);
    const prompt = renderValidatorInstruction('原有 Validator 指令', req);

    expect(prompt).toContain('原有 Validator 指令');
    expect(prompt).toContain('ENGINE-BOUND VALIDATION REQUEST');
    expect(prompt).toContain('不得修改 state.json');
    expect(prompt).toContain(JSON.stringify(req, null, 2));
  });

  it('removes only the fixed stale result and tolerates absence', () => {
    const dir = tempDir();
    const req = request(dir);
    writeResult(req, resultFor(req));
    expect(existsSync(req.resultPath)).toBe(true);

    clearValidationResult(req.resultPath);
    clearValidationResult(req.resultPath);

    expect(existsSync(req.resultPath)).toBe(false);
  });
});

describe('readValidationResult', () => {
  it('accepts a fresh, fully bound passed claim', () => {
    const dir = tempDir();
    const req = request(dir);
    const result = resultFor(req);
    writeResult(req, result);

    expect(readValidationResult(req.resultPath, req, req.gitHead)).toEqual({ ok: true, result });
  });

  it('accepts a failed claim only when at least one AC check failed', () => {
    const dir = tempDir();
    const req = request(dir);
    const result = resultFor(req, {
      verdict: 'failed',
      checks: [
        { acIndex: 1, passed: false, evidence: 'expected 401, received 200' },
        { acIndex: 2, passed: true, evidence: 'audit assertion passed' },
      ],
      summary: 'AC 1 未通过',
    });
    writeResult(req, result);

    expect(readValidationResult(req.resultPath, req, req.gitHead)).toEqual({ ok: true, result });
  });

  it('fails closed when the result is absent, oversized or malformed JSON', () => {
    const dir = tempDir();
    const req = request(dir);
    expect(readValidationResult(req.resultPath, req, req.gitHead)).toMatchObject({
      ok: false, code: 'missing-result',
    });

    writeFileSync(req.resultPath, 'x'.repeat(VALIDATION_RESULT_MAX_BYTES + 1));
    expect(readValidationResult(req.resultPath, req, req.gitHead)).toMatchObject({
      ok: false, code: 'result-too-large',
    });

    writeFileSync(req.resultPath, '{broken');
    expect(readValidationResult(req.resultPath, req, req.gitHead)).toMatchObject({
      ok: false, code: 'invalid-json',
    });
  });

  it.runIf(process.platform !== 'win32')('refuses a validation result reached through a symlink', () => {
    const dir = tempDir();
    const req = request(dir);
    const actual = join(dir, 'outside-result.json');
    writeFileSync(actual, JSON.stringify(resultFor(req)));
    symlinkSync(actual, req.resultPath);

    expect(readValidationResult(req.resultPath, req, req.gitHead)).toMatchObject({
      ok: false, code: 'unreadable-result',
    });
  });

  it.each([
    ['request ID', { requestId: 'stale-request' }],
    ['story ID', { storyId: 'US-999' }],
    ['AC hash', { acceptanceHash: `sha256:${'b'.repeat(64)}` }],
    ['Git HEAD', { gitHead: 'c'.repeat(40) }],
  ] as const)('rejects a mismatched %s binding', (_label, overrides) => {
    const dir = tempDir();
    const req = request(dir);
    writeResult(req, resultFor(req, overrides));

    expect(readValidationResult(req.resultPath, req, req.gitHead)).toMatchObject({
      ok: false, code: 'binding-mismatch',
    });
  });

  it('rejects a result when Git HEAD changed during validation', () => {
    const dir = tempDir();
    const req = request(dir);
    writeResult(req, resultFor(req));

    expect(readValidationResult(req.resultPath, req, 'd'.repeat(40))).toMatchObject({
      ok: false, code: 'artifact-changed',
    });
  });

  it.each([
    ['missing AC', [{ acIndex: 1, passed: true, evidence: 'ok' }]],
    ['duplicate AC', [
      { acIndex: 1, passed: true, evidence: 'ok' },
      { acIndex: 1, passed: true, evidence: 'again' },
    ]],
    ['out-of-order AC', [
      { acIndex: 2, passed: true, evidence: 'second' },
      { acIndex: 1, passed: true, evidence: 'first' },
    ]],
    ['empty evidence', [
      { acIndex: 1, passed: true, evidence: '' },
      { acIndex: 2, passed: true, evidence: 'ok' },
    ]],
  ])('rejects structurally invalid checks: %s', (_label, checks) => {
    const dir = tempDir();
    const req = request(dir);
    writeResult(req, resultFor(req, { checks }));

    expect(readValidationResult(req.resultPath, req, req.gitHead)).toMatchObject({
      ok: false, code: 'invalid-schema',
    });
  });

  it('rejects verdict/check contradictions and unknown fields', () => {
    const dir = tempDir();
    const req = request(dir);
    writeResult(req, resultFor(req, {
      verdict: 'passed',
      checks: [
        { acIndex: 1, passed: false, evidence: 'failed' },
        { acIndex: 2, passed: true, evidence: 'ok' },
      ],
    }));
    expect(readValidationResult(req.resultPath, req, req.gitHead)).toMatchObject({
      ok: false, code: 'invalid-schema',
    });

    writeResult(req, { ...resultFor(req), extra: 'unversioned extension' });
    expect(readValidationResult(req.resultPath, req, req.gitHead)).toMatchObject({
      ok: false, code: 'invalid-schema',
    });
  });

  it('supports an explicit unavailable Git identity without inventing one', () => {
    const dir = tempDir();
    const req = createValidationRequest(story, dir, null, 'request-no-git');
    const result = resultFor(req, { gitHead: null });
    writeResult(req, result);

    expect(readValidationResult(req.resultPath, req, null)).toEqual({ ok: true, result });
  });
});

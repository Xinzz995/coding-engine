import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectLocalReviewSources,
  evaluateReviewModelResult,
  renderReviewCheck,
  validateReviewOutputGrounding,
  validateReviewOutputSemantics,
} from './review.js';
import type { QualityContractV1, ReviewModelOutput } from './types.js';

function contract(): QualityContractV1 {
  return {
    version: 1,
    checks: [{ id: 'test', command: 'true', cwd: '.', paths: ['src/'] }],
    review: {
      provider: 'github-copilot',
      model: 'auto',
      copilotCliVersion: '1.0.74',
      specSources: ['docs/specs/'],
      standardsSources: ['AGENTS.md'],
      deepReview: {
        highRiskPaths: [],
        changedProductionLines: 400,
        largeFileLines: 1000,
      },
    },
    github: {
      repository: 'owner/repo',
      defaultBranch: 'main',
      releaseRefs: [],
      codingXVersion: '0.30.0',
      requiredChecks: ['coding-x / spec-review'],
    },
    exceptionPolicy: { deferrableSeverities: ['medium'] },
    exceptionsFile: '.coding-x/exceptions.json',
  };
}

function groundedOutput(evidence: string): ReviewModelOutput {
  return {
    summary: 'one issue',
    findings: [{
      id: 'standards:x:1:a',
      axis: 'standards',
      severity: 'high',
      file: 'src/x.ts',
      line: 1,
      title: 'wrong branch',
      evidence,
      source: 'AGENTS.md',
      impact: 'bypasses authorization',
      recommendation: 'check the caller role',
    }],
  };
}

describe('review result evaluation', () => {
  it('derives failed from findings rather than trusting a model status', () => {
    const output: ReviewModelOutput = {
      summary: 'one high issue',
      findings: [{
        id: 'spec:x:1:a',
        axis: 'spec',
        severity: 'high',
        file: 'src/x.ts',
        line: 1,
        title: 'wrong behavior',
        evidence: 'returns false',
        source: 'AC 1',
        impact: 'breaks intent',
        recommendation: 'return true',
      }],
    };
    expect(evaluateReviewModelResult(output, [], 'a'.repeat(40), new Date()).status)
      .toBe('failed');
  });

  it('renders exact identity, findings and unverifiable errors for a GitHub check', () => {
    const rendered = renderReviewCheck({
      version: 1,
      kind: 'review',
      round: 1,
      status: 'unverifiable',
      at: '2026-07-24T00:00:00Z',
      repository: 'owner/repo',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      contractSha256: 'c'.repeat(64),
      axis: 'spec',
      model: 'github-copilot:auto',
      findings: [],
      exceptions: [],
      errors: [{ code: 'intent-missing', message: '缺少验收标准' }],
      durationMs: 12,
    });
    expect(rendered.title).toContain('无法验证');
    expect(rendered.summary).toContain('bbbbbbbbbbbb');
    expect(rendered.text).toContain('intent-missing');
    expect(rendered.text).toContain('调用次数: 未记录');
    expect(rendered.text).not.toContain('Premium requests: 0');
  });

  it('accepts a finding only when its evidence is a verbatim excerpt from the visible input', () => {
    expect(validateReviewOutputGrounding(groundedOutput('return allowAllUsers();'), {
      diff: '+return allowAllUsers();',
      sources: [{ path: 'AGENTS.md', content: 'Every caller must be authorized.' }],
      diffByFile: new Map([['src/x.ts', '+return allowAllUsers();']]),
    })).toBeNull();
  });

  it('accepts a contiguous same-file code excerpt with unified-diff prefixes removed', () => {
    const evidence = [
      'readFileSync.mockImplementation(() => {',
      "  throw Object.assign(new Error('missing'), { code: 'ENOENT' });",
      '});',
    ].join('\n');
    const patch = [
      '@@ -1,2 +1,5 @@',
      '+readFileSync.mockImplementation(() => {',
      "+  throw Object.assign(new Error('missing'), { code: 'ENOENT' });",
      '+});',
    ].join('\n');
    expect(validateReviewOutputGrounding(groundedOutput(evidence), {
      diff: `diff --git a/src/x.ts b/src/x.ts\n${patch}`,
      sources: [],
      diffByFile: new Map([['src/x.ts', patch]]),
    })).toBeNull();
  });

  it('does not join evidence across separate diff hunks after removing prefixes', () => {
    const evidence = [
      'const endOfFirstHunk = true;',
      'const startOfSecondHunk = true;',
    ].join('\n');
    const patch = [
      '@@ -1,1 +1,1 @@',
      '+const endOfFirstHunk = true;',
      '@@ -100,1 +100,1 @@',
      '+const startOfSecondHunk = true;',
    ].join('\n');
    expect(validateReviewOutputGrounding(groundedOutput(evidence), {
      diff: `diff --git a/src/x.ts b/src/x.ts\n${patch}`,
      sources: [],
      diffByFile: new Map([['src/x.ts', patch]]),
    })).toContain('逐字原文');
  });

  it('rejects a positive confirmation whose recommendation explicitly requires no change', () => {
    const output = groundedOutput('return allowAllUsers();');
    output.findings[0].recommendation = '测试覆盖符合要求，无需修改。';
    expect(validateReviewOutputSemantics(output)).toContain('无需修改');
    output.findings[0].recommendation = 'No code changes are required.';
    expect(validateReviewOutputSemantics(output)).toContain('无需修改');
    output.findings[0].recommendation = '无需修改核心逻辑，只需新增边界测试。';
    expect(validateReviewOutputSemantics(output)).toBeNull();
  });

  it('rejects fabricated evidence even when the finding path is otherwise in scope', () => {
    expect(validateReviewOutputGrounding(groundedOutput('return allowAllUsers();'), {
      diff: '+return authorizeCaller();',
      sources: [{ path: 'AGENTS.md', content: 'Every caller must be authorized.' }],
      diffByFile: new Map([['src/x.ts', '+return authorizeCaller();']]),
    })).toContain('逐字原文');
  });

  it('does not borrow evidence from an unrelated source file', () => {
    expect(validateReviewOutputGrounding(
      groundedOutput('Every caller must be authorized.'),
      {
        diff: '+return authorizeCaller();',
        sources: [{ path: 'AGENTS.md', content: 'Every caller must be authorized.' }],
        diffByFile: new Map([['src/x.ts', '+return authorizeCaller();']]),
      },
    )).toContain('对应文件');
  });

  it('does not attribute evidence from another changed file to the finding path', () => {
    expect(validateReviewOutputGrounding(
      groundedOutput('return allowAllUsers();'),
      {
        diff: [
          'diff --git a/src/x.ts b/src/x.ts',
          '+return authorizeCaller();',
          'diff --git a/src/y.ts b/src/y.ts',
          '+return allowAllUsers();',
        ].join('\n'),
        sources: [],
        diffByFile: new Map([
          ['src/x.ts', '+return authorizeCaller();'],
          ['src/y.ts', '+return allowAllUsers();'],
        ]),
      },
    )).toContain('对应文件');
  });

  it('rejects trivial excerpts that cannot substantiate a finding', () => {
    expect(validateReviewOutputGrounding(groundedOutput('+'), {
      diff: '+return authorizeCaller();',
      sources: [],
      diffByFile: new Map([['src/x.ts', '+return authorizeCaller();']]),
    })).toContain('至少需要 12');
  });
});

describe('local review sources', () => {
  it('reads only declared project text sources within size limits', () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-review-sources-'));
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'specs', 'one.md'), '# one');
    writeFileSync(join(root, 'AGENTS.md'), '# rules');
    const value = contract();
    const spec = collectLocalReviewSources(root, value.review.specSources);
    const standards = collectLocalReviewSources(root, value.review.standardsSources);
    expect(spec.map((item) => item.path)).toEqual(['docs/specs/one.md']);
    expect(standards.map((item) => item.path)).toEqual(['AGENTS.md']);
  });
});

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectLocalReviewSources,
  evaluateReviewModelResult,
  renderReviewCheck,
} from './review.js';
import type { QualityContractV1, ReviewModelOutput } from './types.js';

function contract(): QualityContractV1 {
  return {
    version: 1,
    checks: [{ id: 'test', command: 'true', cwd: '.', paths: ['src/'] }],
    review: {
      model: 'openai/gpt-4.1',
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
      model: 'openai/gpt-4.1',
      findings: [],
      exceptions: [],
      errors: [{ code: 'intent-missing', message: '缺少验收标准' }],
      durationMs: 12,
    });
    expect(rendered.title).toContain('无法验证');
    expect(rendered.summary).toContain('bbbbbbbbbbbb');
    expect(rendered.text).toContain('intent-missing');
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

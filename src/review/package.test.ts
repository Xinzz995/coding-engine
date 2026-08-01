import { existsSync, lstatSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readQualityContract } from '../quality/contract.js';
import { createReviewPackage, reviewOutputSchema } from './package.js';
import type { ReviewPreflightContext } from './preflight.js';
import { assessReviewRisk } from './risk.js';

function context(): ReviewPreflightContext {
  const contract = readQualityContract(process.cwd());
  if (contract.status !== 'ready') throw new Error(`contract unavailable: ${contract.status}`);
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  return {
    root: process.cwd(), branch: 'feature/review', baseSha, headSha,
    pullRequest: {
      number: 1, headSha, baseBranch: 'main', baseSha,
      url: 'https://example.test/1', title: 'review', labels: [],
      body: '## 本次目标\nreview',
    },
    baseContract: contract.contract,
    baseContractDigest: contract.digest,
    changedFiles: ['README.md'],
    files: [{ path: 'README.md', base: 'old', head: 'new' }],
    diff: '-old\n+new\n',
    specs: [{ path: 'docs/specs/review.md', content: '# Review' }],
    engineeringStandards: [{ path: 'AGENTS.md', content: '# Rules' }],
    history: `${headSha}\treview`,
    prSections: {
      '本次目标': 'review', '明确的非目标': 'none',
      'Spec 与验收标准来源': 'docs/specs/review.md', '验证方式': 'tests',
      '风险说明': 'local',
    },
  };
}

describe('createReviewPackage', () => {
  it('makes every structured-output property required and represents optional values as null', () => {
    const schema = reviewOutputSchema();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(schema.required).toEqual(Object.keys(properties));
    expect(properties.unverifiableReason.type).toEqual(['string', 'null']);

    const finding = (properties.findings.items as Record<string, unknown>);
    const findingProperties = finding.properties as Record<string, Record<string, unknown>>;
    expect(finding.required).toEqual(Object.keys(findingProperties));

    const location = findingProperties.location;
    const locationProperties = location.properties as Record<string, Record<string, unknown>>;
    expect(location.required).toEqual(Object.keys(locationProperties));
    expect(locationProperties.line.type).toEqual(['integer', 'null']);
    expect(locationProperties.symbol.type).toEqual(['string', 'null']);
  });

  it('contains the bound old quality contract and only engine-selected review data', () => {
    const ctx = context();
    const reviewPackage = createReviewPackage({
      context: ctx,
      risk: assessReviewRisk(ctx),
      axis: 'engineering',
      runner: 'codex',
      model: 'gpt-5.6-terra',
      mechanicalEvidence: {
        status: 'passed',
        headSha: ctx.headSha,
        qualityContractDigest: ctx.baseContractDigest,
        scope: 'all-current-platform-applicable-contract-checks',
      },
    });
    try {
      const input = JSON.parse(reviewPackage.input) as Record<string, unknown>;
      expect(input.qualityContract).toEqual(ctx.baseContract);
      expect(input).toMatchObject({
        axis: 'engineering',
        binding: { baseSha: ctx.baseSha, headSha: ctx.headSha },
        changedFiles: ['README.md'],
        verificationBoundary: {
          mechanicalChecks: {
            status: 'passed',
            headSha: ctx.headSha,
            qualityContractDigest: ctx.baseContractDigest,
            scope: 'all-current-platform-applicable-contract-checks',
          },
          allReviewAxes: { owner: 'engine' },
          githubDelivery: { owner: 'engine' },
          reviewerScope: 'judge-repository-changes-not-process-completion',
        },
      });
      expect(input).not.toHaveProperty('workspace');
      reviewPackage.assertUnchanged();
      if (process.platform !== 'win32') {
        expect(lstatSync(reviewPackage.root).mode & 0o777).toBe(0o500);
        for (const path of [
          reviewPackage.inputPath,
          reviewPackage.schemaPath,
          reviewPackage.manifestPath,
        ]) {
          expect(lstatSync(path).mode & 0o777).toBe(0o400);
        }
      }
    } finally {
      reviewPackage.cleanup();
    }
  });

  it('rejects mechanical evidence copied from another commit or scope', () => {
    const ctx = context();
    const create = (over: Partial<Parameters<typeof createReviewPackage>[0]['mechanicalEvidence']>) => (
      createReviewPackage({
        context: ctx,
        risk: assessReviewRisk(ctx),
        axis: 'spec',
        runner: 'codex',
        model: 'gpt-5.6-terra',
        mechanicalEvidence: {
          status: 'passed',
          headSha: ctx.headSha,
          qualityContractDigest: ctx.baseContractDigest,
          scope: 'all-current-platform-applicable-contract-checks',
          ...over,
        },
      })
    );
    expect(() => create({ headSha: 'c'.repeat(40) })).toThrow('未绑定当前 Review 上下文');
    expect(() => create({
      scope: 'different-scope' as 'all-current-platform-applicable-contract-checks',
    })).toThrow('未绑定当前 Review 上下文');
  });

  it.each(['afterInputWrite', 'beforePermissions'] as const)(
    'safely cleans an identity-bound package after %s initialization fails',
    (stage) => {
      const ctx = context();
      let root = '';
      expect(() =>
        createReviewPackage({
          context: ctx,
          risk: assessReviewRisk(ctx),
          axis: 'engineering',
          runner: 'codex',
          model: 'gpt-5.6-terra',
          mechanicalEvidence: {
            status: 'passed',
            headSha: ctx.headSha,
            qualityContractDigest: ctx.baseContractDigest,
            scope: 'all-current-platform-applicable-contract-checks',
          },
          initializationHooks: {
            [stage]: (path: string) => {
              root = path;
              throw new Error(`injected ${stage} failure`);
            },
          },
        }),
      ).toThrow(/初始化失败现场已安全清理/u);
      expect(root).not.toBe('');
      expect(existsSync(root)).toBe(false);
    },
  );
});

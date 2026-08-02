import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  QUALITY_CONTRACT_SCHEMA_VERSION,
  assessQualityRuntime,
  deriveQualityChecks,
  digestQualityContract,
  parseQualityContract,
  parseReviewBaseQualityContract,
  qualityChecksMatchContract,
  readQualityContract,
  type QualityContract,
} from './contract.js';
import { CODING_X_VERSION } from '../version.js';

// 独立于候选源码版本；仅在已发布版本通过旧裁判审查的 Policy PR 中更新。
const CODING_ENGINE_STABLE_REFEREE_VERSION = '0.33.3';

function validContract(): unknown {
  return {
    schemaVersion: 2,
    codingXVersion: '0.29.0',
    repository: {
      provider: 'github',
      fullName: 'Xinzz995/example',
      defaultBranch: 'main',
    },
    release: {
      protectedRefs: ['v*'],
    },
    sources: {
      specs: [{ kind: 'path', path: 'docs/specs/feature.md' }, { kind: 'pull-request' }],
      acceptanceCriteria: [{ kind: 'pull-request' }],
      engineeringStandards: ['AGENTS.md', 'docs/golden-principles.md'],
    },
    modules: [
      { id: 'root', path: '.' },
      { id: 'api', path: 'packages/api' },
    ],
    generatedPaths: ['dist/**', 'coverage/**'],
    localValidation: {
      prepare: [
        {
          executable: 'npm',
          args: ['ci'],
          cwd: '.',
          platforms: ['linux', 'macos', 'windows'],
          timeoutMs: 600_000,
        },
      ],
      allowedPaths: ['node_modules/**'],
    },
    checks: {
      test: {
        checks: [
          {
            id: 'unit',
            module: 'root',
            paths: ['src/**'],
            command: {
              executable: 'npm',
              args: ['test', '--', '--run'],
              cwd: '.',
              platforms: ['linux', 'macos', 'windows'],
              timeoutMs: 600_000,
            },
          },
        ],
      },
      build: {
        checks: [
          {
            id: 'build',
            module: 'root',
            command: {
              executable: 'npm',
              args: ['run', 'build'],
              cwd: '.',
              platforms: ['linux', 'macos', 'windows'],
              timeoutMs: 600_000,
            },
          },
        ],
      },
      static: {
        checks: [
          {
            id: 'shell-static',
            module: 'api',
            command: {
              shell: 'bash',
              script: 'npm run typecheck | tee typecheck.log',
              cwd: 'packages/api',
              platforms: ['linux', 'macos'],
              timeoutMs: 600_000,
            },
          },
        ],
      },
      security: {
        notApplicable: '示例仓库没有第三方生产依赖。',
      },
    },
    risk: {
      defaultCategories: ['policy', 'public-contract', 'state', 'concurrency', 'security'],
      highRiskPaths: ['src/engine/**', '.github/workflows/**'],
      pathRules: [{ paths: ['packages/api/**'], categories: ['public-contract', 'security'] }],
    },
    github: {
      jobs: [
        {
          id: 'ubuntu-node-22',
          platform: 'linux',
          toolchains: [
            { kind: 'node', version: '22', cache: 'npm', cacheDependencyPath: 'package-lock.json' },
          ],
          setup: [
            {
              executable: 'npm',
              args: ['ci'],
              cwd: '.',
              platforms: ['linux'],
              timeoutMs: 600_000,
            },
          ],
          checkIds: ['unit', 'build', 'shell-static'],
        },
        {
          id: 'macos-node-24',
          platform: 'macos',
          toolchains: [{ kind: 'node', version: '24' }],
          setup: [
            {
              executable: 'npm',
              args: ['ci'],
              cwd: '.',
              platforms: ['macos'],
              timeoutMs: 600_000,
            },
          ],
          checkIds: ['unit', 'build', 'shell-static'],
        },
        {
          id: 'windows-node-24',
          platform: 'windows',
          toolchains: [{ kind: 'node', version: '24' }],
          setup: [
            {
              executable: 'npm',
              args: ['ci'],
              cwd: '.',
              platforms: ['windows'],
              timeoutMs: 600_000,
            },
          ],
          checkIds: ['unit', 'build'],
        },
      ],
      requiredChecks: ['quality-gate', 'policy-guard-source'],
      requiredCodeScanning: [
        {
          tool: 'CodeQL',
          alertsThreshold: 'errors',
          securityAlertsThreshold: 'high_or_higher',
        },
      ],
      immutableReleases: true,
      securityFeatures: {
        dependabotSecurityUpdates: true,
        secretScanning: true,
        secretScanningPushProtection: true,
      },
    },
    exceptions: {
      p1: {
        issueTemplate: '.github/ISSUE_TEMPLATE/quality-p1.yml',
        maxDays: 30,
      },
      policy: {
        issueTemplate: '.github/ISSUE_TEMPLATE/quality-policy.yml',
        maxDays: 7,
      },
    },
  };
}

function clone(): Record<string, any> {
  return structuredClone(validContract()) as Record<string, any>;
}

describe('parseQualityContract', () => {
  it('accepts a complete cross-platform contract with structured and explicit shell commands', () => {
    const result = parseQualityContract(validContract());
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.contract.schemaVersion).toBe(QUALITY_CONTRACT_SCHEMA_VERSION);
    expect(result.contract.checks.static).toMatchObject({
      checks: [{ command: { shell: 'bash' } }],
    });
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('migrates a schema 1 default-branch contract from its own trusted job setup only', () => {
    const legacy = clone();
    legacy.schemaVersion = 1;
    delete legacy.localValidation;
    const result = parseReviewBaseQualityContract(legacy);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.contract.schemaVersion).toBe(2);
    expect(result.contract.localValidation.allowedPaths).toEqual(['node_modules/**']);
    expect(result.contract.localValidation.prepare).toHaveLength(1);
    expect(result.contract.localValidation.prepare[0]).toMatchObject({
      executable: 'npm',
      args: ['ci'],
    });
    expect(result.digest).not.toBe(digestQualityContract(result.contract));
  });

  it('rejects a globbed generated path while migrating a schema 1 default-branch contract', () => {
    const legacy = clone();
    legacy.schemaVersion = 1;
    legacy.generatedPaths = ['x*/**'];
    delete legacy.localValidation;
    const result = parseReviewBaseQualityContract(legacy);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.errors.join('\n')).toContain('基目录必须是字面路径');
    }
  });

  it('rejects an ambiguous schema 1 setup instead of trusting the candidate PR', () => {
    const legacy = clone();
    legacy.schemaVersion = 1;
    delete legacy.localValidation;
    const platform = process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux';
    const samePlatform = legacy.github.jobs.find(
      (job: Record<string, unknown>) => job.platform === platform,
    );
    legacy.github.jobs.push({
      ...structuredClone(samePlatform),
      id: 'ambiguous-setup',
      setup: [{
        executable: 'node', args: ['unexpected.js'], cwd: '.', platforms: [platform], timeoutMs: 1,
      }],
    });
    const result = parseReviewBaseQualityContract(legacy);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') expect(result.errors.join('\n')).toContain('setup 不一致');
  });

  it('never auto-migrates a schema 1 Python referee even when its setup is empty', () => {
    const legacy = clone();
    legacy.schemaVersion = 1;
    delete legacy.localValidation;
    for (const job of legacy.github.jobs) {
      job.toolchains = [{ kind: 'python', version: '3.12' }];
      job.setup = [];
    }
    const result = parseReviewBaseQualityContract(legacy);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.errors.join('\n')).toContain('Python setup 未声明隔离安装目录');
    }
  });

  it('never auto-migrates schema 1 Python rules hidden on another platform', () => {
    const legacy = clone();
    legacy.schemaVersion = 1;
    delete legacy.localValidation;
    const otherPlatform = process.platform === 'linux' ? 'macos' : 'linux';
    for (const job of legacy.github.jobs) {
      job.toolchains = job.platform === otherPlatform
        ? [{ kind: 'python', version: '3.12' }]
        : [{ kind: 'node', version: '22' }];
    }
    const result = parseReviewBaseQualityContract(legacy);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.errors.join('\n')).toContain('Python setup 未声明隔离安装目录');
    }
  });

  it('rejects schema 1 migration when the old referee has no job for this platform', () => {
    const legacy = clone();
    legacy.schemaVersion = 1;
    delete legacy.localValidation;
    const otherPlatform = process.platform === 'linux' ? 'macos' : 'linux';
    legacy.github.jobs = legacy.github.jobs.filter(
      (job: Record<string, unknown>) => job.platform === otherPlatform,
    );
    const result = parseReviewBaseQualityContract(legacy);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.errors.join('\n')).toContain('无法确定本地准备命令');
    }
  });

  it('requires a schema 2 Python contract to declare both isolated preparation and its output directory', () => {
    const input = clone();
    for (const job of input.github.jobs) {
      job.toolchains = [{ kind: 'python', version: '3.12' }];
    }
    input.localValidation = { prepare: [], allowedPaths: [] };
    const result = parseQualityContract(input);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          'Python 项目必须显式声明 localValidation.prepare 以建立隔离环境',
          'Python 项目必须显式声明 localValidation.allowedPaths 以限定隔离环境目录',
        ]),
      );
    }
  });

  it('requires local Python preparation to cover every platform that declares Python', () => {
    const input = clone();
    input.github.jobs[0].toolchains = [{ kind: 'python', version: '3.12' }];
    input.localValidation.prepare = [
      {
        executable: 'python',
        args: ['-m', 'venv', '.venv'],
        cwd: '.',
        platforms: ['macos', 'windows'],
        timeoutMs: 60_000,
      },
    ];
    input.localValidation.allowedPaths = ['.venv/**'];
    const result = parseQualityContract(input);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.errors).toContain(
        'Python 项目的 localValidation.prepare 必须覆盖 linux',
      );
    }
  });

  it.each([
    [null, '根必须是对象'],
    [{}, '缺少字段 schemaVersion'],
    [{ ...clone(), schemaVersion: 3 }, '不支持 schemaVersion 3'],
    [{ ...clone(), extra: true }, '未知字段 extra'],
  ])('rejects an invalid root: %#', (value, expected) => {
    const result = parseQualityContract(value);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') expect(result.errors.join('\n')).toContain(expected);
  });

  it.each([
    ['codingXVersion', '', 'codingXVersion 必须是精确 X.Y.Z 版本'],
    ['codingXVersion', '^0.29.0', 'codingXVersion 必须是精确 X.Y.Z 版本'],
    ['repository.fullName', 'only-owner', 'repository.fullName'],
    ['repository.defaultBranch', '', 'repository.defaultBranch'],
    ['release.protectedRefs', [], 'release.protectedRefs 为空时必须提供 notApplicable'],
    ['release.protectedRefs', ['*'], '必须是明确的 Git tag 模式'],
    ['release.protectedRefs', [''], '必须是非空字符串'],
    ['release.protectedRefs', [' releases/v*'], '必须是明确的 Git tag 模式'],
    ['release.protectedRefs', ['refs/tags/v*'], '必须是明确的 Git tag 模式'],
    ['release.protectedRefs', ['release//v*'], '必须是明确的 Git tag 模式'],
    ['release.notApplicable', '', 'release.notApplicable'],
    ['sources.engineeringStandards', [], 'sources.engineeringStandards'],
    ['generatedPaths', ['/absolute/**'], 'generatedPaths[0]'],
    ['generatedPaths', ['**'], '不能允许整个项目根'],
    ['generatedPaths', ['*/**'], '不能允许整个项目根'],
    ['generatedPaths', ['?*/**'], '不能允许整个项目根'],
    ['generatedPaths', ['**/*/**'], '不能允许整个项目根'],
    ['generatedPaths', ['allowed-*/**'], '基目录必须是字面路径'],
    ['generatedPaths', ['.*/**'], '基目录必须是字面路径'],
    ['generatedPaths', ['src*/**'], '基目录必须是字面路径'],
    ['generatedPaths', ['src?/**'], '基目录必须是字面路径'],
    ['generatedPaths', ['packages/[ab]/dist/**'], '基目录必须是字面路径'],
    ['generatedPaths', ['packages/{api,web}/dist/**'], '基目录必须是字面路径'],
    ['generatedPaths', ['bundle.js'], '必须是明确目录的 /** 模式'],
    ['localValidation.allowedPaths', ['**'], '不能允许整个项目根'],
    ['localValidation.allowedPaths', ['allowed-*/**'], '基目录必须是字面路径'],
    ['localValidation.allowedPaths', ['.*/**'], '基目录必须是字面路径'],
    ['localValidation.allowedPaths', ['src*/**'], '基目录必须是字面路径'],
    ['localValidation.allowedPaths', ['node_modules'], '必须是明确目录的 /** 模式'],
    ['github.requiredChecks', [], 'github.requiredChecks'],
    ['exceptions.p1.maxDays', 0, 'exceptions.p1.maxDays'],
  ])('rejects invalid field %s', (path, value, expected) => {
    const input = clone();
    const segments = path.split('.');
    let owner: Record<string, any> = input;
    for (const segment of segments.slice(0, -1)) owner = owner[segment];
    owner[segments.at(-1)!] = value;
    const result = parseQualityContract(input);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') expect(result.errors.join('\n')).toContain(expected);
  });

  it('accepts an explicit release exemption only when protected refs are empty', () => {
    const input = clone();
    input.release = { protectedRefs: [], notApplicable: '该项目不发布版本。' };
    expect(parseQualityContract(input)).toMatchObject({ status: 'ready' });
    input.release.protectedRefs = ['v*'];
    expect(parseQualityContract(input)).toMatchObject({ status: 'invalid' });
  });

  it('validates optional GitHub security requirements without allowing a contradictory policy', () => {
    const invalidType = clone();
    invalidType.github.securityFeatures.secretScanning = 'enabled';
    const typeResult = parseQualityContract(invalidType);
    expect(typeResult.status).toBe('invalid');
    if (typeResult.status === 'invalid') {
      expect(typeResult.errors).toContain('github.securityFeatures.secretScanning 必须是布尔值');
    }

    const contradictory = clone();
    contradictory.github.securityFeatures.secretScanning = false;
    const policyResult = parseQualityContract(contradictory);
    expect(policyResult.status).toBe('invalid');
    if (policyResult.status === 'invalid') {
      expect(policyResult.errors).toContain(
        'github.securityFeatures 启用推送保护时必须同时启用秘密扫描',
      );
    }
  });

  it('validates optional required code scanning tools and thresholds', () => {
    const optional = clone();
    delete optional.github.requiredCodeScanning;
    expect(parseQualityContract(optional)).toMatchObject({ status: 'ready' });

    const empty = clone();
    empty.github.requiredCodeScanning = [];
    const emptyResult = parseQualityContract(empty);
    expect(emptyResult.status).toBe('invalid');
    if (emptyResult.status === 'invalid') {
      expect(emptyResult.errors).toContain('github.requiredCodeScanning 不能为空');
    }

    const invalid = clone();
    invalid.github.requiredCodeScanning.push({
      tool: 'codeql',
      alertsThreshold: 'warning',
      securityAlertsThreshold: 'high',
    });
    const invalidResult = parseQualityContract(invalid);
    expect(invalidResult.status).toBe('invalid');
    if (invalidResult.status === 'invalid') {
      expect(invalidResult.errors).toEqual(
        expect.arrayContaining([
          'github.requiredCodeScanning 含重复工具 codeql',
          'github.requiredCodeScanning[1].alertsThreshold 是未知阈值',
          'github.requiredCodeScanning[1].securityAlertsThreshold 是未知阈值',
        ]),
      );
    }
  });

  it('only accepts an explicit true requirement for immutable GitHub releases', () => {
    const optional = clone();
    delete optional.github.immutableReleases;
    expect(parseQualityContract(optional)).toMatchObject({ status: 'ready' });

    const invalid = clone();
    invalid.github.immutableReleases = false;
    const result = parseQualityContract(invalid);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors).toContain('github.immutableReleases 只能声明为 true');
    }
  });

  it.each([
    [
      'non-array args',
      (input: Record<string, any>) => {
        input.checks.test.checks[0].command.args = 'test';
      },
    ],
    [
      'empty platforms',
      (input: Record<string, any>) => {
        input.checks.test.checks[0].command.platforms = [];
      },
    ],
    [
      'duplicate platforms',
      (input: Record<string, any>) => {
        input.checks.test.checks[0].command.platforms = ['linux', 'linux'];
      },
    ],
    [
      'invalid platform',
      (input: Record<string, any>) => {
        input.checks.test.checks[0].command.platforms = ['aix'];
      },
    ],
    [
      'timeout too large',
      (input: Record<string, any>) => {
        input.checks.test.checks[0].command.timeoutMs = 3_600_001;
      },
    ],
    [
      'both executable and shell',
      (input: Record<string, any>) => {
        input.checks.test.checks[0].command.shell = 'bash';
        input.checks.test.checks[0].command.script = 'npm test';
      },
    ],
    [
      'cwd escapes',
      (input: Record<string, any>) => {
        input.checks.test.checks[0].command.cwd = '../outside';
      },
    ],
    [
      'unknown command field',
      (input: Record<string, any>) => {
        input.checks.test.checks[0].command.env = { TOKEN: 'x' };
      },
    ],
  ])('rejects unsafe or ambiguous command form: %s', (_name, mutate) => {
    const input = clone();
    mutate(input);
    expect(parseQualityContract(input)).toMatchObject({ status: 'invalid' });
  });

  it('requires every quality category to contain checks or a non-empty reason, never both', () => {
    const missing = clone();
    missing.checks.security = { checks: [] };
    expect(parseQualityContract(missing)).toMatchObject({ status: 'invalid' });

    const both = clone();
    both.checks.security = { checks: clone().checks.test.checks, notApplicable: 'no' };
    expect(parseQualityContract(both)).toMatchObject({ status: 'invalid' });
  });

  it('requires at least one project check and validates every GitHub job setup command', () => {
    const input = clone();
    input.checks = {
      test: { notApplicable: 'none' },
      build: { notApplicable: 'none' },
      static: { notApplicable: 'none' },
      security: { notApplicable: 'none' },
    };
    input.github.jobs[0].setup = [
      {
        executable: 'npm',
        args: ['ci'],
        cwd: '..',
        platforms: [],
        timeoutMs: 0,
      },
    ];
    const result = parseQualityContract(input);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      const errors = result.errors.join('\n');
      expect(errors).toContain('至少必须声明一项');
      expect(errors).toContain('github.jobs[0].setup[0].cwd');
      expect(errors).toContain('github.jobs[0].setup[0].platforms');
      expect(errors).toContain('github.jobs[0].setup[0].timeoutMs');
    }
  });

  it('requires jobs to use valid toolchains and cover only checks supported by that platform', () => {
    const input = clone();
    input.github.jobs[0].toolchains = [
      { kind: 'node', version: '22', cache: 'pip' },
      { kind: 'node', version: '24' },
    ];
    input.github.jobs[0].checkIds.push('missing');
    input.github.jobs[2].checkIds.push('shell-static');
    const result = parseQualityContract(input);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      const errors = result.errors.join('\n');
      expect(errors).toContain('对 node 必须是 npm、yarn 或 pnpm');
      expect(errors).toContain('toolchains 含重复 node');
      expect(errors).toContain('引用未知检查 missing');
      expect(errors).toContain('在 windows 运行不适用的检查 shell-static');
    }
  });

  it('keeps hosted runner selection out of schema v1 and rejects expression injection', () => {
    const input = clone();
    Object.assign(input.github.jobs[0], { runner: '${{ fromJSON(inputs.runner) }}' });
    const result = parseQualityContract(input);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      expect(result.errors).toContain('github.jobs[0] 未知字段 runner');
    }
  });

  it('rejects duplicate module ids, check ids, required checks, and unknown module references', () => {
    const input = clone();
    input.modules.push({ id: 'api', path: 'packages/other' });
    input.checks.build.checks[0].id = 'unit';
    input.checks.build.checks[0].module = 'missing';
    input.github.requiredChecks.push('quality-gate');
    const result = parseQualityContract(input);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      const errors = result.errors.join('\n');
      expect(errors).toContain('重复 module id api');
      expect(errors).toContain('重复 check id unit');
      expect(errors).toContain('引用未知 module missing');
      expect(errors).toContain('github.requiredChecks 含重复值 quality-gate');
    }
  });

  it('rejects path traversal, backslashes, empty source sets, and invalid source variants', () => {
    const input = clone();
    input.sources.specs = [];
    input.sources.acceptanceCriteria = [{ kind: 'url', url: 'https://example.com' }];
    input.modules[1].path = 'packages\\api';
    input.risk.highRiskPaths.push('../secrets/**');
    const result = parseQualityContract(input);
    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status === 'invalid') {
      const errors = result.errors.join('\n');
      expect(errors).toContain('sources.specs');
      expect(errors).toContain('sources.acceptanceCriteria[0].kind');
      expect(errors).toContain('modules[1].path');
      expect(errors).toContain('risk.highRiskPaths[2]');
    }
  });
});

describe('quality contract identity and runtime mode', () => {
  it('produces the same digest for object-key reorder and a different digest for semantic changes', () => {
    const ready = parseQualityContract(validContract());
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    const reordered = {
      ...ready.contract,
      repository: {
        defaultBranch: ready.contract.repository.defaultBranch,
        fullName: ready.contract.repository.fullName,
        provider: ready.contract.repository.provider,
      },
    } as QualityContract;
    expect(digestQualityContract(reordered)).toBe(ready.digest);
    const changed = structuredClone(ready.contract);
    changed.repository.defaultBranch = 'trunk';
    expect(digestQualityContract(changed)).not.toBe(ready.digest);
  });

  it('allows formal mode only on an exact version match and makes shadow permanently non-deliverable', () => {
    const ready = parseQualityContract(validContract());
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    expect(assessQualityRuntime(ready.contract, '0.29.0', false)).toEqual({
      mode: 'formal',
      expectedVersion: '0.29.0',
      actualVersion: '0.29.0',
      versionMatches: true,
      deliveryReadyAllowed: true,
    });
    expect(assessQualityRuntime(ready.contract, '0.30.0', false)).toMatchObject({
      mode: 'version-mismatch',
      versionMatches: false,
      deliveryReadyAllowed: false,
    });
    expect(assessQualityRuntime(ready.contract, '0.30.0', true)).toEqual({
      mode: 'shadow',
      expectedVersion: '0.29.0',
      actualVersion: '0.30.0',
      versionMatches: false,
      deliveryReadyAllowed: false,
    });
    expect(assessQualityRuntime(ready.contract, '0.29.0', true)).toMatchObject({
      mode: 'shadow',
      versionMatches: true,
      deliveryReadyAllowed: false,
    });
  });

  it('derives an independent PRD check snapshot and detects any drift from the contract', () => {
    const ready = parseQualityContract(validContract());
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    const snapshot = deriveQualityChecks(ready.contract);
    expect(qualityChecksMatchContract(snapshot, ready.contract)).toBe(true);
    expect(snapshot).not.toBe(ready.contract.checks);
    if ('checks' in snapshot.test) snapshot.test.checks[0].id = 'changed';
    expect(qualityChecksMatchContract(snapshot, ready.contract)).toBe(false);
    expect(
      'checks' in ready.contract.checks.test ? ready.contract.checks.test.checks[0].id : null,
    ).toBe('unit');
  });
});

describe('readQualityContract', () => {
  it('keeps the coding-engine dogfood contract valid without making the candidate its own referee', () => {
    const result = readQualityContract(process.cwd());
    expect(result).toMatchObject({
      status: 'ready',
      contract: {
        repository: { fullName: 'Xinzz995/coding-engine', defaultBranch: 'main' },
        codingXVersion: CODING_ENGINE_STABLE_REFEREE_VERSION,
      },
      digest: expect.stringMatching(/^sha256:/),
    });
    if (result.status !== 'ready') return;
    const versionMatches = result.contract.codingXVersion === CODING_X_VERSION;
    expect(assessQualityRuntime(result.contract, CODING_X_VERSION, false)).toMatchObject({
      mode: versionMatches ? 'formal' : 'version-mismatch',
      expectedVersion: CODING_ENGINE_STABLE_REFEREE_VERSION,
      actualVersion: CODING_X_VERSION,
      versionMatches,
      deliveryReadyAllowed: versionMatches,
    });
  });

  it('distinguishes missing, invalid JSON, invalid schema, and ready contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-contract-'));
    try {
      expect(readQualityContract(root)).toMatchObject({ status: 'missing' });
      mkdirSync(join(root, '.coding-x'));
      writeFileSync(join(root, '.coding-x', 'quality.json'), '{');
      expect(readQualityContract(root)).toMatchObject({ status: 'invalid-json' });
      writeFileSync(join(root, '.coding-x', 'quality.json'), '{}');
      expect(readQualityContract(root)).toMatchObject({ status: 'invalid' });
      writeFileSync(join(root, '.coding-x', 'quality.json'), JSON.stringify(validContract()));
      expect(readQualityContract(root)).toMatchObject({
        status: 'ready',
        path: join(root, '.coding-x', 'quality.json'),
        digest: expect.stringMatching(/^sha256:/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

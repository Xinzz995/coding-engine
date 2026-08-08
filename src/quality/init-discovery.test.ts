import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseQualityContract } from './contract.js';
import { renderQualityGateWorkflow } from './github-workflows.js';
import {
  discoverQualityContract,
  discoverTrackedWorkflowPlatforms,
  parseRequiredPlatformsInput,
  resolveNotApplicableReasons,
} from './init-discovery.js';

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-discovery-'));
  roots.push(root);
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'quality@test.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'quality-test'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', '初始提交'], { cwd: root, stdio: 'ignore' });
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const repository = {
  fullName: 'example/project',
  defaultBranch: 'main',
  isPrivate: true,
};

describe('discoverQualityContract', () => {
  it('discovers explicit Node preparation for both local clean validation and GitHub CI', () => {
    const root = fixture({
      'README.md': '# Node project\n',
      'package.json': JSON.stringify({
        engines: { node: '>=22' },
        scripts: { test: 'node --test', build: 'node build.mjs', lint: 'eslint .' },
      }),
      'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }),
    });
    const draft = discoverQualityContract(root, repository, '0.30.0', ['macos', 'windows']);
    expect(draft.detectedEcosystems).toEqual(['node']);
    expect(draft.unresolvedCategories).toEqual([]);
    expect(draft.contract.localValidation).toEqual({
      prepare: [
        {
          executable: 'npm',
          args: ['ci'],
          cwd: '.',
          platforms: ['macos', 'windows'],
          timeoutMs: 600_000,
        },
      ],
      allowedPaths: ['node_modules/**'],
    });
    expect(draft.contract.generatedPaths).toEqual(['dist/**', 'build/**', 'coverage/**']);
    expect(draft.contract.github.requiredPlatforms).toEqual(['macos', 'windows']);
    expect(draft.contract.github.jobs.map((job) => job.platform)).toEqual(['macos', 'windows']);
    for (const policy of Object.values(draft.contract.checks)) {
      if (!('checks' in policy)) continue;
      for (const check of policy.checks) {
        expect(check.command.platforms.every((platform) => platform !== 'linux')).toBe(true);
      }
    }
    expect(
      'checks' in draft.contract.checks.security
        ? draft.contract.checks.security.checks[0].command.platforms
        : null,
    ).toEqual(['macos']);
    expect(parseQualityContract(draft.contract)).toMatchObject({ status: 'ready' });
    const workflow = renderQualityGateWorkflow(draft.contract);
    expect(workflow).toContain('actions/setup-node@');
    expect(workflow).toMatch(/run: [^\n]*npm[^\n]*ci/u);
  });

  it('requires a committed npm lockfile instead of generating a mutable preparation candidate', () => {
    const root = fixture({
      'README.md': '# Node project\n',
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    });
    expect(() => discoverQualityContract(root, repository, '0.30.0', ['linux'])).toThrow(
      '缺少已提交的 package-lock.json',
    );
  });

  it('discovers a Go multi-module project without introducing Node or coding-x', () => {
    const root = fixture({
      'README.md': '# Go project\n',
      'services/api/go.mod': 'module example/api\n\ngo 1.24\n',
      'services/api/go.sum': '',
      'services/worker/go.mod': 'module example/worker\n\ngo 1.24\n',
      'services/worker/go.sum': '',
    });
    const draft = discoverQualityContract(root, repository, '0.30.0', ['windows']);
    expect(draft.detectedEcosystems).toEqual(['go']);
    expect(draft.contract.modules).toEqual([
      { id: 'services-api', path: 'services/api' },
      { id: 'services-worker', path: 'services/worker' },
    ]);
    expect(draft.unresolvedCategories).toEqual(['security']);
    expect(draft.contract.github.jobs[0].toolchains).toEqual([
      {
        kind: 'go',
        version: '1.24',
        cache: true,
        cacheDependencyPath: '**/go.sum',
      },
    ]);
    expect(draft.contract.localValidation).toEqual({ prepare: [], allowedPaths: [] });

    const contract = resolveNotApplicableReasons(draft, {
      security: '试点仓库当前没有独立安全扫描器；由仓库所有者确认。',
    });
    expect(parseQualityContract(contract)).toMatchObject({ status: 'ready' });
    const workflow = renderQualityGateWorkflow(contract);
    expect(workflow).toContain('actions/setup-go@');
    expect(workflow).not.toMatch(/setup-node|\bnpm\b|coding-x.*(?:run|init)/);
  });

  it('refuses to guess a Python environment that would silently depend on host packages', () => {
    const pyproject = `[build-system]
requires = ["setuptools"]
build-backend = "setuptools.build_meta"

[project]
name = "fixture"
version = "0.1.0"
requires-python = ">=3.12"

[tool.ruff]
line-length = 100
`;
    const root = fixture({
      'README.md': '# Python project\n',
      'packages/api/pyproject.toml': pyproject,
      'packages/api/tests/test_api.py': 'def test_api():\n    assert True\n',
      'packages/worker/pyproject.toml': pyproject.replace('fixture', 'worker'),
      'packages/worker/tests/test_worker.py': 'def test_worker():\n    assert True\n',
    });
    expect(() => discoverQualityContract(root, repository, '0.30.0', ['linux'])).toThrow(
      '无法从 pyproject.toml 安全推导可重复的本地隔离环境',
    );
  });

  it('refuses to invent unsupported project rules or silently accept an empty reason', () => {
    const root = fixture({ 'README.md': '# Unknown project\n', Makefile: 'test:\n\ttrue\n' });
    expect(() => discoverQualityContract(root, repository, '0.30.0', ['linux'])).toThrow(
      '未发现受支持',
    );

    const goRoot = fixture({
      'README.md': '# Go project\n',
      'go.mod': 'module example/root\n\ngo 1.24\n',
      'go.sum': '',
    });
    const draft = discoverQualityContract(goRoot, repository, '0.30.0', ['linux']);
    expect(() => resolveNotApplicableReasons(draft, { security: '   ' })).toThrow(
      '缺少具体不适用理由',
    );
  });

  it('requires a non-empty unique explicit platform selection', () => {
    expect(parseRequiredPlatformsInput('macos, windows')).toEqual(['macos', 'windows']);
    expect(() => parseRequiredPlatformsInput('')).toThrow('至少选择一个平台');
    expect(() => parseRequiredPlatformsInput('linux,linux')).toThrow('不能重复');
    expect(() => parseRequiredPlatformsInput('linux,aix')).toThrow('只允许 linux、macos、windows');
  });

  it('places npm audit on linux before macos and windows regardless of selection order', () => {
    const root = fixture({
      'README.md': '# Node project\n',
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }),
    });
    const draft = discoverQualityContract(root, repository, '0.30.0', [
      'windows',
      'macos',
      'linux',
    ]);
    expect(
      'checks' in draft.contract.checks.security
        ? draft.contract.checks.security.checks[0].command.platforms
        : null,
    ).toEqual(['linux']);
  });

  it('uses only tracked fixed hosted runners as hints and marks ambiguous runners', () => {
    const root = fixture({
      'README.md': '# Workflow hints\n',
      '.github/workflows/quality.yml': [
        'jobs:',
        '  linux:',
        '    runs-on: ubuntu-24.04',
        '  mac:',
        '    runs-on: "macos-26" # fixed',
        '  dynamic:',
        '    runs-on: ${{ matrix.runner }}',
        '  private:',
        '    runs-on: [self-hosted, windows, x64]',
        '',
      ].join('\n'),
      '.github/workflows/release.yaml': 'jobs:\n  release:\n    runs-on: macos-15\n',
    });
    writeFileSync(join(root, '.github/workflows/untracked.yml'), 'runs-on: windows-2022\n');
    expect(discoverTrackedWorkflowPlatforms(root)).toEqual({
      platforms: ['linux', 'macos'],
      hasUncertainRunners: true,
    });
  });
});

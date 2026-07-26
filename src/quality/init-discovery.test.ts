import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseQualityContract } from './contract.js';
import { renderQualityGateWorkflow } from './github-workflows.js';
import { discoverQualityContract, resolveNotApplicableReasons } from './init-discovery.js';

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
  fullName: 'example/project', defaultBranch: 'main', isPrivate: true,
};

describe('discoverQualityContract', () => {
  it('discovers a Go multi-module project without introducing Node or coding-x', () => {
    const root = fixture({
      'README.md': '# Go project\n',
      'services/api/go.mod': 'module example/api\n\ngo 1.24\n',
      'services/api/go.sum': '',
      'services/worker/go.mod': 'module example/worker\n\ngo 1.24\n',
      'services/worker/go.sum': '',
    });
    const draft = discoverQualityContract(root, repository, '0.30.0');
    expect(draft.detectedEcosystems).toEqual(['go']);
    expect(draft.contract.modules).toEqual([
      { id: 'services-api', path: 'services/api' },
      { id: 'services-worker', path: 'services/worker' },
    ]);
    expect(draft.unresolvedCategories).toEqual(['security']);
    expect(draft.contract.github.jobs[0].toolchains).toEqual([{
      kind: 'go', version: '1.24', cache: true, cacheDependencyPath: '**/go.sum',
    }]);

    const contract = resolveNotApplicableReasons(draft, {
      security: '试点仓库当前没有独立安全扫描器；由仓库所有者确认。',
    });
    expect(parseQualityContract(contract)).toMatchObject({ status: 'ready' });
    const workflow = renderQualityGateWorkflow(contract);
    expect(workflow).toContain('actions/setup-go@');
    expect(workflow).not.toMatch(/setup-node|\bnpm\b|coding-x.*(?:run|init)/);
  });

  it('discovers a Python monorepo with module-local setup and one explicit Python toolchain', () => {
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
    const draft = discoverQualityContract(root, repository, '0.30.0');
    expect(draft.detectedEcosystems).toEqual(['python']);
    expect(draft.contract.modules).toEqual([
      { id: 'packages-api', path: 'packages/api' },
      { id: 'packages-worker', path: 'packages/worker' },
    ]);
    expect(draft.contract.github.jobs[0].toolchains).toEqual([
      { kind: 'python', version: '3.12' },
    ]);
    expect(draft.contract.github.jobs[0].setup.map((command) => command.cwd)).toEqual([
      'packages/api', 'packages/worker',
    ]);
    const contract = resolveNotApplicableReasons(draft, {
      security: '试点仓库暂未配置独立依赖审计；由仓库所有者确认。',
    });
    expect(parseQualityContract(contract)).toMatchObject({ status: 'ready' });
    const workflow = renderQualityGateWorkflow(contract);
    expect(workflow).toContain('actions/setup-python@');
    expect(workflow).not.toMatch(/setup-node|\bnpm\b|coding-x.*(?:run|init)/);
  });

  it('refuses to invent unsupported project rules or silently accept an empty reason', () => {
    const root = fixture({ 'README.md': '# Unknown project\n', 'Makefile': 'test:\n\ttrue\n' });
    expect(() => discoverQualityContract(root, repository, '0.30.0')).toThrow('未发现受支持');

    const goRoot = fixture({
      'README.md': '# Go project\n',
      'go.mod': 'module example/root\n\ngo 1.24\n',
      'go.sum': '',
    });
    const draft = discoverQualityContract(goRoot, repository, '0.30.0');
    expect(() => resolveNotApplicableReasons(draft, { security: '   ' })).toThrow('缺少具体不适用理由');
  });
});

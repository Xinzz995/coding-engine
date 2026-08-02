import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import {
  REQUIRED_GITHUB_CHECKS,
  type QualityCheck,
  type QualityCheckCategory,
  type QualityContract,
  type QualityPlatform,
  type QualityToolchain,
} from './contract.js';
import type { GitHubRepositoryInfo } from './github.js';

const ALL_PLATFORMS: QualityPlatform[] = ['linux', 'macos', 'windows'];
const UNRESOLVED = '__CODING_X_INIT_REQUIRES_A_SPECIFIC_REASON__';

export interface QualityContractDraft {
  contract: QualityContract;
  unresolvedCategories: QualityCheckCategory[];
  detectedEcosystems: string[];
}

function gitFiles(root: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean);
  } catch (error) {
    throw new Error(`无法读取 Git 跟踪文件：${error instanceof Error ? error.message : String(error)}`);
  }
}

function moduleId(path: string, fallback: string): string {
  if (path === '.') return fallback;
  return path.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '') || fallback;
}

function commandCheck(
  id: string,
  module: string,
  executable: string,
  args: string[],
  cwd: string,
  platforms: QualityPlatform[] = ALL_PLATFORMS,
): QualityCheck {
  return {
    id,
    module,
    command: {
      executable,
      args,
      cwd,
      platforms,
      timeoutMs: 600_000,
    },
  };
}

function addCheck(
  groups: Record<QualityCheckCategory, QualityCheck[]>,
  category: QualityCheckCategory,
  check: QualityCheck,
): void {
  groups[category].push(check);
}

function discoverNode(
  root: string,
  files: Set<string>,
  groups: Record<QualityCheckCategory, QualityCheck[]>,
  setup: QualityContract['github']['jobs'][number]['setup'],
  localPrepare: QualityContract['localValidation']['prepare'],
  toolchains: QualityToolchain[],
): boolean {
  if (!files.has('package.json')) return false;
  let pkg: unknown;
  try { pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')); } catch {
    throw new Error('package.json 无法解析，不能发现 Node 项目检查');
  }
  const scripts = typeof pkg === 'object' && pkg !== null && !Array.isArray(pkg)
    && typeof (pkg as Record<string, unknown>).scripts === 'object'
    && (pkg as Record<string, unknown>).scripts !== null
    ? (pkg as Record<string, unknown>).scripts as Record<string, unknown>
    : {};
  const engines = typeof pkg === 'object' && pkg !== null && !Array.isArray(pkg)
    && typeof (pkg as Record<string, unknown>).engines === 'object'
    && (pkg as Record<string, unknown>).engines !== null
    ? (pkg as Record<string, unknown>).engines as Record<string, unknown>
    : {};
  const hasScript = (name: string) => typeof scripts[name] === 'string'
    && scripts[name].trim() !== ''
    && !scripts[name].includes('no test specified');

  let packageManager = 'npm';
  if (files.has('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (files.has('yarn.lock')) packageManager = 'yarn';
  const locked = files.has('package-lock.json') || files.has('npm-shrinkwrap.json');
  if (packageManager === 'npm' && !locked) {
    throw new Error(
      'Node 项目缺少已提交的 package-lock.json 或 npm-shrinkwrap.json；' +
        '无法生成可重复的干净验证准备命令',
    );
  }
  const declaredNode = typeof engines.node === 'string'
    ? engines.node.match(/(?:^|[^0-9])(\d+)(?:\.(\d+))?/)
    : null;
  const nodeVersion = declaredNode
    ? `${declaredNode[1]}${declaredNode[2] ? `.${declaredNode[2]}` : ''}`
    : process.versions.node.split('.')[0];
  toolchains.push({
    kind: 'node',
    version: nodeVersion,
    ...(locked || packageManager !== 'npm' ? { cache: packageManager as 'npm' | 'yarn' | 'pnpm' } : {}),
    ...(files.has('package-lock.json') ? { cacheDependencyPath: 'package-lock.json' } : {}),
  });
  const install: QualityContract['localValidation']['prepare'][number] = {
    executable: packageManager,
    args: packageManager === 'npm' ? ['ci'] : ['install', '--frozen-lockfile'],
    cwd: '.', platforms: [...ALL_PLATFORMS], timeoutMs: 600_000,
  };
  setup.push(structuredClone(install));
  localPrepare.push(install);

  if (hasScript('test')) addCheck(groups, 'test', commandCheck('test', 'root', packageManager, ['test'], '.'));
  if (hasScript('build')) addCheck(groups, 'build', commandCheck('build', 'root', packageManager, ['run', 'build'], '.'));
  for (const name of ['typecheck', 'lint', 'format:check']) {
    if (hasScript(name)) {
      addCheck(groups, 'static', commandCheck(name.replace(':', '-'), 'root', packageManager, ['run', name], '.'));
    }
  }
  if (packageManager === 'npm' && locked) {
    addCheck(groups, 'security', commandCheck(
      'production-audit', 'root', 'npm', ['audit', '--omit=dev', '--audit-level=high'], '.', ['linux'],
    ));
  }
  return true;
}

function discoverGo(
  root: string,
  files: string[],
  groups: Record<QualityCheckCategory, QualityCheck[]>,
  modules: QualityContract['modules'],
  toolchains: QualityToolchain[],
): boolean {
  const goMods = files.filter((file) => posix.basename(file) === 'go.mod').sort();
  if (goMods.length === 0) return false;
  const versions = new Set(goMods.map((file) => {
    const match = readFileSync(resolve(root, file), 'utf8').match(/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m);
    if (!match) throw new Error(`${file} 没有可识别的 go 版本；请提供经人工确认的 --contract`);
    return match[1];
  }));
  if (versions.size !== 1) {
    throw new Error('多个 go.mod 声明了不同 Go 版本；请提供按任务拆分的 --contract');
  }
  toolchains.push({
    kind: 'go', version: [...versions][0], cache: true,
    cacheDependencyPath: goMods.length === 1
      ? `${posix.dirname(goMods[0])}/go.sum`.replace(/^\.\//, '')
      : '**/go.sum',
  });
  for (const [index, file] of goMods.entries()) {
    const path = posix.dirname(file) === '.' ? '.' : posix.dirname(file);
    const id = moduleId(path, index === 0 ? 'go' : `go-${index + 1}`);
    if (!modules.some((module) => module.id === id)) modules.push({ id, path });
    addCheck(groups, 'test', commandCheck(`test-${id}`, id, 'go', ['test', './...'], path));
    addCheck(groups, 'build', commandCheck(`build-${id}`, id, 'go', ['build', './...'], path));
    addCheck(groups, 'static', commandCheck(`vet-${id}`, id, 'go', ['vet', './...'], path));
  }
  return true;
}

function discoverPython(files: string[]): boolean {
  const configs = files.filter((file) => posix.basename(file) === 'pyproject.toml').sort();
  if (configs.length === 0) return false;
  throw new Error(
    '检测到 Python 项目，但无法从 pyproject.toml 安全推导可重复的本地隔离环境与依赖安装命令；' +
      '请提供经人工确认、同时声明 localValidation.prepare 和 allowedPaths 的 --contract 文件',
  );
}

function existingStandards(files: Set<string>): string[] {
  return [
    'AGENTS.md', 'docs/golden-principles.md', 'docs/patterns.md',
    'docs/architecture.md', 'CONTRIBUTING.md', 'README.md',
  ].filter((path) => files.has(path));
}

/**
 * 只发现仓库已声明的命令和文档，不运行命令、不写文件。没有候选的类别保留明确待确认标记，
 * 调用方必须取得具体不适用理由后才能写正式契约。
 */
export function discoverQualityContract(
  root: string,
  repository: GitHubRepositoryInfo,
  codingXVersion: string,
): QualityContractDraft {
  const tracked = gitFiles(root);
  const files = new Set(tracked);
  const groups: Record<QualityCheckCategory, QualityCheck[]> = {
    test: [], build: [], static: [], security: [],
  };
  const modules: QualityContract['modules'] = [];
  const setup: QualityContract['github']['jobs'][number]['setup'] = [];
  const localPrepare: QualityContract['localValidation']['prepare'] = [];
  const toolchains: QualityToolchain[] = [];
  const ecosystems: string[] = [];

  if (discoverNode(root, files, groups, setup, localPrepare, toolchains)) {
    modules.push({ id: 'root', path: '.' });
    ecosystems.push('node');
  }
  if (discoverGo(root, tracked, groups, modules, toolchains)) ecosystems.push('go');
  if (discoverPython(tracked)) ecosystems.push('python');
  if (ecosystems.length === 0) {
    throw new Error('未发现受支持的 Node、Go 或 Python 项目；请提供经人工确认的 --contract 文件');
  }
  const standards = existingStandards(files);
  if (standards.length === 0) {
    throw new Error('未发现工程规范文档；请先提交 AGENTS.md、CONTRIBUTING.md 或 README.md');
  }

  const unresolvedCategories = CATEGORIES.filter((category) => groups[category].length === 0);
  const checks = Object.fromEntries(CATEGORIES.map((category) => [
    category,
    groups[category].length > 0
      ? { checks: groups[category] }
      : { notApplicable: UNRESOLVED },
  ])) as QualityContract['checks'];
  const specs = tracked.some((file) => file.startsWith('docs/specs/'))
    ? [{ kind: 'path' as const, path: 'docs/specs/**' }, { kind: 'pull-request' as const }]
    : [{ kind: 'pull-request' as const }];
  const generatedPaths = [...new Set([
    ...(ecosystems.includes('node') ? ['dist/**', 'build/**', 'coverage/**'] : []),
    ...(ecosystems.includes('python')
      ? ['dist/**', 'build/**', '.pytest_cache/**', '**/__pycache__/**', '**/*.egg-info/**']
      : []),
  ])];
  const allowedPaths = [
    ...(ecosystems.includes('node') ? ['node_modules/**'] : []),
  ];
  const jobs = ALL_PLATFORMS.map((platform) => ({
    id: `${platform}-primary`,
    platform,
    toolchains: structuredClone(toolchains),
    setup: setup.filter((command) => command.platforms.includes(platform)),
    checkIds: CATEGORIES.flatMap((category) => groups[category]
      .filter((check) => check.command.platforms.includes(platform))
      .map((check) => check.id)),
  })).filter((job) => job.checkIds.length > 0);

  return {
    detectedEcosystems: ecosystems,
    unresolvedCategories,
    contract: {
      schemaVersion: 2,
      codingXVersion,
      repository: {
        provider: 'github',
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
      },
      release: { protectedRefs: ['v*'] },
      sources: {
        specs,
        acceptanceCriteria: [{ kind: 'pull-request' }],
        engineeringStandards: standards,
      },
      modules,
      generatedPaths,
      localValidation: {
        prepare: localPrepare,
        allowedPaths,
      },
      checks,
      risk: {
        defaultCategories: [
          'policy', 'public-contract', 'state', 'migration', 'recovery', 'idempotency',
          'concurrency', 'timeout', 'retry', 'subprocess', 'security', 'privacy',
          'untrusted-input', 'cross-module', 'large-file', 'reviewer-request', 'release',
        ],
        highRiskPaths: ['.coding-x/**', '.github/workflows/**'],
        pathRules: [{
          paths: ['.coding-x/**', '.github/workflows/**'],
          categories: ['policy', 'security'],
        }],
      },
      github: {
        jobs,
        requiredChecks: [...REQUIRED_GITHUB_CHECKS],
      },
      exceptions: {
        p1: { issueTemplate: '.github/ISSUE_TEMPLATE/quality-p1.yml', maxDays: 30 },
        policy: { issueTemplate: '.github/ISSUE_TEMPLATE/quality-policy.yml', maxDays: 7 },
      },
    },
  };
}

const CATEGORIES: QualityCheckCategory[] = ['test', 'build', 'static', 'security'];

export function resolveNotApplicableReasons(
  draft: QualityContractDraft,
  reasons: Partial<Record<QualityCheckCategory, string>>,
): QualityContract {
  const contract = structuredClone(draft.contract);
  for (const category of draft.unresolvedCategories) {
    const reason = reasons[category]?.trim();
    if (!reason) throw new Error(`${category} 缺少具体不适用理由`);
    contract.checks[category] = { notApplicable: reason };
  }
  return contract;
}

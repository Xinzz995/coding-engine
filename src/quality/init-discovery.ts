import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { readSafeProjectFileUtf8Sync } from '../engine/safe-control-file.js';
import { execTrustedToolSync } from '../engine/trusted-tool.js';
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
const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] as const;
const DISCOVERY_FILE_MAX_BYTES = 4 * 1024 * 1024;
const DISCOVERY_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const DISCOVERY_FILE_LIMIT = 512;

interface DiscoveryReadBudget {
  files: number;
  bytes: number;
}

function readDiscoveryFile(
  root: string,
  relativePath: string,
  budget: DiscoveryReadBudget,
): string {
  if (budget.files >= DISCOVERY_FILE_LIMIT) {
    throw new Error(
      `自动发现配置文件超过 ${DISCOVERY_FILE_LIMIT} 个；请提供经人工确认的 --contract`,
    );
  }
  const value = readSafeProjectFileUtf8Sync(root, resolve(root, relativePath), {
    maxBytes: DISCOVERY_FILE_MAX_BYTES,
  });
  if (value === null) throw new Error(`${relativePath} 在自动发现期间消失`);
  const bytes = Buffer.byteLength(value);
  if (budget.bytes + bytes > DISCOVERY_TOTAL_MAX_BYTES) {
    throw new Error(
      `自动发现配置文件总量超过 ${DISCOVERY_TOTAL_MAX_BYTES} bytes；` +
        '请提供经人工确认的 --contract',
    );
  }
  budget.files += 1;
  budget.bytes += bytes;
  return value;
}

export interface QualityContractDraft {
  contract: QualityContract;
  unresolvedCategories: QualityCheckCategory[];
  detectedEcosystems: string[];
}

function gitFiles(root: string): string[] {
  try {
    return execTrustedToolSync('git', [...SAFE_GIT_CONFIG, 'ls-files', '-z'], {
      cwd: root,
      projectRoot: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `无法读取 Git 跟踪文件：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function moduleId(path: string, fallback: string): string {
  if (path === '.') return fallback;
  return (
    path
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || fallback
  );
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
  toolchains: QualityToolchain[],
  budget: DiscoveryReadBudget,
): boolean {
  if (!files.has('package.json')) return false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readDiscoveryFile(root, 'package.json', budget));
  } catch (error) {
    throw new Error(
      `package.json 无法安全读取或解析，不能发现 Node 项目检查：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const scripts =
    typeof pkg === 'object' &&
    pkg !== null &&
    !Array.isArray(pkg) &&
    typeof (pkg as Record<string, unknown>).scripts === 'object' &&
    (pkg as Record<string, unknown>).scripts !== null
      ? ((pkg as Record<string, unknown>).scripts as Record<string, unknown>)
      : {};
  const engines =
    typeof pkg === 'object' &&
    pkg !== null &&
    !Array.isArray(pkg) &&
    typeof (pkg as Record<string, unknown>).engines === 'object' &&
    (pkg as Record<string, unknown>).engines !== null
      ? ((pkg as Record<string, unknown>).engines as Record<string, unknown>)
      : {};
  const hasScript = (name: string) =>
    typeof scripts[name] === 'string' &&
    scripts[name].trim() !== '' &&
    !scripts[name].includes('no test specified');

  let packageManager = 'npm';
  if (files.has('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (files.has('yarn.lock')) packageManager = 'yarn';
  const locked = files.has('package-lock.json') || files.has('npm-shrinkwrap.json');
  const declaredNode =
    typeof engines.node === 'string' ? engines.node.match(/(?:^|[^0-9])(\d+)(?:\.(\d+))?/) : null;
  const nodeVersion = declaredNode
    ? `${declaredNode[1]}${declaredNode[2] ? `.${declaredNode[2]}` : ''}`
    : process.versions.node.split('.')[0];
  toolchains.push({
    kind: 'node',
    version: nodeVersion,
    ...(locked || packageManager !== 'npm'
      ? { cache: packageManager as 'npm' | 'yarn' | 'pnpm' }
      : {}),
    ...(files.has('package-lock.json') ? { cacheDependencyPath: 'package-lock.json' } : {}),
  });
  setup.push({
    executable: packageManager,
    args: packageManager === 'npm' ? [locked ? 'ci' : 'install'] : ['install', '--frozen-lockfile'],
    cwd: '.',
    platforms: [...ALL_PLATFORMS],
    timeoutMs: 600_000,
  });

  if (hasScript('test'))
    addCheck(groups, 'test', commandCheck('test', 'root', packageManager, ['test'], '.'));
  if (hasScript('build'))
    addCheck(groups, 'build', commandCheck('build', 'root', packageManager, ['run', 'build'], '.'));
  for (const name of ['typecheck', 'lint', 'format:check']) {
    if (hasScript(name)) {
      addCheck(
        groups,
        'static',
        commandCheck(name.replace(':', '-'), 'root', packageManager, ['run', name], '.'),
      );
    }
  }
  if (packageManager === 'npm' && locked) {
    addCheck(
      groups,
      'security',
      commandCheck(
        'production-audit',
        'root',
        'npm',
        ['audit', '--omit=dev', '--audit-level=high'],
        '.',
        ['linux'],
      ),
    );
  }
  return true;
}

function discoverGo(
  root: string,
  files: string[],
  groups: Record<QualityCheckCategory, QualityCheck[]>,
  modules: QualityContract['modules'],
  toolchains: QualityToolchain[],
  budget: DiscoveryReadBudget,
): boolean {
  const goMods = files.filter((file) => posix.basename(file) === 'go.mod').sort();
  if (goMods.length === 0) return false;
  const versions = new Set(
    goMods.map((file) => {
      const match = readDiscoveryFile(root, file, budget).match(/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m);
      if (!match) throw new Error(`${file} 没有可识别的 go 版本；请提供经人工确认的 --contract`);
      return match[1];
    }),
  );
  if (versions.size !== 1) {
    throw new Error('多个 go.mod 声明了不同 Go 版本；请提供按任务拆分的 --contract');
  }
  toolchains.push({
    kind: 'go',
    version: [...versions][0],
    cache: true,
    cacheDependencyPath:
      goMods.length === 1 ? `${posix.dirname(goMods[0])}/go.sum`.replace(/^\.\//, '') : '**/go.sum',
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

function discoverPython(
  root: string,
  files: string[],
  groups: Record<QualityCheckCategory, QualityCheck[]>,
  modules: QualityContract['modules'],
  setup: QualityContract['github']['jobs'][number]['setup'],
  toolchains: QualityToolchain[],
  budget: DiscoveryReadBudget,
): boolean {
  const configs = files.filter((file) => posix.basename(file) === 'pyproject.toml').sort();
  if (configs.length === 0) return false;
  const declaredVersions = new Set<string>();
  for (const [index, file] of configs.entries()) {
    const path = posix.dirname(file) === '.' ? '.' : posix.dirname(file);
    const id = moduleId(path, index === 0 ? 'python' : `python-${index + 1}`);
    if (!modules.some((module) => module.id === id)) modules.push({ id, path });
    const text = readDiscoveryFile(root, file, budget);
    const requiresPython = text.match(/^requires-python\s*=\s*["'][^"']*?(\d+\.\d+)/m);
    if (requiresPython) declaredVersions.add(requiresPython[1]);
    setup.push({
      executable: 'python',
      args: ['-m', 'pip', 'install', '-e', '.'],
      cwd: path,
      platforms: [...ALL_PLATFORMS],
      timeoutMs: 600_000,
    });
    const hasTests =
      files.some((candidate) => candidate.startsWith(path === '.' ? 'tests/' : `${path}/tests/`)) ||
      /pytest/i.test(text);
    if (hasTests)
      addCheck(groups, 'test', commandCheck(`test-${id}`, id, 'python', ['-m', 'pytest'], path));
    if (/^\s*\[build-system\]\s*$/m.test(text)) {
      addCheck(
        groups,
        'build',
        commandCheck(
          `build-${id}`,
          id,
          'python',
          ['-m', 'pip', 'wheel', '.', '--no-deps', '--wheel-dir', 'dist'],
          path,
        ),
      );
    }
    if (/^\s*\[tool\.ruff(?:\.|\])?/m.test(text)) {
      addCheck(
        groups,
        'static',
        commandCheck(`ruff-${id}`, id, 'python', ['-m', 'ruff', 'check', '.'], path),
      );
    }
    if (/^\s*\[tool\.mypy\]\s*$/m.test(text)) {
      addCheck(
        groups,
        'static',
        commandCheck(`mypy-${id}`, id, 'python', ['-m', 'mypy', '.'], path),
      );
    }
  }
  if (declaredVersions.size > 1) {
    throw new Error('多个 pyproject.toml 声明了不同 Python 版本；请提供按任务拆分的 --contract');
  }
  let pythonVersion = [...declaredVersions][0];
  if (!pythonVersion) {
    try {
      const output = execFileSync('python3', ['--version'], { encoding: 'utf8' });
      pythonVersion = output.match(/(\d+\.\d+)/)?.[1] ?? '';
    } catch {
      pythonVersion = '';
    }
  }
  if (!pythonVersion) {
    throw new Error(
      '无法确定 Python 版本；请在 pyproject.toml 声明 requires-python 或提供 --contract',
    );
  }
  toolchains.push({ kind: 'python', version: pythonVersion });
  return true;
}

function existingStandards(files: Set<string>): string[] {
  return [
    'AGENTS.md',
    'docs/golden-principles.md',
    'docs/patterns.md',
    'docs/architecture.md',
    'CONTRIBUTING.md',
    'README.md',
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
    test: [],
    build: [],
    static: [],
    security: [],
  };
  const modules: QualityContract['modules'] = [];
  const setup: QualityContract['github']['jobs'][number]['setup'] = [];
  const toolchains: QualityToolchain[] = [];
  const ecosystems: string[] = [];
  const discoveryBudget: DiscoveryReadBudget = { files: 0, bytes: 0 };

  if (discoverNode(root, files, groups, setup, toolchains, discoveryBudget)) {
    modules.push({ id: 'root', path: '.' });
    ecosystems.push('node');
  }
  if (discoverGo(root, tracked, groups, modules, toolchains, discoveryBudget))
    ecosystems.push('go');
  if (discoverPython(root, tracked, groups, modules, setup, toolchains, discoveryBudget)) {
    ecosystems.push('python');
  }
  if (ecosystems.length === 0) {
    throw new Error('未发现受支持的 Node、Go 或 Python 项目；请提供经人工确认的 --contract 文件');
  }
  const standards = existingStandards(files);
  if (standards.length === 0) {
    throw new Error('未发现工程规范文档；请先提交 AGENTS.md、CONTRIBUTING.md 或 README.md');
  }

  const unresolvedCategories = CATEGORIES.filter((category) => groups[category].length === 0);
  const checks = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      groups[category].length > 0 ? { checks: groups[category] } : { notApplicable: UNRESOLVED },
    ]),
  ) as QualityContract['checks'];
  const specs = tracked.some((file) => file.startsWith('docs/specs/'))
    ? [{ kind: 'path' as const, path: 'docs/specs/**' }, { kind: 'pull-request' as const }]
    : [{ kind: 'pull-request' as const }];
  const generatedPaths = ['dist', 'build', 'coverage', '.pytest_cache']
    .filter((path) => existsSync(resolve(root, path)))
    .map((path) => `${path}/**`);
  const jobs = ALL_PLATFORMS.map((platform) => ({
    id: `${platform}-primary`,
    platform,
    toolchains: structuredClone(toolchains),
    setup: setup.filter((command) => command.platforms.includes(platform)),
    checkIds: CATEGORIES.flatMap((category) =>
      groups[category]
        .filter((check) => check.command.platforms.includes(platform))
        .map((check) => check.id),
    ),
  })).filter((job) => job.checkIds.length > 0);

  return {
    detectedEcosystems: ecosystems,
    unresolvedCategories,
    contract: {
      schemaVersion: 1,
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
      checks,
      risk: {
        defaultCategories: [
          'policy',
          'public-contract',
          'state',
          'migration',
          'recovery',
          'idempotency',
          'concurrency',
          'timeout',
          'retry',
          'subprocess',
          'security',
          'privacy',
          'untrusted-input',
          'cross-module',
          'large-file',
          'reviewer-request',
          'release',
        ],
        highRiskPaths: ['.coding-x/**', '.github/workflows/**'],
        pathRules: [
          {
            paths: ['.coding-x/**', '.github/workflows/**'],
            categories: ['policy', 'security'],
          },
        ],
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

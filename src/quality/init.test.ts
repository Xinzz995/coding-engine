import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readQualityContract, type QualityContract } from './contract.js';
import {
  MANAGED_RULESET_NAME,
  type GitHubCheckRun,
  type GitHubPullRequestInfo,
  type GitHubQualityClient,
  type GitHubRepositoryInfo,
  type GitHubRuleset,
  type GitHubRulesetPayload,
  MANAGED_RELEASE_RULESET_NAME,
} from './github.js';
import { QUALITY_WORKFLOW_PATH } from './github-workflows.js';
import { runQualityInit } from './init.js';
import { codeScanningToolsFromRuleset, requiredChecksFromRuleset } from './ruleset.js';
import { findManagedReleaseRuleset, validateManagedReleaseRuleset } from './release-ruleset.js';
import { CODING_X_VERSION } from '../version.js';

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function codingEngineContract(): QualityContract {
  const result = readQualityContract(process.cwd());
  if (result.status !== 'ready') throw new Error(`root contract unavailable: ${result.status}`);
  const contract = structuredClone(result.contract);
  contract.repository.fullName = 'example/project';
  contract.repository.defaultBranch = 'main';
  return contract;
}

function repositoryFixture(contract = codingEngineContract()): string {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-init-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'quality@test.local');
  git(root, 'config', 'user.name', 'quality-test');
  writeFileSync(join(root, 'README.md'), '# Project\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Rules\n');
  mkdirSync(join(root, '.coding-x'), { recursive: true });
  writeFileSync(join(root, '.coding-x/quality.json'), `${JSON.stringify(contract, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', '初始提交');
  git(root, 'checkout', '-b', 'bootstrap-quality');
  return root;
}

function discoveryFixture(): string {
  const root = repositoryFixture();
  rmSync(join(root, '.coding-x/quality.json'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      engines: { node: '>=22' },
      scripts: {
        test: 'node --test',
        build: 'node build.mjs',
        lint: 'eslint .',
      },
    }),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }),
  );
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github/workflows/existing.yml'),
    'jobs:\n  desktop:\n    runs-on: macos-26\n  dynamic:\n    runs-on: ${{ matrix.runner }}\n',
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-m', '准备自动发现');
  return root;
}

function contractVersion(root: string): string {
  const result = readQualityContract(root);
  if (result.status !== 'ready') throw new Error(`fixture contract unavailable: ${result.status}`);
  return result.contract.codingXVersion;
}

function check(name: string, sha: string, over: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    name,
    headSha: sha,
    status: 'completed',
    conclusion: 'success',
    app: { id: 15368, slug: 'github-actions', name: 'GitHub Actions' },
    ...over,
  };
}

class FakeGitHubClient implements GitHubQualityClient {
  repository: GitHubRepositoryInfo = {
    fullName: 'example/project',
    defaultBranch: 'main',
    isPrivate: true,
  };
  rulesets: GitHubRuleset[] = [];
  pullRequest: GitHubPullRequestInfo | null = null;
  runs: GitHubCheckRun[] = [];
  labels = new Set<string>();
  events: string[] = [];
  corruptReadback = false;
  immutableReleases = false;
  nextRulesetId = 101;
  onDiscoverRepository?: () => void;

  discoverRepository(): GitHubRepositoryInfo {
    this.events.push('discover');
    this.onDiscoverRepository?.();
    return structuredClone(this.repository);
  }

  verifyDefaultBranch(): void {
    this.events.push('verify-default');
  }

  listRulesets(): GitHubRuleset[] {
    return structuredClone(this.rulesets);
  }

  getRuleset(_repository: string, id: number): GitHubRuleset {
    const value = this.rulesets.find((ruleset) => ruleset.id === id);
    if (!value) throw new Error(`missing ruleset ${id}`);
    const result = structuredClone(value);
    if (this.corruptReadback) result.enforcement = 'disabled';
    return result;
  }

  createRuleset(_repository: string, payload: GitHubRulesetPayload): GitHubRuleset {
    this.events.push('create-ruleset');
    const value: GitHubRuleset = { id: this.nextRulesetId++, ...structuredClone(payload) };
    this.rulesets.push(value);
    return structuredClone(value);
  }

  updateRuleset(_repository: string, id: number, payload: GitHubRulesetPayload): GitHubRuleset {
    this.events.push('update-ruleset');
    const value: GitHubRuleset = { id, ...structuredClone(payload) };
    const index = this.rulesets.findIndex((ruleset) => ruleset.id === id);
    if (index < 0) throw new Error(`missing ruleset ${id}`);
    this.rulesets[index] = value;
    return structuredClone(value);
  }

  findOpenPullRequest(): GitHubPullRequestInfo | null {
    return structuredClone(this.pullRequest);
  }

  listCheckRuns(): GitHubCheckRun[] {
    return structuredClone(this.runs);
  }

  getImmutableReleases() {
    return { enabled: this.immutableReleases, enforcedByOwner: false };
  }

  enableImmutableReleases(): void {
    this.events.push('enable-immutable-releases');
    this.immutableReleases = true;
  }

  ensureLabel(_repository: string, name: string): void {
    this.events.push(`label:${name}`);
    this.labels.add(name);
  }
}

function options(
  root: string,
  client: FakeGitHubClient,
  confirmations: boolean[] = [],
  summaries: string[] = [],
) {
  return {
    root,
    actualVersion: contractVersion(root),
    client,
    confirm: async (summary: string) => {
      summaries.push(summary);
      return confirmations.shift() ?? true;
    },
    ask: async () => '经仓库所有者确认不适用。',
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('runQualityInit', () => {
  it('always reads the supplied contract and permits only that exact untracked candidate', async () => {
    const root = discoveryFixture();
    const contract = structuredClone(codingEngineContract());
    contract.codingXVersion = CODING_X_VERSION;
    const candidatePath = 'confirmed-quality.json';
    writeFileSync(join(root, candidatePath), `${JSON.stringify(contract, null, 2)}\n`);

    const result = await runQualityInit({
      root,
      actualVersion: CODING_X_VERSION,
      client: new FakeGitHubClient(),
      confirm: async () => true,
      ask: async () => '经仓库所有者确认不适用。',
      contractFile: candidatePath,
    });
    expect(result).toMatchObject({ status: 'files-created', exitCode: 6 });
    expect(readQualityContract(root)).toMatchObject({
      status: 'ready',
      contract: { codingXVersion: CODING_X_VERSION },
    });
  });

  it('rejects a missing or inconsistent supplied contract even when an existing contract is ready', async () => {
    const root = repositoryFixture();
    const client = new FakeGitHubClient();
    await expect(
      runQualityInit({
        ...options(root, client),
        contractFile: 'missing-quality.json',
      }),
    ).rejects.toThrow('无法读取契约输入');

    const changed = structuredClone(codingEngineContract());
    changed.github.requiredPlatforms = ['linux'];
    writeFileSync(join(root, 'changed-quality.json'), `${JSON.stringify(changed, null, 2)}\n`);
    await expect(
      runQualityInit({
        ...options(root, client),
        contractFile: 'changed-quality.json',
      }),
    ).rejects.toThrow('与现有 .coding-x/quality.json 不一致');
    expect(client.rulesets).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a contract candidate whose symlink points outside the repository',
    async () => {
      const root = discoveryFixture();
      const outside = mkdtempSync(join(tmpdir(), 'coding-x-contract-outside-'));
      roots.push(outside);
      writeFileSync(join(outside, 'quality.json'), `${JSON.stringify(codingEngineContract())}\n`);
      symlinkSync(join(outside, 'quality.json'), join(root, 'linked-quality.json'));

      await expect(
        runQualityInit({
          root,
          actualVersion: CODING_X_VERSION,
          client: new FakeGitHubClient(),
          confirm: async () => true,
          ask: async () => '经仓库所有者确认不适用。',
          contractFile: 'linked-quality.json',
        }),
      ).rejects.toThrow('真实位置位于项目根之外');
    },
  );

  it('rejects a contract candidate replaced by a different regular file during repository discovery', async () => {
    const root = discoveryFixture();
    const candidatePath = 'confirmed-quality.json';
    const contract = structuredClone(codingEngineContract());
    contract.codingXVersion = CODING_X_VERSION;
    writeFileSync(join(root, candidatePath), `${JSON.stringify(contract, null, 2)}\n`);
    const client = new FakeGitHubClient();
    client.onDiscoverRepository = () => {
      const replacement = structuredClone(contract);
      replacement.repository.fullName = 'outside/project';
      writeFileSync(join(root, candidatePath), `${JSON.stringify(replacement, null, 2)}\n`);
    };

    await expect(
      runQualityInit({
        root,
        actualVersion: CODING_X_VERSION,
        client,
        confirm: async () => true,
        ask: async () => '经仓库所有者确认不适用。',
        contractFile: candidatePath,
      }),
    ).rejects.toThrow('契约输入在仓库探测期间发生变化');
    expect(client.events).not.toEqual(
      expect.arrayContaining(['create-ruleset', 'update-ruleset', 'enable-immutable-releases']),
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a contract candidate redirected outside during repository discovery',
    async () => {
      const root = discoveryFixture();
      const candidatePath = 'confirmed-quality.json';
      const contract = structuredClone(codingEngineContract());
      contract.codingXVersion = CODING_X_VERSION;
      writeFileSync(join(root, candidatePath), `${JSON.stringify(contract, null, 2)}\n`);
      const outside = mkdtempSync(join(tmpdir(), 'coding-x-contract-outside-'));
      roots.push(outside);
      const replacement = structuredClone(contract);
      replacement.repository.fullName = 'outside/project';
      writeFileSync(join(outside, 'quality.json'), `${JSON.stringify(replacement, null, 2)}\n`);
      const client = new FakeGitHubClient();
      client.onDiscoverRepository = () => {
        rmSync(join(root, candidatePath));
        symlinkSync(join(outside, 'quality.json'), join(root, candidatePath));
      };

      await expect(
        runQualityInit({
          root,
          actualVersion: CODING_X_VERSION,
          client,
          confirm: async () => true,
          ask: async () => '经仓库所有者确认不适用。',
          contractFile: candidatePath,
        }),
      ).rejects.toThrow('真实位置位于项目根之外');
      expect(client.events).not.toEqual(
        expect.arrayContaining(['create-ruleset', 'update-ruleset', 'enable-immutable-releases']),
      );
    },
  );

  it('asks for required platforms before any local or remote write and generates only that selection', async () => {
    const root = discoveryFixture();
    const client = new FakeGitHubClient();
    const emitted: string[] = [];
    const questions: string[] = [];
    let workspacePrepared = false;
    const result = await runQualityInit({
      root,
      actualVersion: CODING_X_VERSION,
      client,
      emit: (message) => emitted.push(message),
      confirm: async () => true,
      ask: async (question) => {
        questions.push(question);
        expect(question).toContain('linux、macos、windows');
        expect(existsSync(join(root, '.coding-x/quality.json'))).toBe(false);
        expect(workspacePrepared).toBe(false);
        expect(client.events).not.toEqual(
          expect.arrayContaining(['create-ruleset', 'update-ruleset', 'enable-immutable-releases']),
        );
        return 'macos, windows';
      },
      prepareWorkspace: () => {
        workspacePrepared = true;
      },
    });

    expect(result).toMatchObject({ status: 'files-created', exitCode: 6 });
    expect(workspacePrepared).toBe(true);
    expect(emitted.join('\n')).toContain('macos');
    expect(questions.join('\n')).toContain('动态或 self-hosted');
    const contract = readQualityContract(root);
    expect(contract.status).toBe('ready');
    if (contract.status !== 'ready') return;
    expect(contract.contract.github.requiredPlatforms).toEqual(['macos', 'windows']);
    expect(contract.contract.github.jobs.map((job) => job.platform)).toEqual(['macos', 'windows']);
  });

  it('stops on an empty platform answer before workspace, GitHub, or repository writes', async () => {
    const root = discoveryFixture();
    const client = new FakeGitHubClient();
    let workspacePrepared = false;
    await expect(
      runQualityInit({
        root,
        actualVersion: CODING_X_VERSION,
        client,
        confirm: async () => true,
        ask: async () => '   ',
        prepareWorkspace: () => {
          workspacePrepared = true;
        },
      }),
    ).rejects.toThrow('至少选择一个平台');
    expect(workspacePrepared).toBe(false);
    expect(existsSync(join(root, '.coding-x/quality.json'))).toBe(false);
    expect(client.rulesets).toEqual([]);
  });

  it('completes minimum lock, managed files, quality gate activation, then policy activation', async () => {
    const root = repositoryFixture();
    const client = new FakeGitHubClient();
    const summaries: string[] = [];

    const generated = await runQualityInit(options(root, client, [], summaries));
    expect(generated).toMatchObject({
      status: 'files-created',
      exitCode: 6,
      rulesetId: 101,
      activeRequiredChecks: [],
      pendingRequiredChecks: ['quality-gate', 'policy-guard-source'],
    });
    expect(client.rulesets[0].name).toBe(MANAGED_RULESET_NAME);
    expect(requiredChecksFromRuleset(client.rulesets[0])).toEqual([]);
    expect(codeScanningToolsFromRuleset(client.rulesets[0])).toEqual(
      codingEngineContract().github.requiredCodeScanning,
    );
    const releaseRuleset = findManagedReleaseRuleset(client.rulesets);
    expect(releaseRuleset?.name).toBe(MANAGED_RELEASE_RULESET_NAME);
    expect(validateManagedReleaseRuleset(releaseRuleset!, ['v*'])).toEqual([]);
    expect(client.immutableReleases).toBe(true);
    expect(generated).toMatchObject({ releaseRulesetId: 102, immutableReleases: true });
    expect(summaries[0]).toContain('CodeQL（安全 high_or_higher；普通 errors）');
    expect(summaries[1]).toContain('即将保护 GitHub 发布标签：v*');
    expect(existsSync(join(root, QUALITY_WORKFLOW_PATH))).toBe(true);
    expect(readFileSync(join(root, QUALITY_WORKFLOW_PATH), 'utf8')).toContain('name: quality-gate');
    expect(client.labels).toEqual(
      new Set([
        'quality-policy-approved',
        'quality-policy-exception',
        'quality-p1-deferral',
        'ready-for-agent',
      ]),
    );

    git(root, 'add', '.');
    git(root, 'commit', '-m', '加入质量门禁');
    const head = git(root, 'rev-parse', 'HEAD');
    client.pullRequest = {
      number: 7,
      headSha: head,
      baseBranch: 'main',
      url: 'https://example.test/pr/7',
    };
    client.runs = [check('quality-gate', head)];

    const qualityActive = await runQualityInit(options(root, client));
    expect(qualityActive).toMatchObject({
      status: 'checks-activated',
      exitCode: 6,
      pullRequest: 7,
      activeRequiredChecks: ['quality-gate'],
      pendingRequiredChecks: ['policy-guard-source'],
    });
    expect(requiredChecksFromRuleset(client.rulesets[0])).toEqual([
      { context: 'quality-gate', integration_id: 15368 },
    ]);

    client.runs.push(check('policy-guard-source', head));
    const ready = await runQualityInit(options(root, client));
    expect(ready.status).toBe('ready');
    expect(ready.exitCode).toBe(0);
    expect(new Set(ready.activeRequiredChecks)).toEqual(
      new Set(['quality-gate', 'policy-guard-source']),
    );
    expect(ready.pendingRequiredChecks).toEqual([]);
  });

  it('does not write managed files when the user declines the minimum remote rule', async () => {
    const root = repositoryFixture();
    const client = new FakeGitHubClient();
    let workspacePrepared = false;
    const result = await runQualityInit({
      ...options(root, client, [false]),
      prepareWorkspace: () => {
        workspacePrepared = true;
      },
    });
    expect(result).toMatchObject({ status: 'cancelled', exitCode: 6 });
    expect(result.message).toContain('已完成的 workspace 安全初始化保留');
    expect(workspacePrepared).toBe(true);
    expect(client.rulesets).toEqual([]);
    expect(existsSync(join(root, QUALITY_WORKFLOW_PATH))).toBe(false);
  });

  it('can require immutable Releases without inventing a release tag Ruleset', async () => {
    const contract = codingEngineContract();
    contract.release = { protectedRefs: [], notApplicable: '该项目不创建发布标签。' };
    const root = repositoryFixture(contract);
    const client = new FakeGitHubClient();
    const result = await runQualityInit(options(root, client));
    expect(result).toMatchObject({
      status: 'files-created',
      releaseRulesetId: null,
      immutableReleases: true,
    });
    expect(client.rulesets.map((ruleset) => ruleset.name)).toEqual([MANAGED_RULESET_NAME]);
    expect(client.events).toContain('enable-immutable-releases');
  });

  it('rejects a same-name check from any source other than one unique GitHub Actions app', async () => {
    const root = repositoryFixture();
    const client = new FakeGitHubClient();
    await runQualityInit(options(root, client));
    git(root, 'add', '.');
    git(root, 'commit', '-m', '加入质量门禁');
    const head = git(root, 'rev-parse', 'HEAD');
    client.pullRequest = {
      number: 8,
      headSha: head,
      baseBranch: 'main',
      url: 'https://example.test/pr/8',
    };
    client.runs = [
      check('quality-gate', head, {
        app: { id: 999, slug: 'external-ci', name: 'External CI' },
      }),
    ];
    await expect(runQualityInit(options(root, client))).rejects.toThrow(
      '不是唯一的 GitHub Actions 来源',
    );
    expect(requiredChecksFromRuleset(client.rulesets[0])).toEqual([]);
  });

  it('fails closed when GitHub readback differs from the rule just written', async () => {
    const root = repositoryFixture();
    const client = new FakeGitHubClient();
    client.corruptReadback = true;
    await expect(runQualityInit(options(root, client))).rejects.toThrow('回读核验失败');
    expect(existsSync(join(root, QUALITY_WORKFLOW_PATH))).toBe(false);
  });

  it('refuses unrelated dirty files', async () => {
    const dirtyRoot = repositoryFixture();
    writeFileSync(join(dirtyRoot, 'unrelated.txt'), 'do not mix\n');
    await expect(runQualityInit(options(dirtyRoot, new FakeGitHubClient()))).rejects.toThrow(
      '无关的改动',
    );
  }, 15_000);

  it('refuses initialization on the default branch', async () => {
    const mainRoot = repositoryFixture();
    git(mainRoot, 'checkout', 'main');
    await expect(runQualityInit(options(mainRoot, new FakeGitHubClient()))).rejects.toThrow(
      '默认分支',
    );
  }, 15_000);

  it('refuses a coding-x version that differs from the quality contract', async () => {
    const versionRoot = repositoryFixture();
    const expectedVersion = contractVersion(versionRoot);
    const mismatchedVersion = expectedVersion === '0.0.0' ? '0.0.1' : '0.0.0';
    await expect(
      runQualityInit({
        ...options(versionRoot, new FakeGitHubClient()),
        actualVersion: mismatchedVersion,
      }),
    ).rejects.toThrow(`质量契约固定 ${expectedVersion}`);
  }, 15_000);
});

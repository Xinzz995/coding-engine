import { describe, expect, it } from 'vitest';
import { readQualityContract, type QualityContract } from './contract.js';
import {
  CHECKOUT_ACTION_SHA,
  SETUP_GO_ACTION_SHA,
  SETUP_NODE_ACTION_SHA,
  POLICY_ISSUE_TEMPLATE_PATH,
  POLICY_WORKFLOW_PATH,
  PULL_REQUEST_TEMPLATE_PATH,
  QUALITY_WORKFLOW_PATH,
  renderManagedGitHubFiles,
  renderPolicyGuardWorkflow,
  renderQualityGateWorkflow,
} from './github-workflows.js';

function codingEngineContract(): QualityContract {
  const result = readQualityContract(process.cwd());
  if (result.status !== 'ready') throw new Error(`contract fixture unavailable: ${result.status}`);
  return result.contract;
}

function goContract(): QualityContract {
  const contract = structuredClone(codingEngineContract());
  contract.modules = [
    { id: 'api', path: 'services/api' },
    { id: 'worker', path: 'services/worker' },
  ];
  contract.checks = {
    test: {
      checks: contract.modules.map((module) => ({
        id: `test-${module.id}`,
        module: module.id,
        command: {
          executable: 'go',
          args: ['test', './...'],
          cwd: module.path,
          platforms: ['linux'],
          timeoutMs: 600_000,
        },
      })),
    },
    build: { notApplicable: '测试命令会编译所有包。' },
    static: { notApplicable: '试点项目暂未配置独立静态检查。' },
    security: { notApplicable: '试点项目没有外部运行时依赖。' },
  };
  contract.github.jobs = [
    {
      id: 'ubuntu-go',
      platform: 'linux',
      toolchains: [{ kind: 'go', version: '1.24', cache: true }],
      setup: [],
      checkIds: ['test-api', 'test-worker'],
    },
  ];
  return contract;
}

describe('coding-engine quality contract', () => {
  it('treats the workspace safety implementation and contracts as deep-review risk', () => {
    const risk = codingEngineContract().risk;
    expect(risk.highRiskPaths).toEqual(
      expect.arrayContaining([
        'assets/workspace-safety/**',
        'src/contracts/**',
        'src/workspace-safety/**',
      ]),
    );
    expect(risk.pathRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paths: ['src/workspace-safety/**'],
          categories: expect.arrayContaining(['recovery', 'concurrency', 'security']),
        }),
      ]),
    );
  });

  it('protects every required Windows native proof suite and compiler policy with old rules', () => {
    const policyPaths = codingEngineContract()
      .risk.pathRules.filter((rule) => rule.categories.includes('policy'))
      .flatMap((rule) => rule.paths);
    expect(policyPaths).toEqual(
      expect.arrayContaining([
        'src/workspace-safety/delegated-recovery.windows-crash.test.ts',
        'src/workspace-safety/windows-reparse-point.windows.test.ts',
        'src/workspace-safety/windows-supervisor.crash.test.ts',
        'src/workspace-safety/windows-supervisor-integration.test.ts',
        'src/workspace-safety/windows-supervisor.test.ts',
        'tsconfig.json',
      ]),
    );
  });
});

describe('renderQualityGateWorkflow', () => {
  it('creates unconditional native platform jobs and one always-run aggregate gate', () => {
    const yaml = renderQualityGateWorkflow(codingEngineContract());
    expect(yaml).toContain('on:\n  pull_request:');
    expect(yaml).toContain("push:\n    branches: ['main']");
    expect(yaml).not.toMatch(/paths(?:-ignore)?:/);
    expect(yaml).toContain('checks_ubuntu-node-22:');
    expect(yaml).toContain('checks_ubuntu-node-24:');
    expect(yaml).toContain('checks_macos-node-24:');
    expect(yaml).toContain('checks_windows-node-22:');
    expect(yaml).toContain('checks_windows-node-24:');
    expect(yaml).toContain('checks_windows-native-standard-user:');
    expect(yaml.match(/runs-on: windows-2022/gu)).toHaveLength(3);
    expect(yaml).not.toContain('windows-latest');
    expect(yaml).toContain('test / windows-native-proof');
    expect(yaml).toContain("& ''npm'' ''run'' ''test:windows-native-proof''");
    expect(yaml).toContain('name: quality-gate');
    expect(yaml).toContain('if: ${{ always() }}');
    expect(yaml).toContain(
      'needs: [checks_ubuntu-node-22, checks_ubuntu-node-24, checks_macos-node-24, checks_windows-node-22, checks_windows-node-24, checks_windows-native-standard-user]',
    );
    expect(yaml).toContain('must not fail, cancel, time out, or skip');
    expect(yaml).toContain('github.event.pull_request.number || github.ref');
    expect(yaml).not.toContain('github.event.pull_request.head.sha');
  });

  it('pins checkout by full commit and serializes structured commands for each native shell', () => {
    const yaml = renderQualityGateWorkflow(codingEngineContract());
    expect(CHECKOUT_ACTION_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(SETUP_NODE_ACTION_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(yaml).toContain(`actions/checkout@${CHECKOUT_ACTION_SHA}`);
    expect(yaml.match(/persist-credentials: false/gu)).toHaveLength(
      codingEngineContract().github.jobs.length,
    );
    expect(yaml).toContain(`actions/setup-node@${SETUP_NODE_ACTION_SHA}`);
    expect(yaml).toContain("node-version: '22'");
    expect(yaml).toContain("node-version: '24'");
    expect(yaml).not.toMatch(/uses: .*@(v|main|master)/);
    expect(yaml).toContain("run: '''npm'' ''ci'''");
    expect(yaml).toContain("run: '& ''npm'' ''ci'''");
    expect(yaml).toContain("run: '''npm'' ''test'' ''--'' ''--run'''");
    expect(yaml.match(/test \/ legacy-compatibility/gu)).toHaveLength(3);
    expect(yaml.match(/'''npm'' ''run'' ''test:legacy-compat'''/gu)).toHaveLength(2);
    expect(yaml).toContain("run: '& ''npm'' ''run'' ''test:legacy-compat'''");
    expect(
      codingEngineContract()
        .github.jobs.filter((job) => job.checkIds.includes('legacy-compatibility'))
        .map((job) => job.platform)
        .sort(),
    ).toEqual(['linux', 'macos', 'windows']);
  });

  it('does not install Node or coding-x in a Go project', () => {
    const yaml = renderQualityGateWorkflow(goContract());
    expect(yaml).toContain("run: '''go'' ''test'' ''./...'''");
    expect(yaml).toContain(`actions/setup-go@${SETUP_GO_ACTION_SHA}`);
    expect(yaml).not.toContain('setup-node');
    expect(yaml).not.toMatch(/(?:npx|node).*coding-x/);
    expect(yaml).not.toMatch(/\bnpm\b/);
    expect(yaml).not.toContain('macos-latest');
    expect(yaml).not.toContain('windows-2022');
  });
});

describe('renderPolicyGuardWorkflow', () => {
  it('uses only default-branch pull_request_target API data and never checks out PR content', () => {
    const yaml = renderPolicyGuardWorkflow(codingEngineContract());
    expect(yaml).toContain('pull_request_target:');
    expect(yaml).toContain('name: policy-guard-source');
    expect(yaml).toContain('pr = api(f"/repos/{repo}/pulls/{number}")');
    expect(yaml).toContain('/pulls/{number}/files');
    expect(yaml).toContain('quality-policy-approved');
    expect(yaml).toContain('Policy-Exception: #<issue>');
    expect(yaml).toContain('quality-policy-exception');
    expect(yaml).not.toContain('actions/checkout');
    expect(yaml).not.toContain('checks: write');
    expect(yaml).not.toContain('/check-runs');
    expect(yaml).not.toContain('Publish policy-guard');
    expect(yaml).not.toContain('pull_request.head');
    expect(yaml).not.toContain('pr = event["pull_request"]');
  });

  it('freezes current engineering standards and policy/release paths into the old-rule workflow', () => {
    const yaml = renderPolicyGuardWorkflow(codingEngineContract());
    for (const path of [
      '.coding-x/**',
      '.gitattributes',
      '.github/workflows/**',
      'AGENTS.md',
      'assets/workspace-safety/**',
      'build/vitest.windows-native.config.mjs',
      'docs/golden-principles.md',
      'package.json',
      'tsup.config.ts',
      'vitest.config.ts',
    ]) {
      expect(yaml).toContain(JSON.stringify(path));
    }
  });
});

describe('renderManagedGitHubFiles', () => {
  it('generates the workflow, required PR fields, and structured exception Issue forms', () => {
    const files = renderManagedGitHubFiles(codingEngineContract());
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        QUALITY_WORKFLOW_PATH,
        POLICY_WORKFLOW_PATH,
        PULL_REQUEST_TEMPLATE_PATH,
        POLICY_ISSUE_TEMPLATE_PATH,
      ]),
    );
    expect(files[PULL_REQUEST_TEMPLATE_PATH]).toContain('明确的非目标');
    expect(files[PULL_REQUEST_TEMPLATE_PATH]).toContain('Spec 与验收标准来源');
    expect(files[PULL_REQUEST_TEMPLATE_PATH]).toContain('验收标准只写改动应具备的行为');
    expect(files[PULL_REQUEST_TEMPLATE_PATH]).toContain('不要写成实现验收标准');
    expect(files[PULL_REQUEST_TEMPLATE_PATH]).toContain('Policy-Exception: 无');
    expect(files[POLICY_ISSUE_TEMPLATE_PATH]).toContain('label: 负责人');
    expect(files[POLICY_ISSUE_TEMPLATE_PATH]).toContain('label: 到期日');
    expect(files[POLICY_ISSUE_TEMPLATE_PATH]).toContain('label: 跟进事项');
  });

  it('contains no hosted review task or provider credential name', () => {
    const text = Object.values(renderManagedGitHubFiles(goContract())).join('\n');
    expect(text).not.toMatch(/OPENAI|ANTHROPIC|MODEL_API|ai_review/i);
  });
});

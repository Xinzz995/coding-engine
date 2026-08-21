import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  READY_ISSUE_TEMPLATE_PATH,
  renderManagedGitHubFiles,
  renderPolicyGuardWorkflow,
  renderQualityGateWorkflow,
} from './github-workflows.js';

const CLEAN_VALIDATION_POLICY_PATHS = [
  'src/engine/clean-validation-checkout.test.ts',
  'src/engine/clean-validation-checkout.ts',
  'src/engine/clean-validation-hard-links.test.ts',
  'src/engine/clean-validation-hard-links.ts',
  'src/engine/clean-validation-mounts.test.ts',
  'src/engine/clean-validation-mounts.ts',
  'src/engine/external-file-link-identity.test.ts',
  'src/engine/external-file-link-identity.ts',
  'src/workspace-safety/**',
] as const;

function policyPaths(contract: QualityContract): string[] {
  return contract.risk.pathRules
    .filter((rule) => rule.categories.includes('policy'))
    .flatMap((rule) => rule.paths);
}

function codingEngineContract(): QualityContract {
  const result = readQualityContract(process.cwd());
  if (result.status !== 'ready') throw new Error(`contract fixture unavailable: ${result.status}`);
  return result.contract;
}

function planScript(workflow: string): string {
  const marker = '      - name: Compute fail-closed change plan\n';
  const markerAt = workflow.indexOf(marker);
  const runAt = workflow.indexOf('        run: |\n', markerAt);
  const endAt = workflow.indexOf('\n  checks_', runAt);
  if (markerAt < 0 || runAt < 0 || endAt < 0) throw new Error('generated plan script missing');
  return workflow
    .slice(runAt + '        run: |\n'.length, endAt)
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function aggregateScript(workflow: string): string {
  const marker = '      - name: Verify every required job completed successfully\n';
  const markerAt = workflow.indexOf(marker);
  const runAt = workflow.indexOf('        run: |\n', markerAt);
  if (markerAt < 0 || runAt < 0) throw new Error('generated aggregate script missing');
  return workflow
    .slice(runAt + '        run: |\n'.length)
    .trimEnd()
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function runGeneratedPlan(
  contract: QualityContract,
  changedPath: string,
  eventName: 'pull_request' | 'schedule' = 'pull_request',
  renameFrom?: string,
  readyIssue?: {
    number: number;
    remoteCheckIds: string[];
    contractRemoteCheckIds?: string[];
    remoteMode?: 'scoped' | 'full';
    legacy?: boolean;
    criterion?: string;
  },
): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-workflow-plan-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'workflow plan test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'workflow-plan@example.invalid'], {
      cwd: root,
    });
    writeFileSync(join(root, 'base.txt'), 'base\n');
    if (renameFrom !== undefined) {
      mkdirSync(dirname(join(root, renameFrom)), { recursive: true });
      writeFileSync(join(root, renameFrom), 'renamed\n');
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    mkdirSync(dirname(join(root, changedPath)), { recursive: true });
    if (renameFrom === undefined) {
      writeFileSync(join(root, changedPath), 'changed\n');
      execFileSync('git', ['add', changedPath], { cwd: root });
    } else {
      execFileSync('git', ['mv', renameFrom, changedPath], { cwd: root });
    }
    if (readyIssue !== undefined) {
      const source = join(root, 'docs', 'prds', `prd-issue-${readyIssue.number}.md`);
      mkdirSync(dirname(source), { recursive: true });
      const executionContract = {
        schemaVersion: 1,
        storyAcceptance: {
          evidenceSource: 'validator',
          network: 'disabled',
          criteria: [readyIssue.criterion ?? 'fixture behavior'],
        },
        localChecks: {
          evidenceSource: 'engine',
          network: 'current-host',
          mode: 'scoped',
          checkIds: [],
        },
        remoteDelivery: {
          evidenceSource: 'github',
          network: 'github-actions',
          mode: readyIssue.remoteMode ?? 'scoped',
          checkIds: readyIssue.contractRemoteCheckIds ?? readyIssue.remoteCheckIds,
          ruleset: 'required',
        },
        runMetrics: {
          evidenceSource: 'engine-clock',
          metrics: ['ready-to-trusted', 'active', 'waiting', 'continuations'],
        },
      };
      const executionDigest = `sha256:${createHash('sha256')
        .update(
          JSON.stringify({
            domain: 'coding-x-ready-issue-execution-v1',
            contract: executionContract,
          }),
        )
        .digest('hex')}`;
      writeFileSync(
        source,
        readyIssue.legacy === true
          ? '# Legacy ready Issue source\n'
          : [
              '# Ready Issue source',
              '',
              `> Issue-Execution-Contract-Digest: ${executionDigest}`,
              `> Issue-Remote-Check-Mode: ${readyIssue.remoteMode ?? 'scoped'}`,
              `> Issue-Remote-Check-IDs: ${readyIssue.remoteCheckIds.join(',') || '-'}`,
              '',
              '#### Execution Contract',
              '',
              '```json',
              JSON.stringify(executionContract, null, 2),
              '```',
              '',
            ].join('\n'),
      );
      execFileSync('git', ['add', source], { cwd: root });
    }
    execFileSync('git', ['commit', '-q', '-m', 'change'], { cwd: root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const output = join(root, 'plan.out');
    const script = join(root, 'plan.sh');
    writeFileSync(script, planScript(renderQualityGateWorkflow(contract)), 'utf8');
    execFileSync('bash', [script], {
      cwd: root,
      env: {
        ...process.env,
        EVENT_NAME: eventName,
        PR_BASE: eventName === 'pull_request' ? base : '',
        PR_HEAD: eventName === 'pull_request' ? head : '',
        PR_HEAD_REF:
          eventName === 'pull_request' && readyIssue !== undefined
            ? `codex/issue-${readyIssue.number}`
            : 'feature/fixture',
        GITHUB_OUTPUT: output,
      },
      stdio: 'pipe',
    });
    return new Map(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function outputForCheck(
  contract: QualityContract,
  output: Map<string, string>,
  checkId: string,
): string | undefined {
  const checks = (['test', 'build', 'static', 'security'] as const).flatMap((category) => {
    const policy = contract.checks[category];
    return 'checks' in policy ? policy.checks : [];
  });
  const index = checks.findIndex((check) => check.id === checkId);
  return index < 0 ? undefined : output.get(`check_${index + 1}`);
}

function pinnedRunnerContract(): QualityContract {
  const contract = structuredClone(codingEngineContract());
  contract.codingXVersion = '0.35.0';
  return contract;
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
        'src/review/**',
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
    expect(policyPaths(codingEngineContract())).toEqual(
      expect.arrayContaining([
        'src/workspace-safety/**',
        'src/review/**',
        'src/status/runner-version-observation.ts',
        'tsconfig.json',
      ]),
    );
  });

  it('protects the clean-validation trust closure with old rules', () => {
    expect(policyPaths(codingEngineContract())).toEqual(
      expect.arrayContaining([...CLEAN_VALIDATION_POLICY_PATHS]),
    );
  });

  it('protects the complete managed-process safety subsystem instead of a hand-maintained import list', () => {
    expect(policyPaths(codingEngineContract())).toContain('src/workspace-safety/**');
  });
});

describe('renderQualityGateWorkflow', () => {
  it('creates a fail-closed change plan, scoped native jobs, and scheduled full drift checks', () => {
    const yaml = renderQualityGateWorkflow(codingEngineContract());
    expect(yaml).toContain('on:\n  pull_request:');
    expect(yaml).not.toContain('\n  push:');
    expect(yaml).not.toMatch(/paths(?:-ignore)?:/);
    expect(yaml).toContain("schedule:\n    - cron: '23 4 * * 1'");
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).toContain('plan required checks');
    expect(yaml).toContain('Compute fail-closed change plan');
    expect(yaml).toContain("if: ${{ needs.plan.outputs.job_1 == 'true' }}");
    expect(yaml).toContain("if: ${{ needs.plan.outputs.check_1 == 'true' }}");
    expect(yaml).toContain('checks_ubuntu-node-22:');
    expect(yaml).toContain('checks_ubuntu-node-24:');
    expect(yaml).toContain('checks_macos-node-22:');
    expect(yaml).toContain('checks_macos-node-24:');
    expect(yaml).toContain('checks_windows-node-22:');
    expect(yaml).toContain('checks_windows-node-24:');
    expect(yaml).toContain('checks_windows-native-standard-user:');
    expect(yaml.match(/runs-on: windows-2022/gu)).toHaveLength(3);
    expect(yaml.match(/runs-on: ubuntu-24\.04/gu)).toHaveLength(4);
    expect(yaml.match(/runs-on: macos-26/gu)).toHaveLength(2);
    expect(yaml).not.toContain('ubuntu-latest');
    expect(yaml).not.toContain('macos-latest');
    expect(yaml).not.toContain('windows-latest');
    expect(yaml).toContain('build / windows-supervisor-reproducibility');
    expect(yaml).toContain(
      "& ''pwsh'' ''-NoLogo'' ''-NoProfile'' ''-NonInteractive'' ''-ExecutionPolicy'' ''Bypass'' ''-File'' ''native/windows-supervisor/build.ps1'' ''-Mode'' ''Verify'' ''-CommittedExecutable'' ''assets/workspace-safety/coding-x-windows-supervisor.exe''",
    );
    expect(yaml).toContain('build / windows-path-inspector-reproducibility');
    expect(yaml).toContain(
      "& ''pwsh'' ''-NoLogo'' ''-NoProfile'' ''-NonInteractive'' ''-ExecutionPolicy'' ''Bypass'' ''-File'' ''native/windows-supervisor/build.ps1'' ''-Mode'' ''Verify'' ''-Target'' ''PathInspector'' ''-CommittedExecutable'' ''assets/workspace-safety/coding-x-windows-path-inspector.exe''",
    );
    expect(yaml).toContain('test / windows-native-proof');
    expect(yaml).toContain("& ''npm'' ''run'' ''test:windows-native-proof''");
    expect(yaml.indexOf('build / windows-supervisor-reproducibility')).toBeLessThan(
      yaml.indexOf('build / windows-path-inspector-reproducibility'),
    );
    expect(yaml.indexOf('build / windows-path-inspector-reproducibility')).toBeLessThan(
      yaml.indexOf('test / windows-native-proof'),
    );
    expect(yaml).toContain('name: quality-gate');
    expect(yaml).toContain('if: ${{ always() }}');
    expect(yaml).toContain(
      'needs: [plan, checks_ubuntu-node-22, checks_ubuntu-node-24, checks_macos-node-22, checks_macos-node-24, checks_windows-node-22, checks_windows-node-24, checks_windows-native-standard-user]',
    );
    expect(yaml).toContain('job result does not match the fail-closed plan');
    expect(yaml).toContain('for suffix in 1 2 3 4 5 6 7; do');
    expect(yaml).not.toContain('${!EXPECTED_@}');
    expect(yaml).toContain('github.event_name }}-${{ github.event.pull_request.number || github.ref');
    expect(yaml).toContain('PR_HEAD: ${{ github.event.pull_request.head.sha }}');
    expect(yaml).toContain('PR_HEAD_REF: ${{ github.event.pull_request.head.ref }}');
  });

  it('runs only repository health for an ordinary docs change', () => {
    const contract = codingEngineContract();
    const docs = runGeneratedPlan(contract, 'docs/ordinary-note.md');
    expect(docs.get('full')).toBe('false');
    expect(outputForCheck(contract, docs, 'repository-health')).toBe('true');
    expect(outputForCheck(contract, docs, 'tests')).toBe('false');
    expect(outputForCheck(contract, docs, 'build')).toBe('false');
    expect(docs.get('job_1')).toBe('true');
    for (let index = 2; index <= contract.github.jobs.length; index += 1) {
      expect(docs.get(`job_${index}`)).toBe('false');
    }
  });

  it('forces ready Issue remote check ids into the PR plan and rejects legacy sources', () => {
    const contract = codingEngineContract();
    const required = runGeneratedPlan(
      contract,
      'docs/ordinary-note.md',
      'pull_request',
      undefined,
      { number: 42, remoteCheckIds: ['dependency-audit'] },
    );
    expect(required.get('full')).toBe('false');
    expect(outputForCheck(contract, required, 'dependency-audit')).toBe('true');
    expect(outputForCheck(contract, required, 'tests')).toBe('false');

    expect(() =>
      runGeneratedPlan(contract, 'docs/rare-unicode.md', 'pull_request', undefined, {
        number: 44,
        remoteCheckIds: [],
        criterion: '\u001c仍是有效文字',
      }),
    ).not.toThrow();

    expect(() =>
      runGeneratedPlan(contract, 'docs/legacy-note.md', 'pull_request', undefined, {
        number: 43,
        remoteCheckIds: [],
        legacy: true,
      }),
    ).toThrow();
  });

  it('fails the remote plan for unknown check ids or an unsupported full request', () => {
    const contract = codingEngineContract();
    expect(() =>
      runGeneratedPlan(contract, 'docs/unknown-check.md', 'pull_request', undefined, {
        number: 42,
        remoteCheckIds: ['not-declared'],
      }),
    ).toThrow();
    expect(() =>
      runGeneratedPlan(contract, 'docs/full-remote.md', 'pull_request', undefined, {
        number: 42,
        remoteCheckIds: [],
        remoteMode: 'full',
      }),
    ).toThrow();
    expect(() =>
      runGeneratedPlan(contract, 'docs/header-contract-mismatch.md', 'pull_request', undefined, {
        number: 42,
        remoteCheckIds: ['dependency-audit'],
        contractRemoteCheckIds: [],
      }),
    ).toThrow();
  });

  it('runs the source checks and skips the native Windows job for a scoped source change', () => {
    const contract = codingEngineContract();
    const source = runGeneratedPlan(contract, 'src/change-scoped-fixture.ts');
    expect(source.get('full')).toBe('false');
    expect(outputForCheck(contract, source, 'tests')).toBe('true');
    expect(outputForCheck(contract, source, 'build')).toBe('true');
    expect(outputForCheck(contract, source, 'typecheck')).toBe('true');
    expect(source.get('job_1')).toBe('true');
    expect(source.get('job_6')).toBe('true');
    expect(source.get('job_7')).toBe('false');
  });

  it('selects checks from both sides of a rename', () => {
    const contract = codingEngineContract();
    const renamed = runGeneratedPlan(
      contract,
      'docs/renamed-from-source.md',
      'pull_request',
      'src/original.ts',
    );
    expect(renamed.get('full')).toBe('false');
    expect(outputForCheck(contract, renamed, 'tests')).toBe('true');
    expect(outputForCheck(contract, renamed, 'repository-health')).toBe('true');
  });

  it('fails closed to the full matrix for an unknown path', () => {
    const contract = codingEngineContract();
    const unknown = runGeneratedPlan(contract, 'UNCLASSIFIED');
    expect(unknown.get('full')).toBe('true');
    for (let index = 1; index <= contract.github.jobs.length; index += 1) {
      expect(unknown.get(`job_${index}`)).toBe('true');
    }
  });

  it('runs the full matrix for a scheduled check even when the diff is docs-only', () => {
    const contract = codingEngineContract();
    const scheduled = runGeneratedPlan(contract, 'docs/scheduled-note.md', 'schedule');
    expect(scheduled.get('full')).toBe('true');
    expect(outputForCheck(contract, scheduled, 'tests')).toBe('true');
    expect(outputForCheck(contract, scheduled, 'windows-native-proof')).toBe('true');
  });

  it('accepts only job results that exactly match the fail-closed plan', () => {
    const contract = codingEngineContract();
    const script = aggregateScript(renderQualityGateWorkflow(contract));
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PLAN_RESULT: 'success',
      EXPECTED_VERSION: '0.37.0',
      RESULT_NOISE: 'failure',
    };
    contract.github.jobs.forEach((_job, index) => {
      environment[`EXPECTED_${index + 1}`] = 'false';
      environment[`RESULT_${index + 1}`] = 'skipped';
    });
    expect(() =>
      execFileSync('bash', ['-c', script], { env: environment, stdio: 'pipe' }),
    ).not.toThrow();
    expect(() =>
      execFileSync('bash', ['-c', script], {
        env: { ...environment, EXPECTED_1: 'true', RESULT_1: 'skipped' },
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(() =>
      execFileSync('bash', ['-c', script], {
        env: { ...environment, PLAN_RESULT: 'failure' },
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(() =>
      execFileSync('bash', ['-c', script], {
        env: { ...environment, EXPECTED_1: '' },
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('pins hosted runner labels only for contracts created by 0.35.0 or later', () => {
    const contract = pinnedRunnerContract();
    const quality = renderQualityGateWorkflow(contract);
    const policy = renderPolicyGuardWorkflow(contract);
    expect(quality.match(/runs-on: ubuntu-24\.04/gu)).toHaveLength(4);
    expect(quality.match(/runs-on: macos-26/gu)).toHaveLength(2);
    expect(policy).toContain('runs-on: ubuntu-24.04');
    expect(`${quality}\n${policy}`).not.toMatch(/runs-on:\s*(?:ubuntu|macos|windows)-latest\b/u);

    const legacyContract = structuredClone(codingEngineContract());
    legacyContract.codingXVersion = '0.34.1';
    const legacyPolicy = renderPolicyGuardWorkflow(legacyContract);
    expect(legacyPolicy).toContain('runs-on: ubuntu-latest');
  });

  it('pins checkout by full commit and serializes structured commands for each native shell', () => {
    const yaml = renderQualityGateWorkflow(codingEngineContract());
    expect(CHECKOUT_ACTION_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(SETUP_NODE_ACTION_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(yaml).toContain(`actions/checkout@${CHECKOUT_ACTION_SHA}`);
    expect(yaml.match(/persist-credentials: false/gu)).toHaveLength(
      codingEngineContract().github.jobs.length + 1,
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
    expect(yaml).not.toContain('macos-26');
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
      'build/candidate-install-smoke.mjs',
      'build/release-evidence.mjs',
      'build/sync-plugin-versions.mjs',
      'build/vitest.windows-native.config.mjs',
      'docs/golden-principles.md',
      'native/windows-supervisor/**',
      'package.json',
      ...CLEAN_VALIDATION_POLICY_PATHS,
      'src/review/**',
      'src/status/runner-version-observation.ts',
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
        READY_ISSUE_TEMPLATE_PATH,
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
    expect(files[READY_ISSUE_TEMPLATE_PATH]).toContain('label: 本次目标');
    expect(files[READY_ISSUE_TEMPLATE_PATH]).toContain('当前可信入口只支持 codex');
    expect(files[READY_ISSUE_TEMPLATE_PATH]).toContain('label: 执行合同');
    expect(files[READY_ISSUE_TEMPLATE_PATH]).toContain('"storyAcceptance"');
    expect(files[READY_ISSUE_TEMPLATE_PATH]).toContain('"localChecks"');
    expect(files[READY_ISSUE_TEMPLATE_PATH]).toContain('"remoteDelivery"');
    expect(files[READY_ISSUE_TEMPLATE_PATH]).toContain('"runMetrics"');
    expect(files[READY_ISSUE_TEMPLATE_PATH]).not.toContain("labels:\n  - 'ready-for-agent'");
  });

  it('contains no hosted review task or provider credential name', () => {
    const text = Object.values(renderManagedGitHubFiles(goContract())).join('\n');
    expect(text).not.toMatch(/OPENAI|ANTHROPIC|MODEL_API|ai_review/i);
  });
});

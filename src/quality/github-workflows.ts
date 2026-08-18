import { basename } from 'node:path';
import {
  POLICY_GUARD_REQUIRED_CHECK,
  type QualityCheck,
  type QualityCheckCategory,
  type QualityCommand,
  type QualityContract,
  type QualityToolchain,
  type QualityPlatform,
} from './contract.js';

export const QUALITY_WORKFLOW_PATH = '.github/workflows/quality-gate.yml';
export const POLICY_WORKFLOW_PATH = '.github/workflows/policy-guard.yml';
export const PULL_REQUEST_TEMPLATE_PATH = '.github/PULL_REQUEST_TEMPLATE.md';
export const P1_ISSUE_TEMPLATE_PATH = '.github/ISSUE_TEMPLATE/quality-p1.yml';
export const POLICY_ISSUE_TEMPLATE_PATH = '.github/ISSUE_TEMPLATE/quality-policy.yml';
export const READY_ISSUE_TEMPLATE_PATH = '.github/ISSUE_TEMPLATE/ready-for-agent.yml';

/** 官方 setup Actions v7 的完整提交标识；升级必须通过政策 PR。 */
export const CHECKOUT_ACTION_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
export const SETUP_NODE_ACTION_SHA = '820762786026740c76f36085b0efc47a31fe5020';
export const SETUP_PYTHON_ACTION_SHA = '5fda3b95a4ea91299a34e894583c3862153e4b97';
export const SETUP_GO_ACTION_SHA = 'b7ad1dad31e06c5925ef5d2fc7ad053ef454303e';

const CATEGORIES: QualityCheckCategory[] = ['test', 'build', 'static', 'security'];
export const FULL_QUALITY_CRON = '23 4 * * 1';
const PINNED_RUNNER_VERSION = [0, 35, 0] as const;
const LEGACY_CONTROL_RUNNER = 'ubuntu-latest';
const LEGACY_RUNNER: Record<QualityPlatform, string> = {
  linux: LEGACY_CONTROL_RUNNER,
  macos: 'macos-latest',
  windows: 'windows-2022',
};
const PINNED_CONTROL_RUNNER = 'ubuntu-24.04';
const PINNED_RUNNER: Record<QualityPlatform, string> = {
  linux: PINNED_CONTROL_RUNNER,
  macos: 'macos-26',
  // Windows Server 2022 is the oldest hosted image in the v1 support contract.
  // Keep this mapping internal: adding a runner label to schema v1 would make
  // the already-published strict 0.33.3 parser reject the repository contract.
  windows: 'windows-2022',
};

function usesPinnedRunnerLabels(contract: QualityContract): boolean {
  const actual = contract.codingXVersion.split('.').map(Number);
  for (const [index, expected] of PINNED_RUNNER_VERSION.entries()) {
    if (actual[index] === expected) continue;
    return actual[index] > expected;
  }
  return true;
}

function runnerFor(contract: QualityContract, platform: QualityPlatform): string {
  return (usesPinnedRunnerLabels(contract) ? PINNED_RUNNER : LEGACY_RUNNER)[platform];
}

function controlRunnerFor(contract: QualityContract): string {
  return usesPinnedRunnerLabels(contract) ? PINNED_CONTROL_RUNNER : LEGACY_CONTROL_RUNNER;
}

function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function posixArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powershellArg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function explicitShellArgs(shell: string, script: string): string[] {
  const name = basename(shell).toLowerCase();
  if (name === 'cmd' || name === 'cmd.exe') return ['/d', '/s', '/c', script];
  if (
    name === 'powershell' ||
    name === 'powershell.exe' ||
    name === 'pwsh' ||
    name === 'pwsh.exe'
  ) {
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
  }
  return ['-c', script];
}

function commandLine(command: QualityCommand, platform: QualityPlatform): string {
  const executable = 'executable' in command ? command.executable : command.shell;
  const args =
    'executable' in command ? command.args : explicitShellArgs(command.shell, command.script);
  if (platform === 'windows') {
    return `& ${[executable, ...args].map(powershellArg).join(' ')}`;
  }
  return [executable, ...args].map(posixArg).join(' ');
}

function allChecks(
  contract: QualityContract,
): Array<QualityCheck & { category: QualityCheckCategory }> {
  const checks: Array<QualityCheck & { category: QualityCheckCategory }> = [];
  for (const category of CATEGORIES) {
    const group = contract.checks[category];
    if ('checks' in group) {
      checks.push(...group.checks.map((check) => ({ ...check, category })));
    }
  }
  return checks;
}

function commandStep(
  name: string,
  command: QualityCommand,
  platform: QualityPlatform,
  condition?: string,
): string[] {
  return [
    `      - name: ${yamlString(name)}`,
    ...(condition === undefined ? [] : [`        if: ${condition}`]),
    `        working-directory: ${yamlString(command.cwd)}`,
    `        timeout-minutes: ${Math.max(1, Math.ceil(command.timeoutMs / 60_000))}`,
    `        shell: ${platform === 'windows' ? 'pwsh' : 'bash'}`,
    `        run: ${yamlString(commandLine(command, platform))}`,
  ];
}

function toolchainStep(toolchain: QualityToolchain): string[] {
  const action =
    toolchain.kind === 'node'
      ? `actions/setup-node@${SETUP_NODE_ACTION_SHA}`
      : toolchain.kind === 'go'
        ? `actions/setup-go@${SETUP_GO_ACTION_SHA}`
        : `actions/setup-python@${SETUP_PYTHON_ACTION_SHA}`;
  const versionKey =
    toolchain.kind === 'node'
      ? 'node-version'
      : toolchain.kind === 'go'
        ? 'go-version'
        : 'python-version';
  const lines = [
    `      - name: ${yamlString(`toolchain / ${toolchain.kind} ${toolchain.version}`)}`,
    `        uses: ${action}`,
    '        with:',
    `          ${versionKey}: ${yamlString(toolchain.version)}`,
  ];
  if (toolchain.cache !== undefined) {
    lines.push(
      `          cache: ${typeof toolchain.cache === 'boolean' ? String(toolchain.cache) : yamlString(toolchain.cache)}`,
    );
  }
  if (toolchain.cacheDependencyPath !== undefined) {
    lines.push(`          cache-dependency-path: ${yamlString(toolchain.cacheDependencyPath)}`);
  }
  return lines;
}

/** 从同一质量契约生成项目原生 CI；不安装或运行 coding-x。 */
export function renderQualityGateWorkflow(contract: QualityContract): string {
  const declared = allChecks(contract);
  const checksById = new Map(declared.map((check) => [check.id, check]));
  const checkIndex = new Map(declared.map((check, index) => [check.id, index + 1]));
  if (contract.github.jobs.length === 0) throw new Error('质量契约没有 GitHub jobs');

  const lines = [
    'name: Quality Gate',
    '',
    '# Generated from .coding-x/quality.json. Change the contract, then regenerate.',
    'on:',
    '  pull_request:',
    '  schedule:',
    `    - cron: ${yamlString(FULL_QUALITY_CRON)}`,
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    '  group: quality-gate-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  plan:',
    '    name: plan required checks',
    `    runs-on: ${controlRunnerFor(contract)}`,
    '    timeout-minutes: 5',
    '    outputs:',
    ...declared.map(
      (_check, index) =>
        `      check_${index + 1}: ` + '${{ steps.plan.outputs.check_' + (index + 1) + ' }}',
    ),
    ...contract.github.jobs.map(
      (_job, index) =>
        `      job_${index + 1}: ` + '${{ steps.plan.outputs.job_' + (index + 1) + ' }}',
    ),
    '      full: ${{ steps.plan.outputs.full }}',
    '    steps:',
    `      - uses: actions/checkout@${CHECKOUT_ACTION_SHA}`,
    '        with:',
    '          fetch-depth: 0',
    '          persist-credentials: false',
    '      - name: Compute fail-closed change plan',
    '        id: plan',
    '        shell: bash',
    '        env:',
    '          EVENT_NAME: ${{ github.event_name }}',
    '          PR_BASE: ${{ github.event.pull_request.base.sha }}',
    '          PR_HEAD: ${{ github.event.pull_request.head.sha }}',
    '        run: |',
    '          set -euo pipefail',
    '          full=0',
    '          diff_base=',
    '          diff_head=',
    '          case "$EVENT_NAME" in',
    '            schedule|workflow_dispatch)',
    '              full=1',
    '              ;;',
    '            pull_request)',
    '              if git cat-file -e "${PR_BASE}^{commit}" 2>/dev/null && git cat-file -e "${PR_HEAD}^{commit}" 2>/dev/null; then',
    '                if diff_base=$(git merge-base "$PR_BASE" "$PR_HEAD"); then',
    '                  diff_head="$PR_HEAD"',
    '                else',
    '                  full=1',
    '                fi',
    '              else',
    '                full=1',
    '              fi',
    '              ;;',
    '            *)',
    '              full=1',
    '              ;;',
    '          esac',
    '          if [ "$full" -eq 0 ]; then',
    '            if git diff --quiet --no-renames "$diff_base" "$diff_head" --; then',
    '              full=1',
    '            else',
    '              status=$?',
    '              if [ "$status" -ne 1 ]; then',
    '                echo "::warning::Git diff could not be classified; falling back to full"',
    '                full=1',
    '              fi',
    '            fi',
    '          fi',
  ];

  const pathPatterns = [...new Set(declared.flatMap((check) => check.paths ?? []))];
  if (pathPatterns.length === 0) {
    lines.push('          if [ "$full" -eq 0 ]; then full=1; fi');
  } else {
    const exclusions = pathPatterns.map((path) => posixArg(`:(exclude)${path}`)).join(' ');
    lines.push(
      '          if [ "$full" -eq 0 ]; then',
      `            if git diff --quiet --no-renames "$diff_base" "$diff_head" -- . ${exclusions}; then`,
      '              :',
      '            else',
      '              status=$?',
      '              full=1',
      '              if [ "$status" -ne 1 ]; then',
      '                echo "::warning::Git path coverage could not be classified; falling back to full"',
      '              fi',
      '            fi',
      '          fi',
    );
  }
  declared.forEach((check, index) => {
    const variable = `check_${index + 1}`;
    if (check.paths === undefined) {
      lines.push(`          ${variable}=true`);
      return;
    }
    lines.push(
      `          if [ "$full" -eq 1 ]; then`,
      `            ${variable}=true`,
      `          elif git diff --quiet --no-renames "$diff_base" "$diff_head" -- ${check.paths.map(posixArg).join(' ')}; then`,
      `            ${variable}=false`,
      '          else',
      '            status=$?',
      `            ${variable}=true`,
      '            if [ "$status" -ne 1 ]; then',
      '              echo "::warning::Git check scope could not be classified; falling back to full"',
      '              full=1',
      '            fi',
      '          fi',
    );
  });
  contract.github.jobs.forEach((job, index) => {
    const variables = job.checkIds.map((id) => `\$check_${checkIndex.get(id)}`).join('" = true ] || [ "');
    lines.push(`          job_${index + 1}=false`);
    if (variables !== '') {
      lines.push(
        `          if [ "${variables}" = true ]; then job_${index + 1}=true; fi`,
      );
    }
  });
  lines.push(
    '          if [ "$full" -eq 1 ]; then full_value=true; else full_value=false; fi',
    '          echo "full=$full_value" >> "$GITHUB_OUTPUT"',
    ...declared.map(
      (_check, index) =>
        `          echo "check_${index + 1}=\$check_${index + 1}" >> "$GITHUB_OUTPUT"`,
    ),
    ...contract.github.jobs.map(
      (_job, index) => `          echo "job_${index + 1}=\$job_${index + 1}" >> "$GITHUB_OUTPUT"`,
    ),
  );

  for (const [jobIndex, job] of contract.github.jobs.entries()) {
    const jobKey = `checks_${job.id}`;
    lines.push(
      `  ${jobKey}:`,
      `    name: checks / ${job.id}`,
      '    needs: plan',
      `    if: \${{ needs.plan.outputs.job_${jobIndex + 1} == 'true' }}`,
      `    runs-on: ${runnerFor(contract, job.platform)}`,
      '    timeout-minutes: 60',
      '    steps:',
      `      - uses: actions/checkout@${CHECKOUT_ACTION_SHA}`,
      '        with:',
      '          fetch-depth: 0',
      '          persist-credentials: false',
    );
    for (const toolchain of job.toolchains) lines.push(...toolchainStep(toolchain));
    job.setup.forEach((command, index) => {
      lines.push(...commandStep(`setup / ${index + 1}`, command, job.platform));
    });
    for (const checkId of job.checkIds) {
      const check = checksById.get(checkId);
      if (!check) throw new Error(`GitHub job ${job.id} 引用未知检查 ${checkId}`);
      const index = checkIndex.get(checkId);
      if (index === undefined) throw new Error(`GitHub job ${job.id} 缺少检查索引 ${checkId}`);
      lines.push(
        ...commandStep(
          `${check.category} / ${check.id}`,
          check.command,
          job.platform,
          `\${{ needs.plan.outputs.check_${index} == 'true' }}`,
        ),
      );
    }
  }

  const needs = ['plan', ...contract.github.jobs.map((job) => `checks_${job.id}`)];
  lines.push(
    '  quality-gate:',
    '    name: quality-gate',
    '    if: ${{ always() }}',
    `    needs: [${needs.join(', ')}]`,
    `    runs-on: ${controlRunnerFor(contract)}`,
    '    timeout-minutes: 5',
    '    permissions: {}',
    '    steps:',
    '      - name: Verify every required job completed successfully',
    '        shell: bash',
    '        env:',
    '          PLAN_RESULT: ${{ needs.plan.result }}',
  );
  contract.github.jobs.forEach((job, index) => {
    lines.push(`          RESULT_${index + 1}: ` + '${{ needs.checks_' + job.id + '.result }}');
    lines.push(`          EXPECTED_${index + 1}: ` + '${{ needs.plan.outputs.job_' + (index + 1) + ' }}');
  });
  lines.push(
    '        run: |',
    '          failed=0',
    '          if [ "$PLAN_RESULT" != "success" ]; then',
    '            echo "::error::plan=${PLAN_RESULT}; change plan must complete successfully"',
    '            failed=1',
    '          fi',
    '          for expected in "${!EXPECTED_@}"; do',
    '            suffix="${expected#EXPECTED_}"',
    '            result="RESULT_${suffix}"',
    '            expected_value="${!expected}"',
    '            result_value="${!result}"',
    '            if [ "$expected_value" != "true" ] && [ "$expected_value" != "false" ]; then',
    '              echo "::error::${expected}=${expected_value}; plan output must be true or false"',
    '              failed=1',
    '            elif { [ "$expected_value" = "true" ] && [ "$result_value" != "success" ]; } ||',
    '                 { [ "$expected_value" = "false" ] && [ "$result_value" != "skipped" ]; }; then',
    '              echo "::error::${result}=${result_value}, ${expected}=${expected_value}; job result does not match the fail-closed plan"',
    '              failed=1',
    '            fi',
    '          done',
    '          exit "$failed"',
  );
  return `${lines.join('\n')}\n`;
}

function policyPaths(contract: QualityContract): string[] {
  const paths = new Set<string>([
    '.coding-x/**',
    '.github/workflows/**',
    ...contract.sources.engineeringStandards,
  ]);
  for (const rule of contract.risk.pathRules) {
    if (rule.categories.includes('policy') || rule.categories.includes('release')) {
      rule.paths.forEach((path) => paths.add(path));
    }
  }
  return [...paths].sort();
}

/**
 * 可信政策检查只存在于默认分支的 pull_request_target 工作流中。它不 checkout，
 * 仅通过 API 把 PR 文件名、标签和关联 Issue 当数据读取。
 */
export function renderPolicyGuardWorkflow(contract: QualityContract): string {
  const protectedJson = JSON.stringify(policyPaths(contract));
  const maxDays = contract.exceptions.policy.maxDays;
  return `name: Policy Guard

# Generated from the default branch quality contract. Change the contract, then regenerate.
# Runs from the default branch. Never check out or execute pull request content here.
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled, edited]

permissions:
  contents: read
  pull-requests: read
  issues: read

jobs:
  policy-guard:
    name: ${POLICY_GUARD_REQUIRED_CHECK}
    runs-on: ${controlRunnerFor(contract)}
    timeout-minutes: 5
    steps:
      - name: Check protected policy changes through the GitHub API
        id: evaluate
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          python3 - <<'PY'
          import datetime as dt
          import fnmatch
          import json
          import os
          import re
          import urllib.parse
          import urllib.request

          protected = ${protectedJson}
          max_days = ${maxDays}
          event = json.load(open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8"))
          repo = event["repository"]["full_name"]
          number = event["number"]
          token = os.environ["GH_TOKEN"]

          def api(path):
              request = urllib.request.Request(
                  "https://api.github.com" + path,
                  headers={
                      "Accept": "application/vnd.github+json",
                      "Authorization": "Bearer " + token,
                      "X-GitHub-Api-Version": "2022-11-28",
                      "User-Agent": "coding-x-policy-guard",
                  },
              )
              with urllib.request.urlopen(request, timeout=30) as response:
                  return json.load(response)

          # opened/labeled can race: the event payload is an immutable snapshot, so policy
          # decisions must read the current labels and body from GitHub.
          pr = api(f"/repos/{repo}/pulls/{number}")
          files = []
          page = 1
          while True:
              batch = api(f"/repos/{repo}/pulls/{number}/files?per_page=100&page={page}")
              files.extend(item["filename"] for item in batch)
              if len(batch) < 100:
                  break
              page += 1

          changed = sorted({
              path for path in files
              if any(fnmatch.fnmatchcase(path, pattern) for pattern in protected)
          })
          if not changed:
              print("No protected policy paths changed")
              raise SystemExit(0)

          labels = {item["name"] for item in pr.get("labels", [])}
          if "quality-policy-approved" not in labels:
              raise SystemExit(
                  "Protected policy changed without owner label quality-policy-approved: "
                  + ", ".join(changed)
              )

          body = pr.get("body") or ""
          match = re.search(r"(?im)^Policy-Exception:\\s*#(\\d+)\\s*$", body)
          if not match:
              raise SystemExit("PR body must contain: Policy-Exception: #<issue>")
          issue_number = int(match.group(1))
          issue = api(f"/repos/{repo}/issues/{issue_number}")
          if "pull_request" in issue or issue.get("state") != "open":
              raise SystemExit("Policy exception must reference an open Issue")
          issue_labels = {item["name"] for item in issue.get("labels", [])}
          if "quality-policy-exception" not in issue_labels:
              raise SystemExit("Referenced Issue is not a quality-policy-exception")

          issue_body = issue.get("body") or ""
          def section(name):
              found = re.search(
                  rf"(?ms)^### {re.escape(name)}\\s*\\n(.*?)(?=^### |\\Z)", issue_body
              )
              value = found.group(1).strip() if found else ""
              return "" if value in {"", "_No response_"} else value

          owner = section("负责人")
          reason = section("原因")
          expires_raw = section("到期日")
          follow_up = section("跟进事项")
          if not all([owner, reason, expires_raw, follow_up]):
              raise SystemExit("Policy exception Issue is missing owner, reason, expiry, or follow-up")
          try:
              expires = dt.date.fromisoformat(expires_raw)
          except ValueError:
              raise SystemExit("Policy exception expiry must be YYYY-MM-DD")
          today = dt.datetime.now(dt.timezone.utc).date()
          if expires < today or expires > today + dt.timedelta(days=max_days):
              raise SystemExit(f"Policy exception expiry must be within {max_days} days")

          print("Approved protected policy change:", ", ".join(changed))
          print(f"Exception issue #{issue_number}; owner={owner}; expires={expires}")
          PY
`;
}

export function renderPullRequestTemplate(): string {
  return `<!-- Generated from .coding-x/quality.json. Change the contract, then regenerate. -->

## 本次目标

<!-- 本次改动必须完成的行为。 -->

## 明确的非目标

<!-- 本次刻意不处理的内容。 -->

## Spec 与验收标准来源

<!-- 仓库相对路径、Issue 或已确认的 PR 说明。验收标准只写改动应具备的行为。 -->

## 验证方式

<!-- 可重复执行的命令和人工验证。把“本轮检查、Review、CI 是否完成”写在这里，不要写成实现验收标准。 -->

## 风险说明

<!-- 影响范围、回退方式、数据或兼容性风险。 -->

## 深度评审

- [ ] 我主动要求深度结构评审

## 延期与政策例外

P1-Deferral: 无
Policy-Exception: 无
`;
}

function issueTemplate(
  name: string,
  description: string,
  titlePrefix: string,
  label: string,
  maxDays: number,
): string {
  return `# Generated from .coding-x/quality.json. Change the contract, then regenerate.
name: ${yamlString(name)}
description: ${yamlString(description)}
title: ${yamlString(`${titlePrefix} `)}
labels:
  - ${yamlString(label)}
body:
  - type: input
    id: owner
    attributes:
      label: 负责人
      description: 对后续处理负责的 GitHub 用户名或团队
    validations:
      required: true
  - type: textarea
    id: reason
    attributes:
      label: 原因
      description: 为什么现在不能按正常规则完成
    validations:
      required: true
  - type: input
    id: expiry
    attributes:
      label: 到期日
      description: YYYY-MM-DD，最长 ${maxDays} 天
      placeholder: YYYY-MM-DD
    validations:
      required: true
  - type: textarea
    id: follow-up
    attributes:
      label: 跟进事项
      description: 明确的修复或恢复正常规则事项
    validations:
      required: true
`;
}

function readyIssueTemplate(): string {
  return `# Generated from .coding-x/quality.json. Change the contract, then regenerate.
name: 'Agent 执行任务'
description: '建立一个可由 coding-x 显式启动的单 Issue、单分支、单 PR 任务'
title: ''
body:
  - type: markdown
    attributes:
      value: '填写并人工确认后再添加 ready-for-agent 标签；创建 Issue 本身不会启动运行。'
  - type: textarea
    id: goal
    attributes:
      label: 本次目标
      description: 本次改动必须完成的行为
    validations:
      required: true
  - type: textarea
    id: non-goals
    attributes:
      label: 明确的非目标
      description: 本次刻意不处理的内容
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: 验收标准
      description: 每行一个可判定条目，使用 Markdown 列表
      placeholder: '- 第一个可判定结果'
    validations:
      required: true
  - type: textarea
    id: risk
    attributes:
      label: 风险说明
      description: 影响范围、回退方式、数据或兼容性风险
    validations:
      required: true
`;
}

export function renderManagedGitHubFiles(contract: QualityContract): Record<string, string> {
  return {
    [QUALITY_WORKFLOW_PATH]: renderQualityGateWorkflow(contract),
    [POLICY_WORKFLOW_PATH]: renderPolicyGuardWorkflow(contract),
    [PULL_REQUEST_TEMPLATE_PATH]: renderPullRequestTemplate(),
    [P1_ISSUE_TEMPLATE_PATH]: issueTemplate(
      'P1 延期',
      '登记一次有责任人和期限的 P1 延期',
      '[P1 延期]',
      'quality-p1-deferral',
      contract.exceptions.p1.maxDays,
    ),
    [POLICY_ISSUE_TEMPLATE_PATH]: issueTemplate(
      '质量政策例外',
      '登记一次有期限的质量政策变更例外',
      '[政策例外]',
      'quality-policy-exception',
      contract.exceptions.policy.maxDays,
    ),
    [READY_ISSUE_TEMPLATE_PATH]: readyIssueTemplate(),
  };
}

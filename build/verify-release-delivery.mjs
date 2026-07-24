import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/i;
const BRANCH_RULESET_NAME = 'coding-x quality gate';
const RELEASE_RULESET_NAME = 'coding-x release refs';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.every((item) => typeof item === 'string')
    && [...actual].sort().join('\0') === [...expected].sort().join('\0');
}

function rules(ruleset) {
  return Array.isArray(ruleset?.rules) ? ruleset.rules.filter(isRecord) : [];
}

function rule(ruleset, type) {
  return rules(ruleset).find((item) => item.type === type);
}

function validateBranchRuleset(ruleset, contract) {
  if (!isRecord(ruleset)
    || ruleset.name !== BRANCH_RULESET_NAME
    || ruleset.target !== 'branch'
    || ruleset.enforcement !== 'active'
    || !Array.isArray(ruleset.bypass_actors)
    || ruleset.bypass_actors.length !== 0) {
    throw new Error('发布时分支 ruleset 缺失、停用或存在绕过主体');
  }
  const include = ruleset.conditions?.ref_name?.include;
  const exclude = ruleset.conditions?.ref_name?.exclude;
  if (!sameStrings(include, [`refs/heads/${contract.github.defaultBranch}`])
    || !sameStrings(exclude, [])) {
    throw new Error('发布时分支 ruleset 未精确保护默认分支');
  }
  if (!rule(ruleset, 'pull_request')
    || !rule(ruleset, 'deletion')
    || !rule(ruleset, 'non_fast_forward')) {
    throw new Error('发布时分支 ruleset 缺少 PR、禁止删除或禁止强推规则');
  }
  const status = rule(ruleset, 'required_status_checks');
  if (status?.parameters?.strict_required_status_checks_policy !== true
    || status?.parameters?.do_not_enforce_on_create !== false
    || !Array.isArray(status.parameters.required_status_checks)) {
    throw new Error('发布时分支 ruleset 未要求最新提交上的严格检查');
  }
  const expected = status.parameters.required_status_checks.map((item) => {
    if (!isRecord(item)
      || typeof item.context !== 'string'
      || !Number.isInteger(item.integration_id)
      || item.integration_id <= 0) {
      throw new Error('发布时 required check 缺少可信 GitHub App 来源');
    }
    return { name: item.context, appId: item.integration_id };
  });
  if (!sameStrings(expected.map((item) => item.name), contract.github.requiredChecks)) {
    throw new Error('发布时 ruleset required checks 与质量契约不一致');
  }
  return expected;
}

function validateReleaseRuleset(ruleset, contract) {
  if (contract.github.releaseRefs.length === 0) return;
  if (!isRecord(ruleset)
    || ruleset.name !== RELEASE_RULESET_NAME
    || ruleset.target !== 'tag'
    || ruleset.enforcement !== 'active'
    || !Array.isArray(ruleset.bypass_actors)
    || ruleset.bypass_actors.length !== 0) {
    throw new Error('发布时 tag ruleset 缺失、停用或存在绕过主体');
  }
  if (!sameStrings(ruleset.conditions?.ref_name?.include, contract.github.releaseRefs)
    || !sameStrings(ruleset.conditions?.ref_name?.exclude, [])
    || !rule(ruleset, 'deletion')
    || !rule(ruleset, 'non_fast_forward')) {
    throw new Error('发布时 tag ruleset 的引用范围或保护规则不完整');
  }
}

function associatedPull(pulls, contract, releaseSha) {
  const matches = Array.isArray(pulls) ? pulls.filter((pull) =>
    pull?.merged_at
    && pull?.base?.ref === contract.github.defaultBranch
    && pull?.merge_commit_sha === releaseSha
    && SHA.test(pull?.head?.sha ?? '')) : [];
  if (matches.length !== 1) {
    throw new Error(`发布提交必须对应默认分支上恰好一个合并结果，实际 ${matches.length}`);
  }
  return matches[0];
}

function latestTrustedCheck(checkRuns, expected) {
  const matches = checkRuns.filter((run) =>
    run?.name === expected.name && run?.app?.id === expected.appId);
  return matches.sort((a, b) => {
    const byTime = String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? ''));
    return byTime || Number(b.id ?? 0) - Number(a.id ?? 0);
  })[0];
}

function activeDeliveries(exceptions, now) {
  if (!isRecord(exceptions) || !Array.isArray(exceptions.deliveries)) {
    throw new Error('异常交付记录缺失或结构非法');
  }
  return exceptions.deliveries.filter((delivery) => {
    if (!isRecord(delivery)
      || typeof delivery.id !== 'string'
      || !SHA.test(delivery.commitSha ?? '')
      || typeof delivery.owner !== 'string'
      || typeof delivery.reason !== 'string'
      || typeof delivery.followUpUrl !== 'string'
      || typeof delivery.auditUrl !== 'string'
      || typeof delivery.expiresAt !== 'string'
      || Number.isNaN(Date.parse(delivery.expiresAt))) {
      throw new Error('异常交付记录字段非法');
    }
    return delivery.resolvedAt === undefined && Date.parse(delivery.expiresAt) > now.getTime();
  });
}

export function verifyReleaseDelivery({
  contract,
  exceptions,
  pulls,
  checkRuns,
  branchRuleset,
  releaseRuleset,
  releaseSha,
  now = new Date(),
  isAncestor,
}) {
  if (!isRecord(contract?.github)
    || !Array.isArray(contract.github.requiredChecks)
    || !Array.isArray(contract.github.releaseRefs)
    || !SHA.test(releaseSha)) {
    throw new Error('发布验证输入中的契约或提交身份非法');
  }
  const expectedChecks = validateBranchRuleset(branchRuleset, contract);
  validateReleaseRuleset(releaseRuleset, contract);
  const pull = associatedPull(pulls, contract, releaseSha);
  const runs = Array.isArray(checkRuns?.check_runs) ? checkRuns.check_runs : [];
  const missingChecks = expectedChecks.filter((expected) => {
    const latest = latestTrustedCheck(runs, expected);
    return !latest || latest.status !== 'completed' || latest.conclusion !== 'success';
  }).map((item) => item.name);
  if (missingChecks.length === 0) {
    return {
      status: 'passed',
      pullNumber: pull.number,
      deliveryHead: pull.head.sha,
      missingChecks: [],
      exceptionIds: [],
    };
  }
  const matchingDeliveries = activeDeliveries(exceptions, now)
    .filter((delivery) => isAncestor(delivery.commitSha, releaseSha));
  if (matchingDeliveries.length === 0) {
    throw new Error(`发布提交缺少可信交付检查且没有有效异常记录：${missingChecks.join('、')}`);
  }
  return {
    status: 'exceptional',
    pullNumber: pull.number,
    deliveryHead: pull.head.sha,
    missingChecks,
    exceptionIds: matchingDeliveries.map((item) => item.id).sort(),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function gitAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const [
    contractPath,
    exceptionsPath,
    pullsPath,
    checksPath,
    branchRulesetPath,
    releaseRulesetPath,
    releaseSha,
  ] = process.argv.slice(2);
  if (!releaseSha) {
    throw new Error('用法：verify-release-delivery <contract> <exceptions> <pulls> <checks> <branch-ruleset> <release-ruleset> <release-sha>');
  }
  const result = verifyReleaseDelivery({
    contract: readJson(contractPath),
    exceptions: readJson(exceptionsPath),
    pulls: readJson(pullsPath),
    checkRuns: readJson(checksPath),
    branchRuleset: readJson(branchRulesetPath),
    releaseRuleset: readJson(releaseRulesetPath),
    releaseSha,
    isAncestor: gitAncestor,
  });
  if (result.status === 'exceptional') {
    console.log(`::warning title=异常发布::缺少 ${result.missingChecks.join('、')}；使用异常记录 ${result.exceptionIds.join('、')}`);
  } else {
    console.log('发布提交的可信交付检查完整通过');
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

import type { GitHubIssueInfo, GitHubReviewReadClient } from '../quality/github.js';
import type { QualityContract } from '../quality/contract.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import type { ReviewDecision, ReviewFinding } from './types.js';

function section(body: string, name: string): string {
  const match = new RegExp(`^### ${name}\\s*\\n([^]*?)(?=^### |$)`, 'm').exec(body);
  const value = match?.[1]?.trim() ?? '';
  return value === '_No response_' ? '' : value;
}

function strictDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(Date.UTC(year, month - 1, day));
  return result.getUTCFullYear() === year &&
    result.getUTCMonth() === month - 1 &&
    result.getUTCDate() === day
    ? result
    : null;
}

export function validateP1DeferralIssue(
  issue: GitHubIssueInfo,
  maxDays: number,
  now: Date,
): string[] {
  const errors: string[] = [];
  if (issue.isPullRequest || issue.state !== 'open') errors.push('延期引用必须是开放 Issue');
  if (!issue.labels.includes('quality-p1-deferral'))
    errors.push('延期 Issue 缺少 quality-p1-deferral 标签');
  const owner = section(issue.body, '负责人');
  const reason = section(issue.body, '原因');
  const expiry = section(issue.body, '到期日');
  const followUp = section(issue.body, '跟进事项');
  if (!owner || !reason || !expiry || !followUp)
    errors.push('延期 Issue 缺少负责人、原因、到期日或跟进事项');
  const expiryDate = strictDate(expiry);
  if (!expiryDate) {
    errors.push('延期 Issue 到期日必须是 YYYY-MM-DD');
  } else {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const latest = new Date(today.getTime() + maxDays * 86_400_000);
    if (expiryDate < today) errors.push('延期 Issue 已过期');
    if (expiryDate > latest) errors.push(`延期 Issue 到期日超过 ${maxDays} 天上限`);
  }
  return errors;
}

export function validatePolicyExceptionIssue(
  issue: GitHubIssueInfo,
  maxDays: number,
  now: Date,
): string[] {
  const errors: string[] = [];
  if (issue.isPullRequest || issue.state !== 'open') errors.push('政策例外必须是开放 Issue');
  if (!issue.labels.includes('quality-policy-exception')) {
    errors.push('政策例外 Issue 缺少 quality-policy-exception 标签');
  }
  const owner = section(issue.body, '负责人');
  const reason = section(issue.body, '原因');
  const expiry = section(issue.body, '到期日');
  const followUp = section(issue.body, '跟进事项');
  if (!owner || !reason || !expiry || !followUp) {
    errors.push('政策例外 Issue 缺少负责人、原因、到期日或跟进事项');
  }
  const expiryDate = strictDate(expiry);
  if (!expiryDate) {
    errors.push('政策例外 Issue 到期日必须是 YYYY-MM-DD');
  } else {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const latest = new Date(today.getTime() + maxDays * 86_400_000);
    if (expiryDate < today) errors.push('政策例外 Issue 已过期');
    if (expiryDate > latest) errors.push(`政策例外 Issue 到期日超过 ${maxDays} 天上限`);
  }
  return errors;
}

export async function unresolvedBlockingFindings(options: {
  findings: ReviewFinding[];
  decisions: ReviewDecision[];
  headSha: string;
  reviewBindingDigest: string;
  contract: QualityContract;
  client: GitHubReviewReadClient;
  now?: Date;
}): Promise<{ unresolved: ReviewFinding[]; decisionErrors: string[] }> {
  const unresolved: ReviewFinding[] = [];
  const decisionErrors: string[] = [];
  const now = options.now ?? new Date();
  for (const finding of options.findings) {
    const blocking =
      finding.severity === 'P0' || finding.severity === 'P1' || finding.requiresHumanDecision;
    if (!blocking) continue;
    const candidates = options.decisions.filter(
      (decision) =>
        decision.findingId === finding.id &&
        decision.headSha === options.headSha &&
        decision.reviewBindingDigest === options.reviewBindingDigest,
    );
    const current = candidates.at(-1);
    if (!current || current.action === 'fix-requested' || current.action === 'acknowledged') {
      unresolved.push(finding);
      continue;
    }
    if (current.action === 'counterevidence') {
      if (!current.evidence || current.evidence.trim().length < 20) {
        decisionErrors.push(`${finding.id} 的反证必须具体且不少于 20 个字符`);
        unresolved.push(finding);
      }
      continue;
    }
    if (current.action === 'p1-deferred') {
      if (finding.severity !== 'P1' || !current.issue) {
        decisionErrors.push(`${finding.id} 只有 P1 finding 可通过有效 Issue 延期`);
        unresolved.push(finding);
        continue;
      }
      if (!options.client.getIssue) {
        decisionErrors.push(`${finding.id} 无法查询延期 Issue`);
        unresolved.push(finding);
        continue;
      }
      try {
        const issue = await options.client.getIssue(
          options.contract.repository.fullName,
          current.issue,
        );
        const errors = validateP1DeferralIssue(issue, options.contract.exceptions.p1.maxDays, now);
        if (errors.length > 0) {
          decisionErrors.push(...errors.map((error) => `${finding.id}：${error}`));
          unresolved.push(finding);
        }
      } catch (error) {
        if (error instanceof WorkspaceSafetyError) throw error;
        decisionErrors.push(
          `${finding.id}：${error instanceof Error ? error.message : String(error)}`,
        );
        unresolved.push(finding);
      }
    }
  }
  return { unresolved, decisionErrors };
}

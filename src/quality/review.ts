import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type {
  FindingSeverity,
  QualityException,
  QualityReceipt,
  ReviewModelOutput,
} from './types.js';
import { resolveFindings } from './receipt.js';
import type { ReviewSource } from './prompts.js';

const SOURCE_FILE_LIMIT = 128 * 1024;
const SOURCE_TOTAL_LIMIT = 500 * 1024;
const SOURCE_COUNT_LIMIT = 100;
const MIN_EVIDENCE_CHARS = 12;
const NO_CHANGE_RECOMMENDATIONS = [
  /^(?:现有|当前|该|此处|代码|实现|行为|测试覆盖|测试)?(?:已经|已)?(?:符合要求[，,。；;\s]*)?(?:无需|无须|不必|不需要)(?:进行)?(?:任何)?(?:代码)?(?:修改|改动|改变|处理|修复|调整|行动)[。.!！\s]*$/u,
  /^(?:no (?:code )?(?:change|changes|modification|modifications|fix|action)(?: is| are)? (?:needed|required|necessary)|no action required|requires? no (?:code )?(?:change|fix|action))[.!?\s]*$/iu,
  /^keep (?:the (?:code|implementation)|it|this)?\s*as[- ]is[.!?\s]*$/iu,
];
const DIFF_BOUNDARY = '\0coding-x-diff-boundary\0';

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('../') && !rel.startsWith('..\\') && rel !== '..');
}

function walkTextFiles(root: string, selector: string): string[] {
  const absolute = resolve(root, selector);
  if (!isWithin(resolve(root), absolute) || !existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [selector.replace(/\\/g, '/')];
  if (!stat.isDirectory()) return [];
  const output: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) output.push(relative(root, path).replace(/\\/g, '/'));
      if (output.length > SOURCE_COUNT_LIMIT) throw new Error('评审来源文件超过 100 个');
    }
  };
  walk(absolute);
  return output;
}

export function collectLocalReviewSources(root: string, selectors: string[]): ReviewSource[] {
  const paths = [...new Set(selectors.flatMap((selector) => walkTextFiles(root, selector)))].sort();
  if (paths.length === 0) throw new Error('没有找到任何评审来源文件');
  const sources: ReviewSource[] = [];
  let total = 0;
  for (const path of paths) {
    const raw = readFileSync(join(root, path));
    if (raw.includes(0)) continue;
    if (raw.byteLength > SOURCE_FILE_LIMIT) throw new Error(`${path} 超过单文件读取上限`);
    total += raw.byteLength;
    if (total > SOURCE_TOTAL_LIMIT) throw new Error('评审来源超过总读取上限');
    sources.push({ path, content: raw.toString('utf8') });
  }
  if (sources.length === 0) throw new Error('评审来源中没有可读文本文件');
  return sources;
}

function unifiedDiffCode(value: string): string {
  return value.split('\n').flatMap((line) => {
    if (line.startsWith('diff --git ')
      || line.startsWith('index ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
      || line.startsWith('@@')
      || line.startsWith('\\ No newline at end of file')) {
      return [DIFF_BOUNDARY];
    }
    return line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')
      ? [line.slice(1)]
      : [];
  }).join('\n');
}

export function validateReviewOutputSemantics(output: ReviewModelOutput): string | null {
  for (const finding of output.findings) {
    const recommendation = finding.recommendation.trim();
    if (NO_CHANGE_RECOMMENDATIONS.some((pattern) => pattern.test(recommendation))) {
      return `finding 建议明确表示无需修改，不是需要变更或正式延期的缺陷：${finding.file}`;
    }
  }
  return null;
}

export function validateReviewOutputGrounding(
  output: ReviewModelOutput,
  visible: {
    diff: string;
    sources: ReviewSource[];
    diffByFile: ReadonlyMap<string, string>;
  },
): string | null {
  for (const finding of output.findings) {
    const evidence = finding.evidence.trim();
    if (evidence.length < MIN_EVIDENCE_CHARS) {
      return `finding 证据至少需要 ${MIN_EVIDENCE_CHARS} 个字符：${finding.file}`;
    }
    const source = visible.sources.find((candidate) => candidate.path === finding.file);
    const fileDiff = visible.diffByFile.get(finding.file);
    const shardContainsEvidence = visible.diff.includes(evidence)
      || unifiedDiffCode(visible.diff).includes(evidence);
    const fileContainsEvidence = fileDiff?.includes(evidence) === true
      || (fileDiff !== undefined && unifiedDiffCode(fileDiff).includes(evidence));
    const groundedInDiff = shardContainsEvidence && fileContainsEvidence;
    if (!groundedInDiff && !source?.content.includes(evidence)) {
      return `finding 证据不是当前评审输入中对应文件的逐字原文：${finding.file}`;
    }
  }
  return null;
}

export function evaluateReviewModelResult(
  output: ReviewModelOutput,
  exceptions: QualityException[],
  headSha: string,
  now: Date,
  deferrableSeverities: FindingSeverity[] = ['medium'],
): {
  status: QualityReceipt['status'];
  summary: string;
  findings: ReviewModelOutput['findings'];
  exceptionIds: string[];
} {
  const resolved = resolveFindings(
    output.findings,
    exceptions,
    headSha,
    now,
    deferrableSeverities,
  );
  return {
    status: resolved.status,
    summary: output.summary,
    findings: output.findings,
    exceptionIds: resolved.exceptionIds,
  };
}

const STATUS_LABELS = {
  passed: '通过',
  failed: '未通过',
  unverifiable: '无法验证',
} as const;

export function renderReviewCheck(receipt: QualityReceipt): {
  title: string;
  summary: string;
  text: string;
} {
  const axis = receipt.axis ?? 'review';
  const title = `${axis} ${STATUS_LABELS[receipt.status]}`;
  const summary = [
    `状态：${receipt.status}`,
    `head：${receipt.headSha?.slice(0, 12) ?? 'unavailable'}`,
    `base：${receipt.baseSha?.slice(0, 12) ?? 'unavailable'}`,
    `契约：${receipt.contractSha256?.slice(0, 12) ?? 'unavailable'}`,
    `发现：${receipt.findings.length}`,
    `例外：${receipt.exceptions.length}`,
  ].join(' · ');
  const findings = receipt.findings.length === 0
    ? '无 finding'
    : receipt.findings.map((finding) => [
        `### [${finding.severity}] ${finding.title}`,
        `- ID: \`${finding.id}\``,
        `- 绑定: \`${finding.headSha}\` · round ${finding.round}`,
        `- 位置: \`${finding.file}${finding.line === null ? '' : `:${finding.line}`}\``,
        `- 依据: ${finding.source}`,
        `- 证据: ${finding.evidence}`,
        `- 影响: ${finding.impact}`,
        `- 建议: ${finding.recommendation}`,
      ].join('\n')).join('\n\n');
  const modelSummary = receipt.reviewSummary
    ? `## 评审摘要\n\n${receipt.reviewSummary}\n\n`
    : '';
  const errors = receipt.errors.length === 0
    ? ''
    : `\n\n## 无法验证原因\n${receipt.errors.map((error) =>
        `- \`${error.code}\`: ${error.message}`).join('\n')}`;
  const deep = receipt.axis === 'deep'
    ? `\n\n## 深度评审触发\n${receipt.deepRequired
      ? (receipt.deepReasons ?? []).map((reason) => `- ${reason}`).join('\n')
      : '- not-required'}`
    : '';
  return {
    title,
    summary,
    text: `## ${axis} review\n\n${modelSummary}${findings}${errors}${deep}`,
  };
}

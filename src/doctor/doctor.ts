import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';

export interface DoctorIssue {
  file: string;
  message: string;
}

export interface FrontmatterCheckResult {
  scanned: number;
  checked: number;
  issues: DoctorIssue[];
}

export interface FreshnessCheckResult {
  staleDays: number;
  gitAvailable: boolean;
  checked: number;
  issues: DoctorIssue[];
}

export interface AgentsIndexCheckResult {
  /** 项目根是否存在 AGENTS.md；不存在时跳过本项检查，不计失败 */
  agentsFound: boolean;
  checked: number;
  issues: DoctorIssue[];
}

export interface LinksCheckResult {
  checked: number;
  issues: DoctorIssue[];
}

export interface DoctorOptions {
  /** git 最后提交日期晚于 updated 超过该天数判过期；0 表示晚一天即过期。缺省 30。 */
  staleDays?: number;
}

export interface DoctorReport {
  docsFound: boolean;
  frontmatter: FrontmatterCheckResult | null;
  freshness: FreshnessCheckResult | null;
  agentsIndex: AgentsIndexCheckResult | null;
  links: LinksCheckResult | null;
}

const REQUIRED_FIELDS = ['title', 'status', 'updated', 'scope'] as const;
const DEFAULT_STALE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * 简单行解析（零依赖，ADR 见 PRD 技术考量）：内容须以 `---` 行开头，
 * 到下一个 `---` 行为止，块内提取 `key: value`。无块或未闭合返回 null。
 */
export function parseFrontmatter(content: string): Record<string, string> | null {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return null;
  const fm: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return fm;
}

/** frontmatter 块之后的正文；无块或未闭合时原样返回。 */
function bodyAfterFrontmatter(content: string): string {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return content;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return end === -1 ? content : lines.slice(end + 1).join('\n');
}

/** 剥掉 fenced code block 与行内 code span——其中的 [text](target) 是字面文本，不是 markdown 链接。 */
function stripCodeSegments(content: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n').replace(/`[^`\n]*`/g, '');
}

/**
 * 相对路径判定：无空格、不以 / 或 - 开头（排除绝对路径与 `--flag`），
 * 且含目录分隔符或字母扩展名（排除 `npm test`、`0.6.0` 这类非路径反引号内容）。
 */
function isRelativePathLike(value: string): boolean {
  if (value === '' || /\s/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('-')) return false;
  return value.includes('/') || /\.[A-Za-z][A-Za-z0-9]*$/.test(value);
}

/**
 * 从 AGENTS.md 的 markdown 表格行中提取反引号包裹的相对路径（去重）。
 * 只认「整个单元格 trim 后正好是一个反引号 token」的情况——即路径独占整格；
 * 说明列散文里内嵌的反引号路径（单元格内还有其他文字）不是索引项，不提取。
 */
export function extractAgentsIndexPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue; // 只解析表格行
    for (const cell of line.split('|')) {
      const trimmed = cell.trim();
      const m = trimmed.match(/^`([^`]+)`$/); // 反引号 token 必须独占整格
      if (!m) continue;
      const candidate = m[1].trim();
      if (isRelativePathLike(candidate)) paths.add(candidate);
    }
  }
  return [...paths];
}

/** 提取正文中 markdown 内联链接 [text](target) 的 target（含图片链接；不含 reference-style）。 */
export function extractInlineLinkTargets(content: string): string[] {
  const targets: string[] = [];
  for (const m of stripCodeSegments(content).matchAll(/\[[^\]]*\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    targets.push(m[1]);
  }
  return targets;
}

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

/** 严格 YYYY-MM-DD → UTC 毫秒；格式不符或日期不存在（如 2026-13-01）返回 null。 */
function parseDateUTC(value: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  return valid ? ts : null;
}

function isGitWorkTree(root: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** 文件在 git 的最后提交日期（%cs，YYYY-MM-DD）；尚无提交记录或 git 失败返回 null。 */
function gitLastCommitDate(root: string, relFile: string): string | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', relFile], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** 对项目根 root 只读执行各项健康检查（无 docs/ 时温和降级）。 */
export function runDoctor(root: string, options: DoctorOptions = {}): DoctorReport {
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const docsDir = join(root, 'docs');
  if (!existsSync(docsDir) || !statSync(docsDir).isDirectory()) {
    return { docsFound: false, frontmatter: null, freshness: null, agentsIndex: null, links: null };
  }
  const files = walkMarkdownFiles(docsDir);
  const gitAvailable = isGitWorkTree(root);
  const fmIssues: DoctorIssue[] = [];
  const freshnessIssues: DoctorIssue[] = [];
  const linkIssues: DoctorIssue[] = [];
  let checked = 0;
  let freshnessChecked = 0;
  let linksChecked = 0;
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm === null) continue; // 无 frontmatter 的 .md（README 占位、工作产物）不参与本项检查
    checked++;
    const rel = relative(root, file);
    const missing = REQUIRED_FIELDS.filter((field) => !(field in fm));
    if (missing.length > 0) {
      fmIssues.push({ file: rel, message: `缺失字段 ${missing.join('、')}` });
    }
    for (const target of extractInlineLinkTargets(bodyAfterFrontmatter(content))) {
      if (/^(https?:\/\/|#|\/)/.test(target)) continue; // 外链、纯锚点、绝对路径不属相对链接检查
      linksChecked++;
      const filePart = target.split('#')[0]; // 含锚点时只检查文件部分
      if (filePart !== '' && !existsSync(join(dirname(file), filePart))) {
        linkIssues.push({ file: rel, message: `断链 ${target}（目标不存在）` });
      }
    }
    if (!('updated' in fm)) continue; // 缺 updated 已由完整性检查报告，新鲜度不重复计
    freshnessChecked++;
    const updatedTs = parseDateUTC(fm.updated);
    if (updatedTs === null) {
      freshnessIssues.push({ file: rel, message: `updated 值「${fm.updated}」不是 YYYY-MM-DD 格式` });
      continue;
    }
    if (!gitAvailable) continue; // 非 git 仓库：跳过新鲜度比较，不报错
    const gitDate = gitLastCommitDate(root, rel);
    if (gitDate === null) continue; // 尚无提交记录：跳过，不报错
    const gitTs = parseDateUTC(gitDate);
    if (gitTs === null) continue;
    const daysBehind = Math.round((gitTs - updatedTs) / DAY_MS);
    if (daysBehind > staleDays) {
      freshnessIssues.push({
        file: rel,
        message: `updated ${fm.updated}，git 最后提交 ${gitDate}，落后 ${daysBehind} 天（阈值 ${staleDays} 天）`,
      });
    }
  }
  const agentsFile = join(root, 'AGENTS.md');
  let agentsIndex: AgentsIndexCheckResult;
  if (existsSync(agentsFile)) {
    const indexPaths = extractAgentsIndexPaths(readFileSync(agentsFile, 'utf-8'));
    agentsIndex = {
      agentsFound: true,
      checked: indexPaths.length,
      issues: indexPaths
        .filter((p) => !existsSync(join(root, p)))
        .map((p) => ({ file: 'AGENTS.md', message: `索引路径 ${p} 不存在` })),
    };
  } else {
    agentsIndex = { agentsFound: false, checked: 0, issues: [] };
  }
  return {
    docsFound: true,
    frontmatter: { scanned: files.length, checked, issues: fmIssues },
    freshness: { staleDays, gitAvailable, checked: freshnessChecked, issues: freshnessIssues },
    agentsIndex,
    links: { checked: linksChecked, issues: linkIssues },
  };
}

export function renderDoctorReport(report: DoctorReport): { text: string; exitCode: number } {
  if (!report.docsFound) {
    return {
      text: 'ℹ️  未找到 docs/ 目录：建议先运行 /init-docs 生成知识库，再用 doctor 做健康检查。',
      exitCode: 0,
    };
  }
  const fm = report.frontmatter!;
  const fresh = report.freshness!;
  const lines: string[] = ['🩺 docs/ 知识库健康检查', '', '📋 frontmatter 完整性'];
  if (fm.issues.length === 0) {
    lines.push(`  ✅ 通过（已检查 ${fm.checked} 个带 frontmatter 文件 / 共扫描 ${fm.scanned} 个 .md）`);
  } else {
    for (const issue of fm.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  lines.push('', `⏰ updated 新鲜度（阈值 ${fresh.staleDays} 天）`);
  if (fresh.issues.length === 0) {
    const gitNote = fresh.gitAvailable ? '' : '；非 git 仓库，已跳过 git 日期比较';
    lines.push(`  ✅ 通过（已检查 ${fresh.checked} 个含 updated 文件${gitNote}）`);
  } else {
    for (const issue of fresh.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  const idx = report.agentsIndex!;
  lines.push('', '📇 AGENTS.md 索引');
  if (!idx.agentsFound) {
    lines.push('  ℹ️  未找到 AGENTS.md：已跳过索引检查');
  } else if (idx.issues.length === 0) {
    lines.push(`  ✅ 通过（已检查 ${idx.checked} 条索引路径）`);
  } else {
    for (const issue of idx.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  const links = report.links!;
  lines.push('', '🔗 文档相对链接');
  if (links.issues.length === 0) {
    lines.push(`  ✅ 通过（已检查 ${links.checked} 条相对链接）`);
  } else {
    for (const issue of links.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  const total = fm.issues.length + fresh.issues.length + idx.issues.length + links.issues.length;
  lines.push('', total === 0 ? '✅ 全部通过' : `❌ 共发现 ${total} 个问题`);
  return { text: lines.join('\n'), exitCode: total === 0 ? 0 : 1 };
}

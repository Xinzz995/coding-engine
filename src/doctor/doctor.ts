import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface DoctorIssue {
  file: string;
  message: string;
}

export interface FrontmatterCheckResult {
  scanned: number;
  checked: number;
  issues: DoctorIssue[];
}

export interface DoctorReport {
  docsFound: boolean;
  frontmatter: FrontmatterCheckResult | null;
}

const REQUIRED_FIELDS = ['title', 'status', 'updated', 'scope'] as const;

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

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

/** 对项目根 root 只读执行各项健康检查（无 docs/ 时温和降级）。 */
export function runDoctor(root: string): DoctorReport {
  const docsDir = join(root, 'docs');
  if (!existsSync(docsDir) || !statSync(docsDir).isDirectory()) {
    return { docsFound: false, frontmatter: null };
  }
  const files = walkMarkdownFiles(docsDir);
  const issues: DoctorIssue[] = [];
  let checked = 0;
  for (const file of files) {
    const fm = parseFrontmatter(readFileSync(file, 'utf-8'));
    if (fm === null) continue; // 无 frontmatter 的 .md（README 占位、工作产物）不参与本项检查
    checked++;
    const missing = REQUIRED_FIELDS.filter((field) => !(field in fm));
    if (missing.length > 0) {
      issues.push({ file: relative(root, file), message: `缺失字段 ${missing.join('、')}` });
    }
  }
  return { docsFound: true, frontmatter: { scanned: files.length, checked, issues } };
}

export function renderDoctorReport(report: DoctorReport): { text: string; exitCode: number } {
  if (!report.docsFound) {
    return {
      text: 'ℹ️  未找到 docs/ 目录：建议先运行 /init-docs 生成知识库，再用 doctor 做健康检查。',
      exitCode: 0,
    };
  }
  const fm = report.frontmatter!;
  const lines: string[] = ['🩺 docs/ 知识库健康检查', '', '📋 frontmatter 完整性'];
  if (fm.issues.length === 0) {
    lines.push(`  ✅ 通过（已检查 ${fm.checked} 个带 frontmatter 文件 / 共扫描 ${fm.scanned} 个 .md）`);
  } else {
    for (const issue of fm.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  const total = fm.issues.length;
  lines.push('', total === 0 ? '✅ 全部通过' : `❌ 共发现 ${total} 个问题`);
  return { text: lines.join('\n'), exitCode: total === 0 ? 0 : 1 };
}

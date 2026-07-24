export interface ReviewIntent {
  intent: string;
  acceptanceCriteria: string;
  nonGoals: string;
  verification: string;
}

export interface ReviewSpecSelection {
  mode: 'linked' | 'self-contained';
  paths: string[];
}

const SECTION_ALIASES = {
  intent: ['意图', '目的', 'intent'],
  acceptanceCriteria: ['验收标准', '验收条件', 'acceptance criteria', 'acceptance'],
  nonGoals: ['非目标', '不做', 'non-goals', 'non goals'],
  verification: ['验证方式', '验证', 'verification', 'test plan'],
  specification: ['关联规格', '规格来源', 'linked specs', 'spec sources'],
} as const;

type IntentKey = keyof ReviewIntent;
type SectionKey = IntentKey | 'specification';

function meaningfulSection(lines: string[]): string {
  return lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function canonicalHeading(value: string): SectionKey | null {
  const normalized = value.trim().toLowerCase().replace(/[*_`]/g, '');
  for (const [key, aliases] of Object.entries(SECTION_ALIASES) as Array<
    [SectionKey, readonly string[]]
  >) {
    if (aliases.includes(normalized)) return key;
  }
  return null;
}

const SELF_CONTAINED_SPEC = new Set([
  '本 pr 意图即完整 spec',
  '本pr意图即完整spec',
  'self-contained',
  'pr intent is the spec',
]);

function normalizeSpecLine(line: string): string {
  const withoutBullet = line.trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .trim();
  const code = /^`([^`]+)`$/.exec(withoutBullet);
  return (code?.[1] ?? withoutBullet).trim();
}

function validProjectPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.endsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function parseSpecSelection(lines: string[]): (
  | { status: 'valid'; selection: ReviewSpecSelection }
  | { status: 'invalid'; error: string }
) {
  const content = meaningfulSection(lines);
  if (content === '') return { status: 'invalid', error: '关联规格' };
  const values = content.split(/\r?\n/)
    .map(normalizeSpecLine)
    .filter(Boolean);
  const selfContained = values.filter((value) =>
    SELF_CONTAINED_SPEC.has(value.toLowerCase()));
  if (selfContained.length > 0) {
    if (values.length !== 1) {
      return { status: 'invalid', error: '关联规格不能同时声明自包含与文件路径' };
    }
    return {
      status: 'valid',
      selection: { mode: 'self-contained', paths: [] },
    };
  }
  const invalid = values.find((value) => !validProjectPath(value));
  if (invalid) {
    return { status: 'invalid', error: `关联规格不是安全的项目文件路径：${invalid}` };
  }
  return {
    status: 'valid',
    selection: {
      mode: 'linked',
      paths: [...new Set(values)],
    },
  };
}

export function selectReviewSpecPaths(
  selection: ReviewSpecSelection,
  availablePaths: string[],
  changedFiles: string[],
): string[] {
  const available = new Set(availablePaths);
  const unavailable = selection.paths.find((path) => !available.has(path));
  if (unavailable) {
    throw new Error(`关联规格不在质量契约允许范围内，或当前提交不存在：${unavailable}`);
  }
  return [...new Set([
    ...selection.paths,
    ...changedFiles.filter((path) => available.has(path)),
  ])].sort();
}

export function parseReviewIntent(body: string): (
  | {
      status: 'valid';
      intent: ReviewIntent;
      specification: ReviewSpecSelection;
      missing: [];
    }
  | { status: 'invalid'; intent: null; missing: string[] }
) {
  const sections: Partial<Record<SectionKey, string[]>> = {};
  let current: SectionKey | null = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = canonicalHeading(heading[1]);
      if (current && !sections[current]) sections[current] = [];
      continue;
    }
    if (current) sections[current]!.push(line);
  }
  const labels: Record<IntentKey, string> = {
    intent: '意图',
    acceptanceCriteria: '验收标准',
    nonGoals: '非目标',
    verification: '验证方式',
  };
  const missing = (Object.keys(labels) as IntentKey[]).filter((key) =>
    meaningfulSection(sections[key] ?? []) === '').map((key) => labels[key]);
  const specification = parseSpecSelection(sections.specification ?? []);
  if (specification.status === 'invalid') missing.push(specification.error);
  if (missing.length > 0) return { status: 'invalid', intent: null, missing };
  if (specification.status === 'invalid') {
    return { status: 'invalid', intent: null, missing: [specification.error] };
  }
  return {
    status: 'valid',
    intent: {
      intent: meaningfulSection(sections.intent!),
      acceptanceCriteria: meaningfulSection(sections.acceptanceCriteria!),
      nonGoals: meaningfulSection(sections.nonGoals!),
      verification: meaningfulSection(sections.verification!),
    },
    specification: specification.selection,
    missing: [],
  };
}

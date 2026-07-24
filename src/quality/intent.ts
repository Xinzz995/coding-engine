export interface ReviewIntent {
  intent: string;
  acceptanceCriteria: string;
  nonGoals: string;
  verification: string;
}

const SECTION_ALIASES = {
  intent: ['意图', '目的', 'intent'],
  acceptanceCriteria: ['验收标准', '验收条件', 'acceptance criteria', 'acceptance'],
  nonGoals: ['非目标', '不做', 'non-goals', 'non goals'],
  verification: ['验证方式', '验证', 'verification', 'test plan'],
} as const;

type IntentKey = keyof ReviewIntent;

function meaningfulSection(lines: string[]): string {
  return lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function canonicalHeading(value: string): IntentKey | null {
  const normalized = value.trim().toLowerCase().replace(/[*_`]/g, '');
  for (const [key, aliases] of Object.entries(SECTION_ALIASES) as Array<
    [IntentKey, readonly string[]]
  >) {
    if (aliases.includes(normalized)) return key;
  }
  return null;
}

export function parseReviewIntent(body: string): (
  | { status: 'valid'; intent: ReviewIntent; missing: [] }
  | { status: 'invalid'; intent: null; missing: string[] }
) {
  const sections: Partial<Record<IntentKey, string[]>> = {};
  let current: IntentKey | null = null;
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
  if (missing.length > 0) return { status: 'invalid', intent: null, missing };
  return {
    status: 'valid',
    intent: {
      intent: meaningfulSection(sections.intent!),
      acceptanceCriteria: meaningfulSection(sections.acceptanceCriteria!),
      nonGoals: meaningfulSection(sections.nonGoals!),
      verification: meaningfulSection(sections.verification!),
    },
    missing: [],
  };
}

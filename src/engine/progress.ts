import { readFileSync } from 'node:fs';

export function readProgress(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

export function extractLastStoryId(progressText: string): string | null {
  let last: string | null = null;
  for (const line of progressText.split('\n')) {
    if (!line.startsWith('## ')) continue;
    const m = line.match(/(US-\d+)/);
    if (m) last = m[1];
  }
  return last;
}

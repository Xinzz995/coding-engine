import { readFileSync } from 'node:fs';

export function readProgress(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

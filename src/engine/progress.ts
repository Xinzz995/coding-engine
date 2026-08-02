import { readStableFile } from '../workspace-safety/stable-file.js';

export function readProgress(path: string): string {
  const file = readStableFile(path, { label: 'progress.md' });
  return file.status === 'ready' ? file.bytes.toString('utf8') : '';
}

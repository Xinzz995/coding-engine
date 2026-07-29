import { readSafeControlFileUtf8Sync } from './safe-control-file.js';

export const PROGRESS_CONTROL_FILE_MAX_BYTES = 4 * 1024 * 1024;

export function readProgress(path: string): string {
  try {
    return (
      readSafeControlFileUtf8Sync(path, {
        maxBytes: PROGRESS_CONTROL_FILE_MAX_BYTES,
        allowMissing: true,
      }) ?? ''
    );
  } catch {
    return '';
  }
}

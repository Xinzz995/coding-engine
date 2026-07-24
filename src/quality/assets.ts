import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ManagedQualityAsset =
  | 'github/coding-x-project-checks.yml'
  | 'github/coding-x-review.yml'
  | 'github/coding-x-doctor.yml'
  | 'github/pull_request_template.md';

function qualityAssetPath(path: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'quality', path),
    join(here, '..', '..', 'assets', 'quality', path),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Try source layout after built layout.
    }
  }
  return candidates[0];
}
export function readManagedQualityAsset(path: ManagedQualityAsset, version: string): string {
  return readFileSync(qualityAssetPath(path), 'utf8')
    .replaceAll('{{CODING_X_VERSION}}', version);
}

export function currentPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof value.version === 'string' && /^\d+\.\d+\.\d+/.test(value.version)) {
        return value.version;
      }
    } catch {
      // Try next package layout.
    }
  }
  throw new Error('无法读取 coding-x 版本');
}

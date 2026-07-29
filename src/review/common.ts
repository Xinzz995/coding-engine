import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ModelsConfig } from '../engine/prd.js';

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
  );
}

export function digest(value: unknown): string {
  const data = typeof value === 'string' ? value : JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/**
 * 最终 Review 只绑定 PRD 内冻结的路由政策；CLI 临时覆盖由
 * binding.runner/model 另行记录，不得反向改写项目政策摘要。
 */
export function reviewRoutingDigest(models: ModelsConfig | undefined): string {
  return digest({ schemaVersion: 1, models: models ?? null });
}

export function normalizeText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
}

/** 只允许清理由引擎直接创建在系统临时目录下、且名称带指定前缀的目录。 */
export function isOwnedTempDirectory(target: string, prefix: string): boolean {
  const relativePath = relative(resolve(tmpdir()), resolve(target));
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
    && !relativePath.includes(sep)
    && relativePath.startsWith(prefix);
}

export function globMatches(path: string, pattern: string): boolean {
  let regex = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${regex}$`).test(path);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globMatches(path, pattern));
}

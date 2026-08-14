import { createHash } from 'node:crypto';
import type { QualityContract, QualityPlatform } from './contract.js';
import { isGitHead } from '../contracts/validation-contract.js';

export const CLEAN_VALIDATION_CHECKOUT_VERSION = 'clean-checkout-v4' as const;

export interface ValidationGitReferenceAlias {
  readonly ref: string;
  readonly target: string;
}

function currentQualityPlatform(): QualityPlatform {
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  throw new Error(`当前系统 ${process.platform} 不支持本地干净检出验证`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function normalizeValidationAdditionalRefs(
  head: string,
  additionalRefs: readonly string[] = [],
): string[] {
  return [...new Set(additionalRefs)].filter((ref) => ref !== head).sort();
}

function isSafeValidationReference(value: string): boolean {
  const hasForbiddenCharacter = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character);
  });
  return (
    value.startsWith('refs/remotes/origin/') &&
    value.length <= 1024 &&
    !hasForbiddenCharacter &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    value.split('/').every((part) => part !== '' && !part.startsWith('.'))
  );
}

export function normalizeValidationReferenceAliases(
  aliases: readonly ValidationGitReferenceAlias[] = [],
): ValidationGitReferenceAlias[] {
  const byRef = new Map<string, string>();
  for (const alias of aliases) {
    if (!isSafeValidationReference(alias.ref) || !isGitHead(alias.target)) {
      throw new Error('验证 Git 引用必须是安全的 origin 跟踪引用与完整 commit id');
    }
    const existing = byRef.get(alias.ref);
    if (existing !== undefined && existing !== alias.target) {
      throw new Error(`验证 Git 引用 ${alias.ref} 不能指向多个提交`);
    }
    byRef.set(alias.ref, alias.target);
  }
  return [...byRef.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, target]) => ({ ref, target }));
}

/** 绑定 checkout 协议、平台、精确提交与经默认分支裁决的准备/产物边界。 */
export function validationEnvironmentDigest(options: {
  readonly contract: Pick<QualityContract, 'checks' | 'generatedPaths' | 'localValidation'>;
  readonly head: string;
  readonly platform?: QualityPlatform;
  readonly additionalRefs?: readonly string[];
  readonly referenceAliases?: readonly ValidationGitReferenceAlias[];
  /** 与 receipt 同一验证域内、但不属于质量契约的冻结机械政策（当前为 TDD）。 */
  readonly additionalPolicy?: unknown;
}): string {
  const referenceAliases = normalizeValidationReferenceAliases(options.referenceAliases);
  const data = canonicalize({
    version: CLEAN_VALIDATION_CHECKOUT_VERSION,
    head: options.head,
    platform: options.platform ?? currentQualityPlatform(),
    localValidation: options.contract.localValidation,
    generatedPaths: options.contract.generatedPaths,
    checks: options.contract.checks,
    additionalRefs: normalizeValidationAdditionalRefs(options.head, [
      ...(options.additionalRefs ?? []),
      ...referenceAliases.map((alias) => alias.target),
    ]),
    referenceAliases,
    additionalPolicy: options.additionalPolicy ?? null,
  });
  return `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`;
}

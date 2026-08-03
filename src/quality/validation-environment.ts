import { createHash } from 'node:crypto';
import type { QualityContract, QualityPlatform } from './contract.js';

export const CLEAN_VALIDATION_CHECKOUT_VERSION = 'clean-checkout-v2' as const;

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

/** 绑定 checkout 协议、平台、精确提交与经默认分支裁决的准备/产物边界。 */
export function validationEnvironmentDigest(options: {
  readonly contract: Pick<QualityContract, 'checks' | 'generatedPaths' | 'localValidation'>;
  readonly head: string;
  readonly platform?: QualityPlatform;
  readonly additionalRefs?: readonly string[];
  /** 与 receipt 同一验证域内、但不属于质量契约的冻结机械政策（当前为 TDD）。 */
  readonly additionalPolicy?: unknown;
}): string {
  const data = canonicalize({
    version: CLEAN_VALIDATION_CHECKOUT_VERSION,
    head: options.head,
    platform: options.platform ?? currentQualityPlatform(),
    localValidation: options.contract.localValidation,
    generatedPaths: options.contract.generatedPaths,
    checks: options.contract.checks,
    additionalRefs: [...new Set(options.additionalRefs ?? [])].sort(),
    additionalPolicy: options.additionalPolicy ?? null,
  });
  return `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`;
}

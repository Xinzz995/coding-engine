import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  DeepReviewPolicy,
  DeliveryException,
  ExceptionPolicy,
  FindingSeverity,
  GitHubQualityPolicy,
  QualityCheck,
  QualityContractV1,
  QualityException,
  QualityExceptionsV1,
  ReviewPolicy,
} from './types.js';

export const QUALITY_CONTRACT_PATH = join('.coding-x', 'quality.json');
export const DEFAULT_EXCEPTIONS_PATH = join('.coding-x', 'exceptions.json');
const ROOT_KEYS = new Set([
  'version', 'checks', 'review', 'github', 'exceptionPolicy', 'exceptionsFile',
]);
const CHECK_KEYS = new Set(['id', 'command', 'cwd', 'paths']);
const REVIEW_KEYS = new Set(['model', 'specSources', 'standardsSources', 'deepReview']);
const DEEP_KEYS = new Set(['highRiskPaths', 'changedProductionLines', 'largeFileLines']);
const GITHUB_KEYS = new Set([
  'repository', 'defaultBranch', 'releaseRefs', 'codingXVersion', 'requiredChecks',
]);
const EXCEPTION_POLICY_KEYS = new Set(['deferrableSeverities']);
const EXCEPTIONS_ROOT_KEYS = new Set(['version', 'exceptions', 'deliveries']);
const EXCEPTION_KEYS = new Set([
  'id', 'findingId', 'reason', 'owner', 'expiresAt', 'followUpUrl', 'headSha',
]);
const DELIVERY_KEYS = new Set([
  'id', 'commitSha', 'reason', 'owner', 'expiresAt', 'followUpUrl', 'auditUrl', 'resolvedAt',
]);

type Valid<T> = { status: 'valid'; value: T; errors: [] };
type Invalid = { status: 'invalid'; value: null; errors: string[] };
export type ParseResult<T> = Valid<T> | Invalid;
export type ContractReadResult =
  | { status: 'missing'; path: string }
  | { status: 'invalid'; path: string; errors: string[] }
  | {
      status: 'valid';
      path: string;
      contract: QualityContractV1;
      raw: string;
      sha256: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} 是未知字段`);
  }
}

function nonEmpty(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path} 必须是非空字符串`);
    return false;
  }
  return true;
}

function stringArray(
  value: unknown,
  path: string,
  errors: string[],
  allowEmpty = true,
): value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    errors.push(`${path} 必须是非空字符串数组`);
    return false;
  }
  if (!allowEmpty && value.length === 0) {
    errors.push(`${path} 至少需要一项`);
    return false;
  }
  return true;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function validateProjectRelativePath(
  root: string,
  value: unknown,
  path: string,
  errors: string[],
): value is string {
  if (!nonEmpty(value, path, errors)) return false;
  if (isAbsolute(value)) {
    errors.push(`${path} 必须是项目内相对路径`);
    return false;
  }
  const normalized = normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    errors.push(`${path} 不能越出项目根`);
    return false;
  }
  const absolute = resolve(root, value);
  if (!isWithinRoot(resolve(root), absolute)) {
    errors.push(`${path} 不能越出项目根`);
    return false;
  }
  if (existsSync(absolute)) {
    try {
      if (!isWithinRoot(realpathSync.native(root), realpathSync.native(absolute))) {
        errors.push(`${path} 的真实路径不能越出项目根`);
        return false;
      }
    } catch (error) {
      errors.push(`${path} 无法解析真实路径：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  return true;
}

function readCheck(value: unknown, index: number, root: string, errors: string[]): QualityCheck | null {
  const path = `checks[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return null;
  }
  unknownKeys(value, CHECK_KEYS, path, errors);
  const validId = nonEmpty(value.id, `${path}.id`, errors);
  const validCommand = nonEmpty(value.command, `${path}.command`, errors);
  const validCwd = validateProjectRelativePath(root, value.cwd, `${path}.cwd`, errors);
  const validPaths = stringArray(value.paths, `${path}.paths`, errors, false);
  if (validPaths) {
    const paths = value.paths as string[];
    paths.forEach((item, itemIndex) => {
      validateProjectRelativePath(root, item, `${path}.paths[${itemIndex}]`, errors);
    });
  }
  if (!validId || !validCommand || !validCwd || !validPaths) return null;
  return {
    id: value.id as string,
    command: value.command as string,
    cwd: value.cwd as string,
    paths: [...value.paths as string[]],
  };
}

function positiveInteger(value: unknown, path: string, errors: string[]): value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    errors.push(`${path} 必须是正整数`);
    return false;
  }
  return true;
}

function readReview(value: unknown, root: string, errors: string[]): ReviewPolicy | null {
  if (!isRecord(value)) {
    errors.push('review 必须是对象');
    return null;
  }
  unknownKeys(value, REVIEW_KEYS, 'review', errors);
  const validModel = nonEmpty(value.model, 'review.model', errors);
  const validSpec = stringArray(value.specSources, 'review.specSources', errors, false);
  const validStandards = stringArray(value.standardsSources, 'review.standardsSources', errors, false);
  if (validSpec) {
    const specSources = value.specSources as string[];
    specSources.forEach((item, index) => {
      validateProjectRelativePath(root, item, `review.specSources[${index}]`, errors);
    });
  }
  if (validStandards) {
    const standardsSources = value.standardsSources as string[];
    standardsSources.forEach((item, index) => {
      validateProjectRelativePath(root, item, `review.standardsSources[${index}]`, errors);
    });
  }
  let deep: DeepReviewPolicy | null = null;
  if (!isRecord(value.deepReview)) {
    errors.push('review.deepReview 必须是对象');
  } else {
    unknownKeys(value.deepReview, DEEP_KEYS, 'review.deepReview', errors);
    const validPaths = stringArray(
      value.deepReview.highRiskPaths,
      'review.deepReview.highRiskPaths',
      errors,
    );
    if (validPaths) {
      const highRiskPaths = value.deepReview.highRiskPaths as string[];
      highRiskPaths.forEach((item, index) => {
        validateProjectRelativePath(root, item, `review.deepReview.highRiskPaths[${index}]`, errors);
      });
    }
    const validChanged = positiveInteger(
      value.deepReview.changedProductionLines,
      'review.deepReview.changedProductionLines',
      errors,
    );
    const validLarge = positiveInteger(
      value.deepReview.largeFileLines,
      'review.deepReview.largeFileLines',
      errors,
    );
    if (validPaths && validChanged && validLarge) {
      deep = {
        highRiskPaths: [...value.deepReview.highRiskPaths as string[]],
        changedProductionLines: value.deepReview.changedProductionLines as number,
        largeFileLines: value.deepReview.largeFileLines as number,
      };
    }
  }
  if (!validModel || !validSpec || !validStandards || !deep) return null;
  return {
    model: value.model as string,
    specSources: [...value.specSources as string[]],
    standardsSources: [...value.standardsSources as string[]],
    deepReview: deep,
  };
}

function readGitHub(value: unknown, errors: string[]): GitHubQualityPolicy | null {
  if (!isRecord(value)) {
    errors.push('github 必须是对象');
    return null;
  }
  unknownKeys(value, GITHUB_KEYS, 'github', errors);
  const validRepository = nonEmpty(value.repository, 'github.repository', errors);
  if (validRepository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository as string)) {
    errors.push('github.repository 必须是 owner/repo');
  }
  const validBranch = nonEmpty(value.defaultBranch, 'github.defaultBranch', errors);
  if (validBranch && (!/^[A-Za-z0-9._/-]+$/.test(value.defaultBranch as string)
    || (value.defaultBranch as string).startsWith('/')
    || (value.defaultBranch as string).endsWith('/')
    || (value.defaultBranch as string).includes('..'))) {
    errors.push('github.defaultBranch 不是安全的分支名');
  }
  const validRefs = stringArray(value.releaseRefs, 'github.releaseRefs', errors);
  if (validRefs) {
    for (const [index, ref] of (value.releaseRefs as string[]).entries()) {
      if (!ref.startsWith('refs/tags/') || ref.includes('..')) {
        errors.push(`github.releaseRefs[${index}] 必须是 refs/tags/ 下的模式`);
      }
    }
    if (new Set(value.releaseRefs as string[]).size !== (value.releaseRefs as string[]).length) {
      errors.push('github.releaseRefs 不能重复');
    }
  }
  const validVersion = nonEmpty(value.codingXVersion, 'github.codingXVersion', errors);
  if (validVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.codingXVersion as string)) {
    errors.push('github.codingXVersion 必须固定为完整版本号，不能使用 latest 或范围');
  }
  const validChecks = stringArray(value.requiredChecks, 'github.requiredChecks', errors, false);
  if (validChecks
    && new Set(value.requiredChecks as string[]).size !== (value.requiredChecks as string[]).length) {
    errors.push('github.requiredChecks 不能重复');
  }
  if (!validRepository || !validBranch || !validRefs || !validVersion || !validChecks) return null;
  return {
    repository: value.repository as string,
    defaultBranch: value.defaultBranch as string,
    releaseRefs: [...value.releaseRefs as string[]],
    codingXVersion: value.codingXVersion as string,
    requiredChecks: [...value.requiredChecks as string[]],
  };
}

function readExceptionPolicy(value: unknown, errors: string[]): ExceptionPolicy | null {
  if (!isRecord(value)) {
    errors.push('exceptionPolicy 必须是对象');
    return null;
  }
  unknownKeys(value, EXCEPTION_POLICY_KEYS, 'exceptionPolicy', errors);
  const valid = stringArray(
    value.deferrableSeverities,
    'exceptionPolicy.deferrableSeverities',
    errors,
  );
  if (!valid) return null;
  const severities = value.deferrableSeverities as string[];
  if (severities.some((severity) => severity !== 'medium')) {
    errors.push('exceptionPolicy.deferrableSeverities 只能包含 medium');
  }
  if (new Set(severities).size !== severities.length) {
    errors.push('exceptionPolicy.deferrableSeverities 不能重复');
  }
  if (errors.length > 0) return null;
  return { deferrableSeverities: severities as FindingSeverity[] };
}

export function parseQualityContract(value: unknown, root: string): (
  | { status: 'valid'; contract: QualityContractV1; errors: [] }
  | { status: 'invalid'; contract: null; errors: string[] }
) {
  const errors: string[] = [];
  if (!isRecord(value)) return { status: 'invalid', contract: null, errors: ['质量契约必须是对象'] };
  unknownKeys(value, ROOT_KEYS, 'quality', errors);
  if (value.version !== 1) errors.push('version 必须是 1');
  const checks: QualityCheck[] = [];
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    errors.push('checks 至少需要一项');
  } else {
    value.checks.forEach((item, index) => {
      const parsed = readCheck(item, index, root, errors);
      if (parsed) checks.push(parsed);
    });
  }
  const ids = new Set<string>();
  for (const check of checks) {
    if (ids.has(check.id)) errors.push(`checks id 重复：${check.id}`);
    ids.add(check.id);
  }
  const review = readReview(value.review, root, errors);
  const github = readGitHub(value.github, errors);
  const exceptionPolicy = readExceptionPolicy(value.exceptionPolicy, errors);
  const validExceptions = validateProjectRelativePath(
    root,
    value.exceptionsFile,
    'exceptionsFile',
    errors,
  );
  if (errors.length > 0 || !review || !github || !exceptionPolicy || !validExceptions) {
    return { status: 'invalid', contract: null, errors };
  }
  return {
    status: 'valid',
    contract: {
      version: 1,
      checks,
      review,
      github,
      exceptionPolicy,
      exceptionsFile: value.exceptionsFile as string,
    },
    errors: [],
  };
}

export function readQualityContract(root: string): ContractReadResult {
  return readQualityContractFile(root, join(root, QUALITY_CONTRACT_PATH));
}

export function readQualityContractFile(root: string, path: string): ContractReadResult {
  if (!existsSync(path)) return { status: 'missing', path };
  let raw: string;
  let value: unknown;
  try {
    raw = readFileSync(path, 'utf8');
    value = JSON.parse(raw);
  } catch (error) {
    return {
      status: 'invalid',
      path,
      errors: [`质量契约 JSON 无法读取：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = parseQualityContract(value, root);
  if (parsed.status === 'invalid') return { status: 'invalid', path, errors: parsed.errors };
  return {
    status: 'valid',
    path,
    contract: parsed.contract,
    raw,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

export function readQualityContractAtRef(root: string, ref: string): ContractReadResult {
  const path = `${ref}:${QUALITY_CONTRACT_PATH}`;
  let raw: string;
  let value: unknown;
  try {
    raw = execFileSync('git', ['show', path], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    value = JSON.parse(raw);
  } catch (error) {
    return {
      status: 'invalid',
      path,
      errors: [`无法读取可信提交中的质量契约：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = parseQualityContract(value, root);
  if (parsed.status === 'invalid') return { status: 'invalid', path, errors: parsed.errors };
  return {
    status: 'valid',
    path,
    contract: parsed.contract,
    raw,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

function readException(value: unknown, index: number, errors: string[]): QualityException | null {
  const path = `exceptions[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return null;
  }
  unknownKeys(value, EXCEPTION_KEYS, path, errors);
  const required = ['id', 'findingId', 'reason', 'owner', 'expiresAt', 'followUpUrl'] as const;
  const fieldsValid = required.map((key) => nonEmpty(value[key], `${path}.${key}`, errors))
    .every(Boolean);
  if (typeof value.expiresAt === 'string'
    && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.expiresAt)
      || Number.isNaN(Date.parse(value.expiresAt)))) {
    errors.push(`${path}.expiresAt 必须是带 Z 时区的 ISO 日期时间`);
  }
  if (typeof value.followUpUrl === 'string' && !/^https:\/\/\S+$/.test(value.followUpUrl)) {
    errors.push(`${path}.followUpUrl 必须是 https URL`);
  }
  if (value.headSha !== undefined
    && (typeof value.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.headSha))) {
    errors.push(`${path}.headSha 必须是 40 位 Git SHA`);
  }
  if (!fieldsValid) return null;
  return {
    id: value.id as string,
    findingId: value.findingId as string,
    reason: value.reason as string,
    owner: value.owner as string,
    expiresAt: value.expiresAt as string,
    followUpUrl: value.followUpUrl as string,
    ...(value.headSha === undefined ? {} : { headSha: value.headSha as string }),
  };
}

function validIsoDate(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    errors.push(`${path} 必须是带 Z 时区的 ISO 日期时间`);
    return false;
  }
  return true;
}

function readDelivery(
  value: unknown,
  index: number,
  errors: string[],
): DeliveryException | null {
  const path = `deliveries[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return null;
  }
  unknownKeys(value, DELIVERY_KEYS, path, errors);
  const required = ['id', 'reason', 'owner', 'followUpUrl', 'auditUrl'] as const;
  const fieldsValid = required.map((key) => nonEmpty(value[key], `${path}.${key}`, errors))
    .every(Boolean);
  const validCommit = typeof value.commitSha === 'string' && /^[0-9a-f]{40}$/i.test(value.commitSha);
  if (!validCommit) errors.push(`${path}.commitSha 必须是 40 位 Git SHA`);
  const validExpiry = validIsoDate(value.expiresAt, `${path}.expiresAt`, errors);
  for (const key of ['followUpUrl', 'auditUrl'] as const) {
    if (typeof value[key] === 'string' && !/^https:\/\/\S+$/.test(value[key])) {
      errors.push(`${path}.${key} 必须是 https URL`);
    }
  }
  let validResolved = true;
  if (value.resolvedAt !== undefined) {
    validResolved = validIsoDate(value.resolvedAt, `${path}.resolvedAt`, errors);
  }
  if (!fieldsValid || !validCommit || !validExpiry || !validResolved) return null;
  return {
    id: value.id as string,
    commitSha: value.commitSha as string,
    reason: value.reason as string,
    owner: value.owner as string,
    expiresAt: value.expiresAt as string,
    followUpUrl: value.followUpUrl as string,
    auditUrl: value.auditUrl as string,
    ...(value.resolvedAt === undefined ? {} : { resolvedAt: value.resolvedAt as string }),
  };
}

export function parseQualityExceptions(value: unknown): ParseResult<QualityExceptionsV1> {
  const errors: string[] = [];
  if (!isRecord(value)) return { status: 'invalid', value: null, errors: ['exceptions 必须是对象'] };
  unknownKeys(value, EXCEPTIONS_ROOT_KEYS, 'exceptions', errors);
  if (value.version !== 1) errors.push('exceptions.version 必须是 1');
  const exceptions: QualityException[] = [];
  const deliveries: DeliveryException[] = [];
  if (!Array.isArray(value.exceptions)) {
    errors.push('exceptions.exceptions 必须是数组');
  } else {
    value.exceptions.forEach((item, index) => {
      const parsed = readException(item, index, errors);
      if (parsed) exceptions.push(parsed);
    });
  }
  if (!Array.isArray(value.deliveries)) {
    errors.push('exceptions.deliveries 必须是数组');
  } else {
    value.deliveries.forEach((item, index) => {
      const parsed = readDelivery(item, index, errors);
      if (parsed) deliveries.push(parsed);
    });
  }
  const ids = new Set<string>();
  for (const exception of [...exceptions, ...deliveries]) {
    if (ids.has(exception.id)) errors.push(`异常记录 id 重复：${exception.id}`);
    ids.add(exception.id);
  }
  if (errors.length > 0) return { status: 'invalid', value: null, errors };
  return { status: 'valid', value: { version: 1, exceptions, deliveries }, errors: [] };
}

export type ExceptionsReadResult =
  | { status: 'missing'; path: string; value: QualityExceptionsV1 }
  | { status: 'invalid'; path: string; errors: string[] }
  | { status: 'valid'; path: string; value: QualityExceptionsV1 };

export function readQualityExceptions(root: string, pathFromContract: string): ExceptionsReadResult {
  const path = join(root, pathFromContract);
  if (!existsSync(path)) {
    return { status: 'missing', path, value: { version: 1, exceptions: [], deliveries: [] } };
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { status: 'invalid', path, errors: ['exceptionsFile 必须是普通文件'] };
    const parsed = parseQualityExceptions(JSON.parse(readFileSync(path, 'utf8')));
    if (parsed.status === 'invalid') return { status: 'invalid', path, errors: parsed.errors };
    return { status: 'valid', path, value: parsed.value };
  } catch (error) {
    return {
      status: 'invalid',
      path,
      errors: [`exceptionsFile 无法读取：${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

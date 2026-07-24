import { createInterface } from 'node:readline/promises';
import type { AgentKind } from '../engine/agent.js';
import {
  readQualityContract,
} from './contract.js';
import {
  runQualityDoctor,
} from './doctor.js';
import {
  publishProjectCheck,
  runProjectQualityGate,
} from './gate.js';
import {
  resolveGitHubToken,
} from './github.js';
import {
  applyQualityInitFiles,
  buildQualityInitPlan,
  configureRemoteQuality,
  previewRemoteQuality,
  renderQualityInitPreview,
} from './init.js';
import {
  resolveGitRoot,
} from './git.js';
import {
  runLocalQualityReview,
} from './local-review.js';
import {
  runGitHubReviewAxis,
} from './remote-review.js';
import {
  exitCodeForQuality,
  type QualityCheck,
  type QualityStatus,
  type ReviewAxis,
} from './types.js';

export type QualityAction = 'init' | 'review' | 'gate' | 'doctor';

export interface QualityCliConfig {
  action: QualityAction;
  workspace: string;
  json: boolean;
  yes: boolean;
  localOnly: boolean;
  remote: boolean;
  checks: boolean;
  axis?: ReviewAxis;
  eventPath?: string;
  contractRef?: string;
  contractFile?: string;
  baseSha?: string;
  headSha?: string;
  publishProjectCheck?: string;
  intentFile?: string;
  baseRef?: string;
  kind: AgentKind;
  model?: string;
  repository?: string;
  defaultBranch?: string;
  initChecks: string[];
  specSources: string[];
  standardsSources: string[];
  releaseRefs: string[];
}

export interface QualityCliIo {
  log(message: string): void;
  error(message: string): void;
  confirm?(prompt: string): Promise<boolean>;
}

function json(message: unknown): string {
  return JSON.stringify(message, null, 2);
}

function statusObject(status: QualityStatus, value: Record<string, unknown>): Record<string, unknown> {
  return { status, ...value };
}

function parseCheck(raw: string): QualityCheck {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('--check 必须是 JSON 对象');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--check 必须是 JSON 对象');
  }
  const candidate = value as Partial<QualityCheck>;
  if (typeof candidate.id !== 'string'
    || typeof candidate.command !== 'string'
    || typeof candidate.cwd !== 'string'
    || !Array.isArray(candidate.paths)
    || !candidate.paths.every((item) => typeof item === 'string')) {
    throw new Error('--check 需要 id、command、cwd 与 paths');
  }
  return {
    id: candidate.id,
    command: candidate.command,
    cwd: candidate.cwd,
    paths: candidate.paths,
  };
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await reader.question(`${prompt} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    reader.close();
  }
}

function output(
  cfg: QualityCliConfig,
  io: QualityCliIo,
  value: Record<string, unknown>,
  human: string,
): void {
  if (cfg.json) io.log(json(value));
  else io.log(human);
}

async function runInit(cfg: QualityCliConfig, io: QualityCliIo): Promise<number> {
  const plan = buildQualityInitPlan(process.cwd(), {
    ...(cfg.initChecks.length > 0 ? { checks: cfg.initChecks.map(parseCheck) } : {}),
    ...(cfg.specSources.length > 0 ? { specSources: cfg.specSources } : {}),
    ...(cfg.standardsSources.length > 0 ? { standardsSources: cfg.standardsSources } : {}),
    ...(cfg.repository ? { repository: cfg.repository } : {}),
    ...(cfg.defaultBranch ? { defaultBranch: cfg.defaultBranch } : {}),
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.releaseRefs.length > 0 ? { releaseRefs: cfg.releaseRefs } : {}),
  });
  const localPreview = renderQualityInitPreview(plan, cfg.localOnly);
  const token = cfg.localOnly ? null : resolveGitHubToken();
  const remotePreview = cfg.localOnly || token === null
    ? null
    : await previewRemoteQuality({ contract: plan.contract, token });
  const preview = [
    localPreview,
    ...(remotePreview ? [
      '远端现状：',
      ...remotePreview.currentRulesets.map((item) =>
        `  - ${item.id}: ${item.name} (${item.target}, ${item.enforcement})`),
      `远端拟管理：${remotePreview.proposedRulesets.join('、')}`,
      `人工批准数：${remotePreview.requiredApprovals}`,
      `检查来源：${remotePreview.integrationId ?? 'unavailable'}`,
      ...remotePreview.errors.map((error) => `  - 无法核验：${error}`),
    ] : !cfg.localOnly ? ['远端现状：缺少 GitHub token，无法预览或配置'] : []),
  ].join('\n');
  if (!cfg.json) io.log(preview);
  const confirmed = cfg.yes
    || await (io.confirm ?? defaultConfirm)('确认写入这些项目文件并应用上述远端规则？');
  if (!confirmed) {
    const value = statusObject('unverifiable', {
      changed: false,
      reason: 'not-confirmed',
      preview,
    });
    output(cfg, io, value, '未确认，未写入任何文件或远端规则。');
    return 2;
  }
  const files = applyQualityInitFiles(plan);
  if (cfg.localOnly) {
    const value = statusObject('unverifiable', {
      changed: files.length > 0,
      files,
      remote: 'not-configured',
    });
    output(
      cfg,
      io,
      value,
      `已写入 ${files.length} 个文件；未配置远端，因此交付状态不可验证。`,
    );
    return 2;
  }
  if (token === null) {
    const value = statusObject('unverifiable', {
      changed: files.length > 0,
      files,
      remote: 'token-missing',
    });
    output(cfg, io, value, '本地文件已写入，但缺少 GitHub token，远端规则未配置。');
    return 2;
  }
  const remoteResult = await configureRemoteQuality({
    contract: plan.contract,
    token,
  });
  const value = statusObject(remoteResult.status, {
    changed: files.length > 0,
    files,
    remote: remoteResult,
  });
  output(
    cfg,
    io,
    value,
    remoteResult.status === 'passed'
      ? `质量门禁已初始化并回读核验：${remoteResult.repository}`
      : `本地文件已写入，但远端门禁不可验证：${remoteResult.errors.join('；')}`,
  );
  return exitCodeForQuality(remoteResult.status);
}

async function runReview(cfg: QualityCliConfig, io: QualityCliIo): Promise<number> {
  if (!cfg.intentFile) throw new Error('quality review 需要 --intent-file');
  const root = resolveGitRoot(process.cwd());
  const contractRead = readQualityContract(root);
  const baseRef = cfg.baseRef
    ?? (contractRead.status === 'valid' ? contractRead.contract.github.defaultBranch : undefined);
  if (!baseRef) throw new Error('无法确定评审基线，请提供 --base-ref');
  const result = await runLocalQualityReview({
    root,
    workspace: cfg.workspace,
    baseRef,
    intentPath: cfg.intentFile,
    kind: cfg.kind,
    ...(cfg.model ? { model: cfg.model } : {}),
  });
  output(
    cfg,
    io,
    result as unknown as Record<string, unknown>,
    `本地质量评审：${result.status}\n结果：${result.summaryPath}\n本地结果不是远端交付凭证。`,
  );
  return exitCodeForQuality(result.status);
}

async function runGate(cfg: QualityCliConfig, io: QualityCliIo): Promise<number> {
  const selected = Number(cfg.checks)
    + Number(cfg.axis !== undefined)
    + Number(cfg.publishProjectCheck !== undefined);
  if (selected !== 1) {
    throw new Error('quality gate 必须且只能选择 --checks、--axis 或 --publish-project-check');
  }
  const root = resolveGitRoot(process.cwd());
  if (cfg.checks) {
    if (!cfg.baseSha || !cfg.headSha) {
      throw new Error('quality gate --checks 需要 --base-sha 与 --head-sha');
    }
    const result = await runProjectQualityGate({
      root,
      workspace: cfg.workspace,
      baseSha: cfg.baseSha,
      headSha: cfg.headSha,
      ...(cfg.contractRef ? { contractRef: cfg.contractRef } : {}),
      ...(cfg.contractFile ? { contractFile: cfg.contractFile } : {}),
    });
    output(
      cfg,
      io,
      result as unknown as Record<string, unknown>,
      `项目检查：${result.receipt.status}`,
    );
    return exitCodeForQuality(result.receipt.status);
  }
  const eventPath = cfg.eventPath ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GitHub 门禁需要 --event-path 或 GITHUB_EVENT_PATH');
  const token = resolveGitHubToken();
  if (!token) throw new Error('GitHub 门禁缺少 GITHUB_TOKEN/GH_TOKEN');
  if (cfg.publishProjectCheck !== undefined) {
    const result = await publishProjectCheck({
      root,
      workspace: cfg.workspace,
      eventPath,
      jobResult: cfg.publishProjectCheck,
      token,
    });
    output(
      cfg,
      io,
      result as unknown as Record<string, unknown>,
      `项目检查发布：${result.receipt.status}`,
    );
    return exitCodeForQuality(result.receipt.status);
  }
  const result = await runGitHubReviewAxis({
    root,
    workspace: cfg.workspace,
    eventPath,
    axis: cfg.axis!,
    token,
  });
  output(
    cfg,
    io,
    result as unknown as Record<string, unknown>,
    `${cfg.axis} 评审：${result.receipt.status}`,
  );
  return exitCodeForQuality(result.receipt.status);
}

async function runDoctor(cfg: QualityCliConfig, io: QualityCliIo): Promise<number> {
  const root = resolveGitRoot(process.cwd());
  const token = cfg.remote ? resolveGitHubToken() ?? undefined : undefined;
  const result = await runQualityDoctor({
    root,
    workspace: cfg.workspace,
    remote: cfg.remote,
    ...(token ? { token } : {}),
  });
  output(
    cfg,
    io,
    result as unknown as Record<string, unknown>,
    [
      `质量门禁诊断：${result.receipt.status}`,
      ...result.checks.map((check) =>
        `${check.status === 'passed' ? '✅' : '❌'} ${check.id}: ${check.message}`),
    ].join('\n'),
  );
  return exitCodeForQuality(result.receipt.status);
}

export async function runQualityCli(
  cfg: QualityCliConfig,
  io: QualityCliIo = {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  },
): Promise<number> {
  try {
    if (cfg.action === 'init') return await runInit(cfg, io);
    if (cfg.action === 'review') return await runReview(cfg, io);
    if (cfg.action === 'gate') return await runGate(cfg, io);
    return await runDoctor(cfg, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cfg.json) io.log(json(statusObject('unverifiable', { error: message })));
    else io.error(`质量门禁不可验证：${message}`);
    return 2;
  }
}

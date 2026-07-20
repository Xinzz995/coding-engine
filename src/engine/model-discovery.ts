import { spawn } from 'node:child_process';
import { resolveBinary, type AgentKind } from './agent.js';

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  isDefault?: boolean;
}

export type ModelDiscoveryResult =
  | { status: 'available'; runner: AgentKind; models: DiscoveredModel[]; source: string }
  | { status: 'unsupported'; runner: AgentKind; reason: string }
  | { status: 'error'; runner: AgentKind; error: string };

interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | null;
}

function commandParts(raw: string): { command: string; prefixArgs: string[] } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] ?? raw, prefixArgs: parts.slice(1) };
}

function runQuiet(commandText: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  const { command, prefixArgs } = commandParts(commandText);
  return new Promise((resolve) => {
    const child = spawn(command, [...prefixArgs, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const done = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ exitCode: null, timedOut: true, spawnError: null });
    }, timeoutMs);
    child.once('error', (err) => done({ exitCode: null, timedOut: false, spawnError: err.message }));
    child.once('exit', (code) => done({ exitCode: code, timedOut: false, spawnError: null }));
  });
}

export async function checkRunnerReady(
  runner: AgentKind,
  timeoutMs = 10_000,
): Promise<{ ready: true } | { ready: false; error: string }> {
  const authArgs = runner === 'claude' ? ['auth', 'status']
    : runner === 'codex' ? ['login', 'status']
    : ['status'];
  const result = await runQuiet(resolveBinary(runner), authArgs, timeoutMs);
  if (result.spawnError) return { ready: false, error: `${runner} CLI 不可执行或未安装` };
  if (result.timedOut) return { ready: false, error: `${runner} 认证状态检查超时` };
  if (result.exitCode !== 0) return { ready: false, error: `${runner} CLI 当前未认证或认证状态不可用` };
  return { ready: true };
}

interface AppServerModel {
  id?: unknown;
  displayName?: unknown;
  isDefault?: unknown;
}

interface RpcMessage {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

/** 通过 Codex 官方 app-server model/list 分页获取当前 provider 的完整可见模型列表。 */
function discoverCodexModels(timeoutMs: number): Promise<ModelDiscoveryResult> {
  const runner: AgentKind = 'codex';
  const { command, prefixArgs } = commandParts(resolveBinary(runner));
  return new Promise((resolve) => {
    const child = spawn(command, [...prefixArgs, 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    let buffer = '';
    let nextId = 2;
    let pendingListId: number | null = null;
    const models: DiscoveredModel[] = [];

    const finish = (result: ModelDiscoveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      resolve(result);
    };
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const requestPage = (cursor?: string) => {
      const id = nextId++;
      pendingListId = id;
      send({ method: 'model/list', id, params: { limit: 100, ...(cursor ? { cursor } : {}) } });
    };
    const fail = (message: string) => finish({ status: 'error', runner, error: message });

    const onMessage = (message: RpcMessage) => {
      if (message.id === 1) {
        if (message.error !== undefined) return fail('Codex app-server 初始化失败');
        send({ method: 'initialized' });
        requestPage();
        return;
      }
      if (pendingListId === null || message.id !== pendingListId) return;
      if (message.error !== undefined) return fail('Codex app-server model/list 查询失败');
      if (!message.result || typeof message.result !== 'object') return fail('Codex app-server model/list 返回形状非法');
      const result = message.result as { data?: unknown; nextCursor?: unknown };
      if (!Array.isArray(result.data)) return fail('Codex app-server model/list 缺少 data 数组');
      for (const raw of result.data as AppServerModel[]) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.trim() === '') continue;
        models.push({
          id: raw.id,
          ...(typeof raw.displayName === 'string' && raw.displayName.trim() !== '' ? { displayName: raw.displayName } : {}),
          ...(typeof raw.isDefault === 'boolean' ? { isDefault: raw.isDefault } : {}),
        });
      }
      if (typeof result.nextCursor === 'string' && result.nextCursor !== '') requestPage(result.nextCursor);
      else {
        const byId = new Map<string, DiscoveredModel>();
        for (const model of models) if (!byId.has(model.id)) byId.set(model.id, model);
        const unique = [...byId.values()];
        if (unique.length === 0) return fail('Codex app-server 未返回可用模型');
        finish({ status: 'available', runner, models: unique, source: 'codex-app-server:model/list' });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line) as RpcMessage); } catch { /* 忽略非协议噪声行 */ }
      }
    });
    child.stdin.on('error', () => fail('Codex app-server 输入通道异常关闭'));
    child.once('error', () => fail('Codex app-server 不可执行'));
    child.once('exit', (code) => {
      if (!settled) fail(`Codex app-server 在完成 model/list 前退出（退出码 ${String(code)}）`);
    });
    const timer = setTimeout(() => fail('Codex app-server model/list 查询超时'), timeoutMs);
    send({
      method: 'initialize', id: 1,
      params: { clientInfo: { name: 'coding_x', title: 'coding-x', version: '0.23.0' } },
    });
  });
}

export async function discoverModels(
  runner: AgentKind,
  opts: { timeoutMs?: number } = {},
): Promise<ModelDiscoveryResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const readiness = await checkRunnerReady(runner, timeoutMs);
  if (!readiness.ready) return { status: 'error', runner, error: readiness.error };
  if (runner === 'codex') return discoverCodexModels(timeoutMs);
  return {
    status: 'unsupported',
    runner,
    reason: runner === 'claude'
      ? 'Claude Code 当前没有公开的机器可读模型枚举接口'
      : 'Cursor CLI 当前没有公开的机器可读模型枚举接口；不会解析交互式 /model',
  };
}

export function renderModelDiscoveryJson(result: ModelDiscoveryResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderModelDiscoveryText(result: ModelDiscoveryResult): string {
  if (result.status === 'error') return `❌ ${result.error}`;
  if (result.status === 'unsupported') return `⚠️  ${result.reason}`;
  const rows = result.models.map((model) => {
    const label = model.displayName && model.displayName !== model.id ? ` — ${model.displayName}` : '';
    return `- ${model.id}${label}${model.isDefault ? '（runner 默认）' : ''}`;
  });
  return [`${result.runner} 当前可用模型：`, ...rows].join('\n');
}

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeReviewTemporaryRetention,
  ReviewTemporaryDirectory,
  ReviewTemporaryDirectoryError,
  type ReviewTemporaryCleanupResult,
} from './temporary-directory.js';

const MAX_CURSOR_PROMPT_BYTES = 16 * 1024;

export type RunnerInvocationKind = 'claude' | 'codex' | 'cursor';

export interface RunnerInvocation {
  readonly root: string;
  readonly proxyPath: string;
  readonly configPath: string;
  readonly temporary: ReviewTemporaryDirectory;
  cleanup(): ReviewTemporaryCleanupResult;
}

function runnerProxyAssetPath(): string {
  const candidates = [
    fileURLToPath(new URL('./workspace-safety/review-runner-proxy.mjs', import.meta.url)),
    fileURLToPath(
      new URL('../../assets/workspace-safety/review-runner-proxy.mjs', import.meta.url),
    ),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error('缺少固定 Runner 代理资产');
  return path;
}

/**
 * Keep complete prompts out of the supervisor DATA record. The supervisor only sees two bounded
 * paths; the fixed proxy verifies the sealed prompt and streams it to Codex/Claude over stdin.
 * Cursor has no stdin prompt contract, so it retains a separately bounded platform argument.
 */
export function createRunnerInvocation(options: {
  runner: RunnerInvocationKind;
  executable: string;
  args: string[];
  cwd: string;
  prompt: string;
  projectRoot: string;
  prefix?: string;
}): RunnerInvocation {
  const promptBytes = Buffer.byteLength(options.prompt);
  if (options.runner === 'cursor' && promptBytes > MAX_CURSOR_PROMPT_BYTES) {
    throw new Error(
      `Cursor 提示词 ${promptBytes} bytes 超过固定参数上限 ` +
        `${MAX_CURSOR_PROMPT_BYTES} bytes；不会截断，请缩小任务或改用支持 stdin 的 Runner`,
    );
  }
  const temporary = ReviewTemporaryDirectory.create({
    prefix: options.prefix ?? 'coding-x-runner-invocation-',
    projectRoot: options.projectRoot,
  });
  const root = temporary.root;
  const proxyPath = join(root, 'review-runner-proxy.mjs');
  const promptPath = join(root, 'prompt.txt');
  const configPath = join(root, 'proxy-config.json');
  try {
    const proxy = readFileSync(runnerProxyAssetPath());
    const prompt = Buffer.from(options.prompt, 'utf8');
    writeFileSync(proxyPath, proxy, { mode: 0o400 });
    writeFileSync(promptPath, prompt, { mode: 0o400 });
    const config = `${JSON.stringify({
      schemaVersion: 1,
      runner: options.runner,
      executable: options.executable,
      args: options.args,
      cwd: resolve(options.cwd),
      promptPath,
      promptMode: options.runner === 'cursor' ? 'argument' : 'stdin',
    })}\n`;
    writeFileSync(configPath, config, { encoding: 'utf8', mode: 0o400 });
    chmodSync(root, 0o500);
    temporary.sealExactTree({
      files: [
        { path: 'review-runner-proxy.mjs', bytes: proxy, maximumBytes: 4 * 1024 * 1024 },
        { path: 'prompt.txt', bytes: prompt, maximumBytes: 3 * 1024 * 1024 },
        { path: 'proxy-config.json', bytes: Buffer.from(config), maximumBytes: 256 * 1024 },
      ],
    });
  } catch (error) {
    const cleanup = temporary.cleanup();
    throw new ReviewTemporaryDirectoryError(
      `${error instanceof Error ? error.message : String(error)}；` +
        (cleanup.status !== 'removed'
          ? `Runner 调用初始化现场${describeReviewTemporaryRetention(cleanup)}：${cleanup.reason}`
          : 'Runner 调用初始化现场已安全清理'),
    );
  }
  return {
    root,
    proxyPath,
    configPath,
    temporary,
    cleanup: () => temporary.cleanup(),
  };
}

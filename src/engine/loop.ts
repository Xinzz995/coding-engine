import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runAgent, type AgentKind } from './agent.js';
import { tryReadPrd, getCurrentStoryId, allStoriesResolved } from './prd.js';
import * as dashboard from '../dashboard/server.js';

export interface LoopConfig {
  kind: AgentKind;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  workspace: string;
  instructionsDir: string;
  port?: number;
  openBrowser?: boolean;
  /** 运行结束后保留仪表盘直到 interrupt（默认 Ctrl+C）；退出码仍是循环的真实结果 */
  keepOpen?: boolean;
  /** keepOpen 的放行信号，默认等待 SIGINT；测试注入用 */
  interrupt?: Promise<void>;
}

function waitForSigint(): Promise<void> {
  return new Promise((resolve) => process.once('SIGINT', () => resolve()));
}

function readInstruction(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf-8');
  } catch {
    return null;
  }
}

// Instruction files use the {{WORKSPACE}} placeholder instead of a hardcoded
// '.workspace/' prefix so a custom --workspace path reaches the agent. The
// agent runs at the project root, and cfg.workspace is resolved the same way
// the engine resolves it (relative to the project root, or absolute), so the
// agent and engine always read/write the same prd.json / progress.md.
export function renderInstruction(text: string, workspace: string): string {
  return text.replaceAll('{{WORKSPACE}}', workspace);
}

export async function runLoop(cfg: LoopConfig): Promise<number> {
  const prdPath = join(cfg.workspace, 'prd.json');
  const builderRaw = readInstruction(cfg.instructionsDir, 'builder.md');
  const validatorRaw = readInstruction(cfg.instructionsDir, 'validator.md');
  const builder = builderRaw === null ? null : renderInstruction(builderRaw, cfg.workspace);
  const validator = validatorRaw === null ? null : renderInstruction(validatorRaw, cfg.workspace);

  const server = dashboard.start({
    workspace: cfg.workspace,
    maxIterations: cfg.maxIterations,
    port: cfg.port,
    openBrowser: cfg.openBrowser ?? true,
  });

  try {
    // Agents must run at the project root (the engine process's cwd), NOT at
    // cfg.workspace. The engine reads/writes prd.json at join(cfg.workspace,
    // 'prd.json'), which for the default relative '.workspace' resolves against
    // the process cwd → <root>/.workspace/prd.json. The builder/validator
    // instructions also read '.workspace/prd.json' and root AGENTS.md/tasks/,
    // assuming cwd == project root. Spawning at cfg.workspace would make the
    // agent resolve '.workspace/prd.json' to <root>/.workspace/.workspace/prd.json,
    // so engine and agent would never share state and the loop would always hit
    // maxIterations. (See loop.test.ts "spawns the agent at the project root".)
    const agentCwd = process.cwd();
    let exitCode = 1;
    for (let i = 1; i <= cfg.maxIterations; i++) {
      const before = tryReadPrd(prdPath);
      const currentStory = before ? getCurrentStoryId(before) : null;
      dashboard.setState({ iteration: i, phase: 'developing', currentStory });

      // Developer
      if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else {
        const dev = await runAgent({
          kind: cfg.kind, prompt: builder, cwd: agentCwd, timeoutMs: cfg.devTimeoutMs,
        });
        if (dev.timedOut) {
          dashboard.setState({ phase: 'idle' });
          continue; // skip validator, retry next iteration
        }
      }

      // Validator
      dashboard.setState({ phase: 'validating' });
      if (validator) {
        await runAgent({
          kind: cfg.kind, prompt: validator, cwd: agentCwd, timeoutMs: cfg.valTimeoutMs,
        });
      }

      // Completion check
      dashboard.setState({ phase: 'idle' });
      const after = tryReadPrd(prdPath);
      if (after && allStoriesResolved(after)) {
        dashboard.setState({ phase: 'done' });
        exitCode = 0;
        break;
      }
    }
    if (cfg.keepOpen) {
      const url = `http://localhost:${server.address().port}`;
      console.log(`\n✅ 运行结束（退出码 ${exitCode}）。仪表盘仍在 ${url} ，按 Ctrl+C 退出。`);
      await (cfg.interrupt ?? waitForSigint());
    }
    return exitCode;
  } finally {
    server.close();
  }
}

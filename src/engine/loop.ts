import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
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
}

function readInstruction(dir: string, file: string): string | null {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

export async function runLoop(cfg: LoopConfig): Promise<number> {
  const prdPath = join(cfg.workspace, 'prd.json');
  const builder = readInstruction(cfg.instructionsDir, 'builder.md');
  const validator = readInstruction(cfg.instructionsDir, 'validator.md');

  const server = dashboard.start({
    workspace: cfg.workspace,
    maxIterations: cfg.maxIterations,
    port: cfg.port,
    openBrowser: cfg.openBrowser ?? true,
  });

  try {
    for (let i = 1; i <= cfg.maxIterations; i++) {
      const before = tryReadPrd(prdPath);
      const currentStory = before ? getCurrentStoryId(before) : null;
      dashboard.setState({ iteration: i, phase: 'developing', currentStory });

      // Developer
      if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else {
        const dev = await runAgent({
          kind: cfg.kind, prompt: builder, cwd: cfg.workspace, timeoutMs: cfg.devTimeoutMs,
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
          kind: cfg.kind, prompt: validator, cwd: cfg.workspace, timeoutMs: cfg.valTimeoutMs,
        });
      }

      // Completion check
      dashboard.setState({ phase: 'idle' });
      const after = tryReadPrd(prdPath);
      if (after && allStoriesResolved(after)) {
        dashboard.setState({ phase: 'done' });
        return 0;
      }
    }
    return 1;
  } finally {
    server.close();
  }
}

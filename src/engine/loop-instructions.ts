import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARBITRATION_PREFIXES, MAX_RETRIES } from './gate.js';

export function readLoopInstruction(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

// Instruction files use the {{WORKSPACE}} placeholder instead of a hardcoded
// '.workspace/' prefix so a custom --workspace path reaches the agent. The
// agent runs at the project root, and cfg.workspace is resolved the same way
// the engine resolves it (relative to the project root, or absolute), so the
// agent and engine always share the same prd.json / state.json / progress.md.
const TDD_WORKFLOW_INSTRUCTION = [
  '',
  '本轮已启用 TDD。读取并遵循已安装的 `tdd` skill；本 story 的 acceptanceCriteria 已获用户批准，',
  '把它们作为行为清单逐项完成真实 RED→GREEN→重构。若 acceptanceCriteria 不足以确定公共行为、',
  '与源码事实冲突或需要新增覆盖排除，使用 [需要人工核实] 并将 story 置 blocked，不自行补意图。',
  '',
].join('\n');

export function renderInstruction(
  text: string,
  workspace: string,
  tddEnabled = false,
): string {
  return text
    .replaceAll('{{WORKSPACE}}', workspace)
    .replaceAll('{{MAX_RETRIES}}', String(MAX_RETRIES))
    .replaceAll('{{ARBITRATION_PREFIXES}}', ARBITRATION_PREFIXES.join('、'))
    .replaceAll('{{TDD_WORKFLOW}}', tddEnabled ? TDD_WORKFLOW_INSTRUCTION : '');
}

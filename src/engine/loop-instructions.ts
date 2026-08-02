import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARBITRATION_PREFIXES, MAX_RETRIES } from './gate.js';

type LoopInstructions = {
  builder: string | null;
  validator: string | null;
};

function readInstruction(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf-8');
  } catch {
    return null;
  }
}

// Instruction files use the {{WORKSPACE}} placeholder instead of a hardcoded
// '.workspace/' prefix so a custom --workspace path reaches the agent. The
// Builder and Validator run at different roots. The caller therefore supplies the absolute,
// lease-authenticated workspace path; a relative CLI spelling must never be reinterpreted after
// Validator changes cwd.
const TDD_WORKFLOW_INSTRUCTION = [
  '',
  '本轮已启用 TDD。读取并遵循已安装的 `tdd` skill；本 story 的 acceptanceCriteria 已获用户批准，',
  '把它们作为行为清单逐项完成真实 RED→GREEN→重构。若 acceptanceCriteria 不足以确定公共行为、',
  '与源码事实冲突或需要新增覆盖排除，使用 [需要人工核实] 并将 story 置 blocked，不自行补意图。',
  '',
].join('\n');

export function readLoopInstructions(instructionsDir: string): LoopInstructions {
  return {
    builder: readInstruction(instructionsDir, 'builder.md'),
    validator: readInstruction(instructionsDir, 'validator.md'),
  };
}

export function renderInstruction(text: string, workspace: string, tddEnabled = false): string {
  return text
    .replaceAll('{{WORKSPACE}}', workspace)
    .replaceAll('{{MAX_RETRIES}}', String(MAX_RETRIES))
    .replaceAll('{{ARBITRATION_PREFIXES}}', ARBITRATION_PREFIXES.join('、'))
    .replaceAll('{{TDD_WORKFLOW}}', tddEnabled ? TDD_WORKFLOW_INSTRUCTION : '');
}

export function renderLoopInstructions(
  instructions: LoopInstructions,
  workspace: string,
  tddEnabled: boolean,
): LoopInstructions {
  return {
    builder:
      instructions.builder === null
        ? null
        : renderInstruction(instructions.builder, workspace, tddEnabled),
    validator:
      instructions.validator === null
        ? null
        : renderInstruction(instructions.validator, workspace, tddEnabled),
  };
}

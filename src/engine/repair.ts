import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { jsonrepair } from 'jsonrepair';

export function repairJsonString(raw: string): string {
  const repaired = jsonrepair(raw);
  const parsed = JSON.parse(repaired); // second validation pass
  return JSON.stringify(parsed, null, 2);
}

export function repairJsonFile(path: string): void {
  const raw = readFileSync(path, 'utf-8');
  const repaired = repairJsonString(raw); // throws before any write if unrepairable
  writeFileSync(path, repaired, 'utf-8');
}

// repair 子命令入口：prd.json 必修；state.json 存在才修（不存在不是错误）。
export function repairWorkspaceFiles(workspace: string): string[] {
  repairJsonFile(join(workspace, 'prd.json'));
  const repaired = ['prd.json'];
  const statePath = join(workspace, 'state.json');
  if (existsSync(statePath)) {
    repairJsonFile(statePath);
    repaired.push('state.json');
  }
  return repaired;
}

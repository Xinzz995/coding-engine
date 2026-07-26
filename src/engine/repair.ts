import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { jsonrepair } from 'jsonrepair';
import { writeFileAtomicSync } from './fs-atomic.js';

export function repairJsonString(raw: string): string {
  const repaired = jsonrepair(raw);
  const parsed: unknown = JSON.parse(repaired); // second validation pass
  return JSON.stringify(parsed, null, 2);
}

// repair 子命令入口：prd.json 必修；state.json 存在才修（不存在不是错误）。
// 全有或全无：先全部读取+修复到内存（任一不可修复在此抛出，此时未写任何文件），
// 再统一原子落盘——避免「prd 已修、state 修不动」的半修复残局成为新的损坏形态。
export function repairWorkspaceFiles(workspace: string): string[] {
  const names = ['prd.json', ...(existsSync(join(workspace, 'state.json')) ? ['state.json'] : [])];
  const pending = names.map((name) => {
    const path = join(workspace, name);
    return { name, path, content: repairJsonString(readFileSync(path, 'utf-8')) };
  });
  for (const { path, content } of pending) writeFileAtomicSync(path, content);
  return pending.map(({ name }) => name);
}

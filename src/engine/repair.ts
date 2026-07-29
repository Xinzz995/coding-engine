import { join } from 'node:path';
import { jsonrepair } from 'jsonrepair';
import { writeFileAtomicSync } from './fs-atomic.js';
import { PRD_CONTROL_FILE_MAX_BYTES } from './prd.js';
import { readSafeControlFileUtf8Sync } from './safe-control-file.js';
import { STATE_CONTROL_FILE_MAX_BYTES } from './state.js';

export function repairJsonString(raw: string): string {
  const repaired = jsonrepair(raw);
  const parsed: unknown = JSON.parse(repaired); // second validation pass
  return JSON.stringify(parsed, null, 2);
}

// repair 子命令入口：prd.json 必修；state.json 存在才修（不存在不是错误）。
// 全有或全无：先全部读取+修复到内存（任一不可修复在此抛出，此时未写任何文件），
// 再统一原子落盘——避免「prd 已修、state 修不动」的半修复残局成为新的损坏形态。
export function repairWorkspaceFiles(workspace: string): string[] {
  const prdPath = join(workspace, 'prd.json');
  const statePath = join(workspace, 'state.json');
  const prd = readSafeControlFileUtf8Sync(prdPath, {
    maxBytes: PRD_CONTROL_FILE_MAX_BYTES,
  });
  const state = readSafeControlFileUtf8Sync(statePath, {
    maxBytes: STATE_CONTROL_FILE_MAX_BYTES,
    allowMissing: true,
  });
  const pending = [
    { name: 'prd.json', path: prdPath, content: repairJsonString(prd!) },
    ...(state === null
      ? []
      : [{ name: 'state.json', path: statePath, content: repairJsonString(state) }]),
  ];
  for (const { path, content } of pending) writeFileAtomicSync(path, content);
  return pending.map(({ name }) => name);
}

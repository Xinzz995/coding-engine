import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

/**
 * 覆盖写的原子替代：写 `<path>.tmp-<pid>` 后 rename（同目录 rename 在 POSIX 原子；
 * win32 renameSync 对已存在目标同样覆盖成功）。进程写入中途被杀只损失 tmp，
 * 目标文件永远是完整旧版或完整新版——半截 JSON 不再可能（2.5h 被 kill 环境坑的风险源）。
 * tmp 命名保留历史 `/.tmp-\d+$/` 形状，仅供非正式兼容写入使用。
 */
export function writeFileAtomicSync(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 尽力清理；失败无害（acquire 时兜底清） */
    }
    throw err;
  }
}

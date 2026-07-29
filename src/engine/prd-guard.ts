import { existsSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
import { join, dirname } from 'node:path';
import { PRD_CONTROL_FILE_MAX_BYTES, type Prd } from './prd.js';
import { readSafeControlFileUtf8Sync } from './safe-control-file.js';

export interface PrdReadResult {
  /** 快照建立后恒为快照解析结果；仅快照未建立且磁盘缺失/损坏时为 null */
  prd: Prd | null;
  /** 本次 read 检测到篡改且快照写回磁盘失败——磁盘仍是篡改版，本轮 validator 不可信 */
  restoreFailed: boolean;
  /**
   * 本次 read 检测到的**新**篡改事件（去重语义与 archives/告警一致）：
   * undefined=无新事件；string=已存档（完整路径）；null=新事件但无存档（删除类或存档写失败）。
   * evidence 记录消费此字段（loop 据此写 tamper 记录）。
   */
  tamperedArchive?: string | null;
}

export interface TamperSummary {
  /** 去重后的篡改事件数（同一磁盘内容反复出现计 1 次） */
  count: number;
  /** 已写入的篡改存档文件路径 */
  archives: string[];
}

export interface PrdGuard {
  read(): PrdReadResult;
  summary(): TamperSummary;
}

function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 运行期 prd.json 冻结守卫（ADR-007）：第一次成功解析时建立快照，此后磁盘变更
 * 一律视为篡改——存档（内容去重）、快照写回恢复、告警（内容去重），read 恒返回快照。
 * 「运行期只读」由此从指令约束变为机械保证（补 ADR-005「不可共谋」的洞：
 * validator 是独立进程直读磁盘，所以恢复必须写回磁盘而不能只用内存快照）。
 */
export function createPrdGuard(prdPath: string): PrdGuard {
  let snapshotRaw: string | null = null;
  let snapshotPrd: Prd | null = null;
  /** 最近一次已处置的篡改内容（null=文件被删的篡改）；undefined=尚无篡改 */
  let lastTampered: string | null | undefined;
  let count = 0;
  const archives: string[] = [];

  function tryReadRaw(): string | null {
    try {
      return readSafeControlFileUtf8Sync(prdPath, {
        maxBytes: PRD_CONTROL_FILE_MAX_BYTES,
        allowMissing: true,
      });
    } catch {
      return null;
    }
  }

  /** 处置篡改：存档（内容去重）→ 快照写回 → 告警（内容去重）。 */
  function handleTamper(raw: string | null): {
    restoreFailed: boolean;
    tamperedArchive?: string | null;
  } {
    const isNew = lastTampered === undefined || raw !== lastTampered;
    let tamperedArchive: string | null | undefined;
    if (isNew) {
      lastTampered = raw;
      count++;
      tamperedArchive = null; // 新事件缺省无存档（删除类/写失败）
      let archiveNote = '文件被删除或不可读';
      if (raw !== null) {
        const base = join(dirname(prdPath), `prd.tampered-${fileStamp(new Date())}`);
        let archivePath = `${base}.json`;
        let seq = 1;
        // fileStamp 仅到秒：同一秒内两种不同篡改内容会撞名互相覆盖，故命中已存在文件时追加序号。
        while (existsSync(archivePath)) {
          archivePath = `${base}-${seq}.json`;
          seq++;
        }
        try {
          // 篡改归档写（原 writeFileSync(archivePath, raw, 'utf-8')）——归档是证据文件，半截=证据损坏
          writeFileAtomicSync(archivePath, raw);
          archives.push(archivePath);
          tamperedArchive = archivePath;
          archiveNote = `篡改版已存档：${archivePath}`;
        } catch (e) {
          archiveNote = `篡改版存档写入失败（${(e as Error).message}）`;
        }
      }
      console.warn(
        `⚠️  检测到 prd.json 在运行期被修改（${archiveNote}）。引擎已按启动快照恢复并继续；` +
          `若是你本人想改需求：停引擎 → 修订源 PRD → prd-to-json 再派生 → 重跑。`,
      );
    }
    try {
      // 快照恢复写（原 writeFileSync(prdPath, snapshotRaw!, 'utf-8')）
      writeFileAtomicSync(prdPath, snapshotRaw!);
      return { restoreFailed: false, tamperedArchive };
    } catch (e) {
      console.warn(
        `⚠️  prd.json 快照写回失败（${(e as Error).message}）：磁盘仍是篡改版，本轮 validator 验收不可信`,
      );
      return { restoreFailed: true, tamperedArchive };
    }
  }

  return {
    read(): PrdReadResult {
      const raw = tryReadRaw();
      if (snapshotRaw === null) {
        if (raw === null) return { prd: null, restoreFailed: false };
        try {
          const parsed = JSON.parse(raw) as Prd;
          snapshotRaw = raw;
          snapshotPrd = parsed;
          return { prd: parsed, restoreFailed: false };
        } catch {
          return { prd: null, restoreFailed: false };
        }
      }
      if (raw === snapshotRaw) return { prd: snapshotPrd, restoreFailed: false };
      const handled = handleTamper(raw);
      return {
        prd: snapshotPrd,
        restoreFailed: handled.restoreFailed,
        tamperedArchive: handled.tamperedArchive,
      };
    },
    summary(): TamperSummary {
      return { count, archives: [...archives] };
    },
  };
}

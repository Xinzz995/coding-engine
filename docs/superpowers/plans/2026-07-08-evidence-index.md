---
title: "evidence 结构化索引实施计划"
status: done
updated: 2026-07-08
scope: root
---

# evidence 结构化索引实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `<workspace>/evidence.jsonl` 结构化证据索引——引擎写机械记录（门禁执行含通过/轮次/篡改），agent 按指令登记截图元数据（AC 级关联），验证报告消费两者并区分信任级别。

**Architecture:** `src/engine/evidence.ts` schema 单源（四类判别联合）+ 纯函数读写；gate/prd-guard 两个前置接口扩展；loop 三处写入（try/catch 吞错，evidence 绝不影响循环）；两指令登记约定；report 四点条件渲染增强（无 evidence 视觉=0.19.0）。规格：`docs/superpowers/specs/2026-07-08-evidence-index-design.md`。

**Tech Stack:** TypeScript strict / ESM（NodeNext）、node:fs 同步 API、Vitest（临时目录 fixture + fake-agent stub）。

## Global Constraints

- `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）。
- 零新增运行时依赖。
- evidence 是增强不是关键路径：引擎写入失败只 warn（去重一次）绝不影响循环退出码；报告在 evidence 缺失时视觉与 0.19.0 完全一致（新区块全部条件渲染）。
- `at` 一律 ISO 时间戳（`new Date().toISOString()`）；报告渲染时转 `YYYY-MM-DD HH:mm` 本地格式。
- `acIndex` 从 1 数起；claim 的 storyId 匹配大小写不敏感。
- 所有进入 HTML 的 evidence 文本走 render.ts 既有 `text()` 兜底（patterns 约定）。
- 每任务提交前 `npm run typecheck` 与 `npm test` 必须全绿。
- 提交说明中文，conventional 前缀（feat:/fix:/docs:）保留英文。
- 版本策略：全部任务完成 + /review-loop 人审通过后发 minor **0.20.0**（Task 7，人审 gate）。

---

### Task 1: `src/engine/evidence.ts` — schema 单源与读写

**Files:**
- Create: `src/engine/evidence.ts`
- Test: `src/engine/evidence.test.ts`

**Interfaces:**
- Consumes: 无（仅 node:fs / node:path）。
- Produces（后续任务依赖的精确签名）:
  - `type EvidenceRecord`（四类判别联合，见下）
  - `type ScreenshotClaim = Extract<EvidenceRecord, { type: 'screenshot-claim' }>`
  - `const EVIDENCE_FILE = 'evidence.jsonl'`
  - `function appendEvidence(workspace: string, record: EvidenceRecord): void`（IO 失败向上抛，调用方定语义）
  - `interface EvidenceReadResult { records: EvidenceRecord[]; skippedLines: number }`
  - `function readEvidence(workspace: string): EvidenceReadResult`（缺文件返回空；坏行/形状非法/未知 type 跳过计数）

- [ ] **Step 1: 写失败测试**

创建 `src/engine/evidence.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvidence, readEvidence, EVIDENCE_FILE, type EvidenceRecord } from './evidence.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gateRun: EvidenceRecord = {
  type: 'gate-run', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 1,
  storyId: 'US-001', ok: true, total: 2, ran: 2, ms: 1234,
};
const claim: EvidenceRecord = {
  type: 'screenshot-claim', source: 'validator', at: '2026-07-08T06:01:00.000Z',
  storyId: 'US-001', file: 'validator-us-001-pass-1.png', acIndex: 1, note: '发布后状态翻转',
};

describe('appendEvidence / readEvidence 往返', () => {
  it('追加多条后按行序读回', () => {
    const dir = ws();
    appendEvidence(dir, gateRun);
    appendEvidence(dir, claim);
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun, claim]);
    expect(r.skippedLines).toBe(0);
  });

  it('文件不存在返回空且零跳过', () => {
    expect(readEvidence(ws())).toEqual({ records: [], skippedLines: 0 });
  });
});

describe('readEvidence 容错', () => {
  it('坏 JSON 行跳过计数，好行照收', () => {
    const dir = ws();
    writeFileSync(join(dir, EVIDENCE_FILE), `${JSON.stringify(gateRun)}\n{ broken\n${JSON.stringify(claim)}\n`);
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun, claim]);
    expect(r.skippedLines).toBe(1);
  });

  it('未知 type 跳过（前向兼容：新版本写的类型旧消费方不炸）', () => {
    const dir = ws();
    writeFileSync(join(dir, EVIDENCE_FILE),
      `${JSON.stringify({ type: 'future-thing', source: 'engine', at: 'x' })}\n${JSON.stringify(claim)}\n`);
    const r = readEvidence(dir);
    expect(r.records).toEqual([claim]);
    expect(r.skippedLines).toBe(1);
  });

  it('已知 type 但字段形状非法跳过（逐字段守卫）', () => {
    const dir = ws();
    const bad1 = { type: 'gate-run', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 'one', storyId: null, ok: true, total: 1, ran: 1, ms: 0 };
    const bad2 = { type: 'screenshot-claim', source: 'someone-else', at: 'x', storyId: 'US-001', file: 'a.png' };
    const bad3 = { type: 'screenshot-claim', source: 'builder', at: 'x', storyId: 'US-001', file: 'a.png', acIndex: '1' };
    writeFileSync(join(dir, EVIDENCE_FILE),
      [bad1, bad2, bad3].map((b) => JSON.stringify(b)).join('\n') + '\n' + JSON.stringify(gateRun) + '\n');
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun]);
    expect(r.skippedLines).toBe(3);
  });

  it('空行与末尾换行不计跳过', () => {
    const dir = ws();
    writeFileSync(join(dir, EVIDENCE_FILE), `\n${JSON.stringify(gateRun)}\n\n`);
    const r = readEvidence(dir);
    expect(r.records).toEqual([gateRun]);
    expect(r.skippedLines).toBe(0);
  });

  it('可选字段缺省的记录合法（claim 无 acIndex/note、gate-run 无 failed*）', () => {
    const dir = ws();
    const minimal: EvidenceRecord = {
      type: 'screenshot-claim', source: 'builder', at: '2026-07-08T06:00:00.000Z',
      storyId: 'US-002', file: 'builder-US-002-1.png',
    };
    appendEvidence(dir, minimal);
    expect(readEvidence(dir).records).toEqual([minimal]);
  });

  it('tamper 与 iteration 记录往返', () => {
    const dir = ws();
    const tamper: EvidenceRecord = { type: 'tamper', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 2, archive: 'prd.tampered-20260708-060000.json' };
    const tamperDeleted: EvidenceRecord = { type: 'tamper', source: 'engine', at: '2026-07-08T06:00:01.000Z', iteration: 2, archive: null };
    const iter: EvidenceRecord = {
      type: 'iteration', source: 'engine', at: '2026-07-08T06:02:00.000Z', iteration: 1, storyId: 'US-001',
      builderRan: true, builderModel: 'fast-m', validatorRan: true, validatorModel: null,
      skippedValidator: false, agentBlocked: false,
    };
    appendEvidence(dir, tamper);
    appendEvidence(dir, tamperDeleted);
    appendEvidence(dir, iter);
    expect(readEvidence(dir).records).toEqual([tamper, tamperDeleted, iter]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/evidence.test.ts`
Expected: FAIL——模块 `./evidence.js` 不存在。

- [ ] **Step 3: 最小实现**

创建 `src/engine/evidence.ts`：

```ts
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * evidence.jsonl 的记录 schema 单源（判别联合）。append-only、每行一条独立 JSON：
 * 坏行只损失自己（agent 写坏一行不毁全文件），行序即事件序。
 * source 是信任级别标记：engine=引擎机械事实；builder/validator=agent 声明
 * （.workspace/ 属 agent 可写区，engine 记录亦可被伪造——消费端呈现层负责诚实标注，
 * 防伪加固属后续评估，见 spec 信任边界）。
 */
export type EvidenceRecord =
  | { type: 'iteration'; source: 'engine'; at: string; iteration: number; storyId: string | null;
      builderRan: boolean; builderModel: string | null; validatorRan: boolean;
      validatorModel: string | null; skippedValidator: boolean; agentBlocked: boolean }
  | { type: 'gate-run'; source: 'engine'; at: string; iteration: number; storyId: string | null;
      ok: boolean; total: number; ran: number; ms: number;
      failedCommand?: string; exitCode?: number | null; timedOut?: boolean }
  | { type: 'tamper'; source: 'engine'; at: string; iteration: number; archive: string | null }
  | { type: 'screenshot-claim'; source: 'builder' | 'validator'; at: string; storyId: string;
      file: string; acIndex?: number; note?: string };

export type ScreenshotClaim = Extract<EvidenceRecord, { type: 'screenshot-claim' }>;

export const EVIDENCE_FILE = 'evidence.jsonl';

/** 追加一条记录（一行 JSON）；IO 失败向上抛——调用方定语义（loop 吞错仅 warn）。 */
export function appendEvidence(workspace: string, record: EvidenceRecord): void {
  appendFileSync(join(workspace, EVIDENCE_FILE), JSON.stringify(record) + '\n', 'utf-8');
}

export interface EvidenceReadResult {
  records: EvidenceRecord[];
  /** JSON 解析失败、形状非法、未知 type 三类行的合计（消费端警示用） */
  skippedLines: number;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 落盘数据不直接类型断言（patterns 约定）：按 type 分支逐字段校验，未知 type 一律不认——
// 前向兼容（新版本引擎写的记录类型，旧版本消费方跳过不炸）。
function isEvidenceRecord(v: unknown): v is EvidenceRecord {
  if (!isRec(v) || typeof v.at !== 'string') return false;
  switch (v.type) {
    case 'iteration':
      return v.source === 'engine' && typeof v.iteration === 'number'
        && (typeof v.storyId === 'string' || v.storyId === null)
        && typeof v.builderRan === 'boolean'
        && (typeof v.builderModel === 'string' || v.builderModel === null)
        && typeof v.validatorRan === 'boolean'
        && (typeof v.validatorModel === 'string' || v.validatorModel === null)
        && typeof v.skippedValidator === 'boolean'
        && typeof v.agentBlocked === 'boolean';
    case 'gate-run':
      return v.source === 'engine' && typeof v.iteration === 'number'
        && (typeof v.storyId === 'string' || v.storyId === null)
        && typeof v.ok === 'boolean' && typeof v.total === 'number'
        && typeof v.ran === 'number' && typeof v.ms === 'number'
        && (v.failedCommand === undefined || typeof v.failedCommand === 'string')
        && (v.exitCode === undefined || v.exitCode === null || typeof v.exitCode === 'number')
        && (v.timedOut === undefined || typeof v.timedOut === 'boolean');
    case 'tamper':
      return v.source === 'engine' && typeof v.iteration === 'number'
        && (typeof v.archive === 'string' || v.archive === null);
    case 'screenshot-claim':
      return (v.source === 'builder' || v.source === 'validator')
        && typeof v.storyId === 'string' && typeof v.file === 'string'
        && (v.acIndex === undefined || typeof v.acIndex === 'number')
        && (v.note === undefined || typeof v.note === 'string');
    default:
      return false;
  }
}

/** 读全部记录；文件缺失（ENOENT）按空处理，其余 IO 故障向上抛（E-T1 审查订正：
 *  EACCES/EISDIR 伪装成「零记录」是审计信道的假阴性——消费方定语义，报告端沿
 *  writeReport 既有 catch 面走「生成失败」而非假装无证据）。 */
export function readEvidence(workspace: string): EvidenceReadResult {
  let raw: string;
  try {
    raw = readFileSync(join(workspace, EVIDENCE_FILE), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], skippedLines: 0 };
    throw err;
  }
  const records: EvidenceRecord[] = [];
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isEvidenceRecord(parsed)) records.push(parsed);
      else skippedLines++;
    } catch {
      skippedLines++;
    }
  }
  return { records, skippedLines };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/evidence.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。

```bash
git add src/engine/evidence.ts src/engine/evidence.test.ts
git commit -m "feat: evidence.jsonl schema 单源与读写——四类判别联合/坏行与未知 type 跳过计数/逐字段守卫（#4 evidence 索引 T1）"
```

---

### Task 2: gate 与 prd-guard 前置接口扩展

**Files:**
- Modify: `src/engine/gate.ts`（GateResult 加 total/ran/ms）
- Modify: `src/engine/prd-guard.ts`（PrdReadResult 加 tamperedArchive）
- Test: `src/engine/gate.test.ts`、`src/engine/prd-guard.test.ts`（各追加）

**Interfaces:**
- Consumes: 无新依赖。
- Produces:
  - `GateResult` 扩展为 `{ ok: boolean; failure: GateFailure | null; total: number; ran: number; ms: number }`——total=配置条数、ran=fail-fast 实际执行到的条数（通过=total）、ms=已执行检查总耗时毫秒。既有消费方（loop 只读 ok/failure）不破坏（gate.test 现有断言全为属性级，已核）。
  - `PrdReadResult` 扩展 `tamperedArchive?: string | null`——**三态**：`undefined`=本次 read 无新篡改事件（含快照路径与重复篡改内容）；`string`=新篡改已存档（完整路径）；`null`=新篡改但无存档（文件删除类，或存档写入失败）。去重语义与 `archives`/告警一致：同一篡改内容反复出现只有首次给值。

- [ ] **Step 1: 写失败测试**

`src/engine/gate.test.ts` 的 `describe('runQualityChecks', …)` 内追加：

```ts
  it('returns total/ran/ms — pass runs all, fail-fast stops at the failing check', async () => {
    const pass = await runQualityChecks(['node -e "process.exit(0)"', 'node -e "process.exit(0)"'], process.cwd());
    expect(pass.ok).toBe(true);
    expect(pass.total).toBe(2);
    expect(pass.ran).toBe(2);
    expect(pass.ms).toBeGreaterThanOrEqual(0);

    const fail = await runQualityChecks(
      ['node -e "process.exit(1)"', 'node -e "process.exit(0)"'], process.cwd());
    expect(fail.ok).toBe(false);
    expect(fail.total).toBe(2);
    expect(fail.ran).toBe(1); // fail-fast：第 1 条失败，第 2 条未执行
  });
```

`src/engine/prd-guard.test.ts` 追加一个 describe（沿用该文件既有的临时目录/写文件基建风格；若文件用别的 helper 名，按现有模式改写——断言语义不变）：

```ts
describe('read().tamperedArchive 三态', () => {
  it('无篡改时为 undefined；新篡改给存档路径；同内容重复篡改回到 undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-ev-'));
    const prdPath = join(dir, 'prd.json');
    const original = JSON.stringify({ project: 'p', userStories: [] });
    writeFileSync(prdPath, original);
    const guard = createPrdGuard(prdPath);
    expect(guard.read().tamperedArchive).toBeUndefined(); // 建快照

    writeFileSync(prdPath, JSON.stringify({ project: 'evil', userStories: [] }));
    const first = guard.read();
    expect(typeof first.tamperedArchive).toBe('string'); // 新篡改：给存档路径
    expect(first.tamperedArchive).toContain('prd.tampered-');

    writeFileSync(prdPath, JSON.stringify({ project: 'evil', userStories: [] }));
    expect(guard.read().tamperedArchive).toBeUndefined(); // 同内容重复：去重不再报

    rmSync(dir, { recursive: true, force: true });
  });

  it('删除类篡改给 null（有新事件但无存档）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-ev-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({ project: 'p', userStories: [] }));
    const guard = createPrdGuard(prdPath);
    guard.read();

    rmSync(prdPath);
    const r = guard.read();
    expect(r.tamperedArchive).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });
});
```

（该测试文件需要的 import——`mkdtempSync/writeFileSync/rmSync/join/tmpdir/createPrdGuard`——与文件现有 import 合并，缺则补。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/gate.test.ts src/engine/prd-guard.test.ts`
Expected: FAIL——`pass.total` 为 undefined；`first.tamperedArchive` 为 undefined（typeof 断言失败）。

- [ ] **Step 3: 实现两处扩展**

`src/engine/gate.ts` 的 `GateResult` 与 `runQualityChecks` 改为：

```ts
export interface GateResult {
  ok: boolean;
  failure: GateFailure | null;
  /** 配置的检查总条数 */
  total: number;
  /** fail-fast 实际执行到的条数（通过=total；失败=失败那条的序号） */
  ran: number;
  /** 已执行检查的总耗时（毫秒） */
  ms: number;
}

/** 逐条 shell 执行质量检查，fail-fast：第一条失败即返回，不跑后续。 */
export async function runQualityChecks(
  checks: string[],
  cwd: string,
  timeoutMs: number = GATE_TIMEOUT_MS,
): Promise<GateResult> {
  const started = Date.now();
  let ran = 0;
  for (const command of checks) {
    ran++;
    const failed = await runOneCheck(command, cwd, timeoutMs);
    if (failed) return { ok: false, failure: failed, total: checks.length, ran, ms: Date.now() - started };
  }
  return { ok: true, failure: null, total: checks.length, ran, ms: Date.now() - started };
}
```

`src/engine/prd-guard.ts`：

`PrdReadResult` 接口改为：

```ts
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
```

`handleTamper` 返回结构化结果（替换原布尔返回）：

```ts
  /** 处置篡改：存档（内容去重）→ 快照写回 → 告警（内容去重）。 */
  function handleTamper(raw: string | null): { restoreFailed: boolean; tamperedArchive?: string | null } {
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
          writeFileSync(archivePath, raw, 'utf-8');
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
      writeFileSync(prdPath, snapshotRaw!, 'utf-8');
      return { restoreFailed: false, tamperedArchive };
    } catch (e) {
      console.warn(`⚠️  prd.json 快照写回失败（${(e as Error).message}）：磁盘仍是篡改版，本轮 validator 验收不可信`);
      return { restoreFailed: true, tamperedArchive };
    }
  }
```

`read()` 的篡改分支改为：

```ts
      if (raw === snapshotRaw) return { prd: snapshotPrd, restoreFailed: false };
      const handled = handleTamper(raw);
      return { prd: snapshotPrd, restoreFailed: handled.restoreFailed, tamperedArchive: handled.tamperedArchive };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/gate.test.ts src/engine/prd-guard.test.ts`
Expected: PASS（含既有全部用例——两个扩展都是加字段，属性级断言不受影响）。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。

```bash
git add src/engine/gate.ts src/engine/gate.test.ts src/engine/prd-guard.ts src/engine/prd-guard.test.ts
git commit -m "feat: evidence 前置接口扩展——GateResult 加 total/ran/ms、PrdReadResult 加 tamperedArchive 三态（#4 evidence 索引 T2）"
```

---

### Task 3: loop.ts 三类机械记录接线

**Files:**
- Modify: `src/engine/loop.ts`
- Test: `src/engine/loop.test.ts`（追加）

**Interfaces:**
- Consumes: `appendEvidence`/`EvidenceRecord`（T1，`./evidence.js`）；`GateResult.total/ran/ms`（T2）；`PrdReadResult.tamperedArchive`（T2）。
- Produces: 循环运行后 `<workspace>/evidence.jsonl` 含 engine 记录——`gate-run`（每次门禁执行，通过与失败都写）、`iteration`（每个走完 validator 段的轮次）、`tamper`（每个新篡改事件，archive 为**文件名**非路径）。写入失败 warn 一次不影响退出码。

**语义说明（写给实现者）**：iteration 记录只覆盖走到轮末的轮——builder 超时轮（无任何记录）与门禁打回轮（有 gate-run 无 iteration）如实缺席，时间线轮号跳跃即「该轮被 continue」，配合 gate-run 可还原打回轮。这是 spec「字段来自 loop 既有局部变量」的直接推论，不要为补齐时间线改动 continue 路径。

- [ ] **Step 1: 写失败测试**

`src/engine/loop.test.ts` 新增 describe（沿用文件既有 setup/story/fakeCounting 基建；import 行补 `readEvidence`——`import { readEvidence } from './evidence.js';`）：

```ts
describe('runLoop evidence records', () => {
  it('writes gate-run (pass) and iteration records for a completing run', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const { records, skippedLines } = readEvidence(workspace);
      expect(skippedLines).toBe(0);
      const gateRuns = records.filter((r) => r.type === 'gate-run');
      expect(gateRuns).toHaveLength(1);
      expect(gateRuns[0]).toMatchObject({ source: 'engine', iteration: 1, storyId: 'US-001', ok: true, total: 1, ran: 1 });
      const iters = records.filter((r) => r.type === 'iteration');
      expect(iters).toHaveLength(1);
      expect(iters[0]).toMatchObject({
        source: 'engine', iteration: 1, storyId: 'US-001',
        builderRan: true, validatorRan: true, skippedValidator: false, agentBlocked: false,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes a failing gate-run and no iteration record for the rolled-back round', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const { fake } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      const { records } = readEvidence(workspace);
      const gateRuns = records.filter((r) => r.type === 'gate-run');
      expect(gateRuns).toHaveLength(1);
      expect(gateRuns[0]).toMatchObject({
        ok: false, total: 1, ran: 1, failedCommand: 'node -e "console.error(\'gate-boom\'); process.exit(7)"',
        exitCode: 7, timedOut: false,
      });
      expect(records.filter((r) => r.type === 'iteration')).toHaveLength(0); // 打回轮 continue，不到轮末
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes a tamper record with the archive filename when builder tampers prd.json', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-tamper-ev.mjs');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, existsSync } from 'node:fs';
      // 只在 prd 未被篡改过时篡改一次，然后翻绿收敛
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      if (prd.project !== 'evil') {
        prd.project = 'evil';
        writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      }
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const { records } = readEvidence(workspace);
      const tampers = records.filter((r) => r.type === 'tamper');
      expect(tampers).toHaveLength(1); // 同内容去重：只记新事件
      expect(tampers[0].archive).toMatch(/^prd\.tampered-.*\.json$/); // 文件名而非路径
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: 新增 3 用例 FAIL（evidence.jsonl 不存在 → records 空）；既有用例保持绿。

- [ ] **Step 3: 实现接线**

`src/engine/loop.ts`：

import 区追加（并入现有相邻 import）：

```ts
import { basename } from 'node:path';   // 并入现有 'node:path' import：{ join } → { join, basename }
import { appendEvidence, type EvidenceRecord } from './evidence.js';
import type { PrdReadResult } from './prd-guard.js';
```

`runLoop` 内、`const agentCwd = process.cwd();` 之后追加两个 helper：

```ts
    // evidence 是增强不是关键路径：写入失败只 warn（去重一次），绝不影响循环
    let warnedEvidence = false;
    const recordEvidence = (record: EvidenceRecord) => {
      try {
        appendEvidence(cfg.workspace, record);
      } catch (err) {
        if (!warnedEvidence) {
          warnedEvidence = true;
          console.warn(`⚠️  evidence 记录写入失败（不影响循环）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    // 每次 guard.read() 都可能检出新篡改事件——三处读取点共用（archive 记文件名，与报告红旗区文件清单对齐）
    const recordTamper = (read: PrdReadResult, iteration: number) => {
      if (read.tamperedArchive !== undefined) {
        recordEvidence({
          type: 'tamper', source: 'engine', at: new Date().toISOString(), iteration,
          archive: read.tamperedArchive === null ? null : basename(read.tamperedArchive),
        });
      }
    };
```

三处 guard.read() 后接 recordTamper：

1. `const beforeRead = guard.read();` 之后加 `recordTamper(beforeRead, i);`
2. `const gateRead = guard.read();` 之后（`if (gateRead.restoreFailed) skipValidator = true;` 之前或之后均可，紧贴 read）加 `recordTamper(gateRead, i);`
3. Completion check 的 `const after = guard.read().prd;` 改为：

```ts
      const afterRead = guard.read();
      recordTamper(afterRead, i);
      const after = afterRead.prd;
```

门禁执行处，`const gate = await runQualityChecks(checks, agentCwd);` 之后（`if (!gate.ok)` 之前）加：

```ts
        recordEvidence({
          type: 'gate-run', source: 'engine', at: new Date().toISOString(), iteration: i,
          storyId: currentStory, ok: gate.ok, total: gate.total, ran: gate.ran, ms: gate.ms,
          ...(gate.failure ? {
            failedCommand: gate.failure.command, exitCode: gate.failure.exitCode, timedOut: gate.failure.timedOut,
          } : {}),
        });
```

Validator 段结束后、`// Completion check` 注释之前加 iteration 记录：

```ts
      // 轮末机械记录：只覆盖走到这里的轮（builder 超时/门禁打回轮已 continue，
      // 时间线轮号跳跃+gate-run 记录即可还原，不为补齐时间线改动 continue 路径）
      recordEvidence({
        type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
        storyId: currentStory,
        builderRan: !!builder,
        builderModel: builderChoice.model ?? null,
        validatorRan: !!validator && !skipValidator && !agentBlocked,
        validatorModel: validatorModel ?? null,
        skippedValidator, agentBlocked,
      });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: PASS（含既有全部用例——特别确认 prd freeze 四用例与 keepOpen 两用例不受影响）。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。

```bash
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: loop 三类机械 evidence 记录——gate-run 含通过/iteration 轮末/tamper 三读取点即时，写入失败仅告警（#4 evidence 索引 T3）"
```

---

### Task 4: 指令层截图登记约定

**Files:**
- Modify: `assets/instructions/builder.md`（截图段之后）
- Modify: `assets/instructions/validator.md`（截图要求节之后）
- Test: `src/engine/loop.test.ts`（instruction assets contract describe 追加）

**Interfaces:**
- Consumes: `{{WORKSPACE}}` 占位符渲染管线（loop.ts renderInstruction，已有）。
- Produces: 两指令含 evidence.jsonl 登记模板；agent 每张最终验证截图追加一行 `screenshot-claim`（schema 与 T1 一致：type/source/at/storyId/file 必填，acIndex（1 起）/note 可选）。

- [ ] **Step 1: 写失败测试**

`src/engine/loop.test.ts` 的 `describe('instruction assets arbitration contract', …)` 之后新增：

```ts
describe('instruction assets evidence contract', () => {
  const read = (f: string) =>
    readFileSync(new URL(`../../assets/instructions/${f}`, import.meta.url), 'utf-8');

  it('builder.md and validator.md carry the screenshot-claim registration template', () => {
    for (const f of ['builder.md', 'validator.md']) {
      const content = read(f);
      expect(content).toContain('evidence.jsonl');
      expect(content).toContain('screenshot-claim');
      expect(content).toContain('从 1 数起'); // acIndex 1-based 明示
      expect(content).toContain('登记失败不阻塞'); // 弱依赖声明
    }
    expect(read('builder.md')).toContain('"source":"builder"');
    expect(read('validator.md')).toContain('"source":"validator"');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: 新 describe FAIL（指令暂无 evidence.jsonl 字样）。

- [ ] **Step 3: 修改两份指令**

`assets/instructions/builder.md`——在「实现完成后的**最终浏览器验证**中……只有最终那次完整验证需要留证。」段落之后插入：

```markdown
每张最终验证截图保存后，向 `{{WORKSPACE}}/evidence.jsonl` 追加一行登记（单行 JSON；`acIndex` 是该截图证明的验收标准在 acceptanceCriteria 列表中的序号，**从 1 数起**，证明不了具体某条时省略该字段；`note` 用一句话说明截图证明了什么）：

    echo '{"type":"screenshot-claim","source":"builder","at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","storyId":"US-XXX","acIndex":1,"file":"builder-US-XXX-1.png","note":"一句话说明"}' >> {{WORKSPACE}}/evidence.jsonl

登记让验证报告能把截图对到具体验收标准；登记失败不阻塞你完成 story（evidence 是证据增强，不是完成条件）。
```

`assets/instructions/validator.md`——在「截图要求」节的文件名格式行（`validator-[story-id]-[pass/fail]-[序号].png`）之后插入：

```markdown
- 每张截图保存后，向 `{{WORKSPACE}}/evidence.jsonl` 追加一行登记（单行 JSON；`acIndex` 是该截图对应的验收标准序号，**从 1 数起**，对不到具体某条时省略；`note` 一句话说明验证了什么）：

      echo '{"type":"screenshot-claim","source":"validator","at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","storyId":"US-XXX","acIndex":1,"file":"validator-us-xxx-pass-1.png","note":"一句话说明"}' >> {{WORKSPACE}}/evidence.jsonl

- 登记失败不阻塞验证流程（evidence 是证据增强，不是验证条件）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。

```bash
git add assets/instructions/builder.md assets/instructions/validator.md src/engine/loop.test.ts
git commit -m "feat: builder/validator 截图登记约定——evidence.jsonl screenshot-claim 单行模板、acIndex 1 起、弱依赖声明（#4 evidence 索引 T4）"
```

---

### Task 5: 验证报告消费 evidence

**Files:**
- Modify: `src/report/report.ts`（ReportData 加 evidence 字段）
- Modify: `src/report/render.ts`（四点增强 + CSS）
- Test: `src/report/report.test.ts`、`src/report/render.test.ts`（各追加）

**Interfaces:**
- Consumes: `readEvidence`/`EvidenceRecord`/`ScreenshotClaim`（T1，`../engine/evidence.js`）。
- Produces: `ReportData` 增 `evidence: { records: EvidenceRecord[]; skippedLines: number }`；渲染增强——门禁执行历史表、AC 证据徽标（storyId 大小写不敏感 + acIndex 1-based 匹配，越界/缺省归 story 级）、画廊登记优先与「未登记」标注、轮次时间线折叠区、孤儿 claim 入未归类区、claim 区免责标注、skippedLines 警示、tamper 记录补充红旗区轮次时刻。全部条件渲染：无 evidence 时输出与 0.19.0 逐字节一致。

- [ ] **Step 1: 写失败测试**

`src/report/report.test.ts` 追加（import 补 `appendEvidence`：`import { appendEvidence } from '../engine/evidence.js';`）：

```ts
describe('collectReport evidence 收集', () => {
  it('读入 evidence.jsonl 记录与跳过计数；缺失时为空', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    const empty = collectReport(dir, new Date());
    if (empty.status !== 'ok') throw new Error('expected ok');
    expect(empty.data.evidence).toEqual({ records: [], skippedLines: 0 });

    appendEvidence(dir, {
      type: 'gate-run', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 1,
      storyId: 'US-001', ok: true, total: 1, ran: 1, ms: 100,
    });
    writeFileSync(join(dir, 'evidence.jsonl'), readFileSync(join(dir, 'evidence.jsonl'), 'utf-8') + '{ bad\n');
    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.evidence.records).toHaveLength(1);
    expect(src.data.evidence.skippedLines).toBe(1);
  });
});
```

（该文件 import 需补 `readFileSync`——已有则跳过。）

`src/report/render.test.ts` 追加（`data()` 工厂已存在；先在其返回对象补默认字段 `evidence: { records: [], skippedLines: 0 },`——**这是对既有工厂的修改**，加进 `...over` 之前）：

```ts
import type { EvidenceRecord } from '../engine/evidence.js';

function ev(records: EvidenceRecord[], skippedLines = 0) {
  return { evidence: { records, skippedLines } };
}

describe('renderReportHtml evidence 增强', () => {
  it('无 evidence 时不出现任何新增区块（与 0.19.0 视觉一致）', () => {
    const html = renderReportHtml(data());
    expect(html).not.toContain('门禁执行历史');
    expect(html).not.toContain('轮次时间线');
    expect(html).not.toContain('agent 声明');
    expect(html).not.toContain('未登记');
    expect(html).not.toContain('evidence.jsonl 有');
  });

  it('gate-run 记录渲染执行历史表：通过与失败两态', () => {
    const html = renderReportHtml(data(ev([
      { type: 'gate-run', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 1, storyId: 'US-001', ok: true, total: 2, ran: 2, ms: 8000 },
      { type: 'gate-run', source: 'engine', at: '2026-07-08T06:10:00.000Z', iteration: 2, storyId: 'US-001', ok: false, total: 2, ran: 1, ms: 500, failedCommand: 'npm test', exitCode: 7, timedOut: false },
    ])));
    expect(html).toContain('门禁执行历史');
    expect(html).toContain('✅ 通过');
    expect(html).toContain('❌ 未通过');
    expect(html).toContain('2/2');
    expect(html).toContain('1/2');
    expect(html).toContain('npm test');
    expect(html).toContain('退出码 7');
  });

  it('claim 按 acIndex（1 起）挂到对应 AC 并带 agent 声明标注与免责行', () => {
    const html = renderReportHtml(data(ev([
      { type: 'screenshot-claim', source: 'validator', at: '2026-07-08T06:00:00.000Z', storyId: 'US-001', file: 'validator-us-001-pass-1.png', acIndex: 1, note: '页面打开成功' },
    ])));
    expect(html).toContain('ac-claim');
    expect(html).toContain('validator-us-001-pass-1.png');
    expect(html).toContain('页面打开成功');
    expect(html).toContain('agent 声明');
    expect(html).toContain('「agent 声明」类证据由 builder/validator 自行登记');
  });

  it('claim 的 storyId 大小写不敏感归对；acIndex 越界或缺省归 story 级登记', () => {
    const html = renderReportHtml(data(ev([
      { type: 'screenshot-claim', source: 'builder', at: '2026-07-08T06:00:00.000Z', storyId: 'us-001', file: 'builder-US-001-1.png', acIndex: 99 },
      { type: 'screenshot-claim', source: 'builder', at: '2026-07-08T06:00:01.000Z', storyId: 'US-001', file: 'builder-US-001-2.png' },
    ])));
    expect(html).toContain('story 级登记');
    expect(html).toContain('builder-US-001-1.png');
    expect(html).toContain('builder-US-001-2.png');
  });

  it('storyId 匹配不到任何 story 的孤儿 claim 落未归类工件区', () => {
    const html = renderReportHtml(data(ev([
      { type: 'screenshot-claim', source: 'builder', at: '2026-07-08T06:00:00.000Z', storyId: 'US-999', file: 'mystery.png', note: '来历不明' },
    ])));
    expect(html).toContain('未归类工件');
    expect(html).toContain('mystery.png');
    expect(html).toContain('US-999');
  });

  it('画廊：有登记的截图排前显示 note，未登记的标「未登记」', () => {
    const shots = [
      { filename: 'builder-US-001-1.png', storyId: 'US-001', phase: 'builder' as const, isImage: true },
      { filename: 'builder-US-001-2.png', storyId: 'US-001', phase: 'builder' as const, isImage: true },
    ];
    const html = renderReportHtml(data({
      screenshots: shots,
      ...ev([
        { type: 'screenshot-claim', source: 'builder', at: '2026-07-08T06:00:00.000Z', storyId: 'US-001', file: 'builder-US-001-2.png', note: '已登记的那张' },
      ]),
    }));
    expect(html).toContain('已登记的那张');
    expect(html).toContain('未登记');
    // 登记的 -2 排在未登记的 -1 之前
    expect(html.indexOf('builder-US-001-2.png')).toBeLessThan(html.indexOf('builder-US-001-1.png'));
  });

  it('iteration 记录渲染轮次时间线折叠区', () => {
    const html = renderReportHtml(data(ev([
      { type: 'iteration', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 1, storyId: 'US-001', builderRan: true, builderModel: 'fast-m', validatorRan: true, validatorModel: 'val-m', skippedValidator: false, agentBlocked: false },
    ])));
    expect(html).toContain('轮次时间线');
    expect(html).toContain('fast-m');
    expect(html).toContain('val-m');
  });

  it('tamper 记录给红旗区补轮次时刻（文件扫描保底仍在）', () => {
    const html = renderReportHtml(data({
      tamperedArchives: ['prd.tampered-20260708-060000.json'],
      ...ev([
        { type: 'tamper', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 3, archive: 'prd.tampered-20260708-060000.json' },
      ]),
    }));
    expect(html).toContain('红旗区');
    expect(html).toContain('第 3 轮');
  });

  it('skippedLines>0 头部警示', () => {
    const html = renderReportHtml(data(ev([], 2)));
    expect(html).toContain('evidence.jsonl 有 2 行无法解析已跳过');
  });

  it('claim 文本转义：note/file 注入不落地', () => {
    const html = renderReportHtml(data(ev([
      { type: 'screenshot-claim', source: 'builder', at: '2026-07-08T06:00:00.000Z', storyId: 'US-001', file: 'a.png', acIndex: 1, note: '<script>alert(1)</script>' },
    ])));
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/report/report.test.ts src/report/render.test.ts`
Expected: FAIL——ReportData 无 evidence 字段（typecheck 层）/新断言找不到目标标记。data() 工厂补字段后既有用例保持绿。

- [ ] **Step 3: 实现**

`src/report/report.ts`：

```ts
// import 区追加：
import { readEvidence, type EvidenceRecord } from '../engine/evidence.js';

// ReportData 追加字段（screenshots 之后）：
  /** evidence.jsonl 结构化证据（缺失=空记录零跳过） */
  evidence: { records: EvidenceRecord[]; skippedLines: number };

// collectReport 的 data 对象追加（screenshots 行之后）：
      evidence: readEvidence(workspace),
```

`src/report/render.ts`——import 区追加：

```ts
import type { EvidenceRecord, ScreenshotClaim } from '../engine/evidence.js';
```

新增五个渲染函数（放在 renderGateConfig 之后）：

```ts
/** ISO at → 本地 YYYY-MM-DD HH:mm；非法输入原样转义呈现（evidence 是 agent 可写区数据） */
function stampOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? text(at) : formatStamp(d);
}

function gateRunsOf(records: EvidenceRecord[]): Extract<EvidenceRecord, { type: 'gate-run' }>[] {
  return records.filter((r): r is Extract<EvidenceRecord, { type: 'gate-run' }> => r.type === 'gate-run');
}

function renderGateHistory(records: EvidenceRecord[]): string {
  const runs = gateRunsOf(records);
  if (runs.length === 0) return '';
  const rows = runs.map((r) => {
    const failNote = r.ok ? '' : `${text(r.failedCommand ?? '')}${r.timedOut ? '（超时）' : r.exitCode !== undefined && r.exitCode !== null ? `（退出码 ${r.exitCode}）` : ''}`;
    return `<tr><td>${r.iteration}</td><td>${text(r.storyId ?? '—')}</td><td>${r.ok ? '✅ 通过' : '❌ 未通过'}</td><td>${r.ran}/${r.total}</td><td>${(r.ms / 1000).toFixed(1)}s</td><td>${stampOf(r.at)}</td><td>${failNote}</td></tr>`;
  }).join('');
  return `<div class="meta-line">门禁执行历史（engine 记录）：</div>` +
    `<table class="evidence-table"><thead><tr><th>轮</th><th>story</th><th>结果</th><th>执行</th><th>耗时</th><th>时刻</th><th>失败摘要</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderTimeline(records: EvidenceRecord[]): string {
  const iters = records.filter((r): r is Extract<EvidenceRecord, { type: 'iteration' }> => r.type === 'iteration');
  if (iters.length === 0) return '';
  const rows = iters.map((r) =>
    `<tr><td>${r.iteration}</td><td>${text(r.storyId ?? '—')}</td><td>${r.builderRan ? text(r.builderModel ?? '默认') : '未跑'}</td><td>${r.validatorRan ? text(r.validatorModel ?? '默认') : (r.agentBlocked ? '跳过（agent blocked）' : r.skippedValidator ? '跳过（快照写回失败）' : '未跑')}</td><td>${stampOf(r.at)}</td></tr>`,
  ).join('');
  return `<section class="card"><details><summary><h2>轮次时间线（engine 记录）</h2></summary>` +
    `<table class="evidence-table"><thead><tr><th>轮</th><th>story</th><th>builder</th><th>validator</th><th>时刻</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="placeholder">仅记录走到轮末的轮；轮号跳跃=该轮被打回或超时（对照门禁执行历史）。</p></details></section>`;
}

function claimLink(c: ScreenshotClaim): string {
  return `<a class="ac-claim" href="${imgSrc(c.file)}" target="_blank" rel="noopener noreferrer"${c.note ? ` title="${text(c.note)}"` : ''}>📎 ${text(c.file)}</a><span class="claim-tag">agent 声明</span>`;
}
```

改造 `renderStoryCard`（签名加第三参 `claims: ScreenshotClaim[]`（该 story 的）与第四参 `anyClaims: boolean`（全局是否存在任何 claim——控制画廊「未登记」标注语境））：

```ts
function renderStoryCard(s: StoryView, shots: ScreenshotEntry[], claims: ScreenshotClaim[], anyClaims: boolean): string {
  const retry = s.retryCount > 0 ? ` <span class="retry">重试 ${s.retryCount} 次</span>` : '';
  // tryReadPrd 无逐字段守卫，acceptanceCriteria 可能形状非法——渲染层兜底为空列表
  const acList = Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria : [];
  // acIndex 从 1 数起；越界（<1 或 >AC 数）与缺省一律归 story 级登记，不静默丢弃
  const isStoryLevel = (c: ScreenshotClaim) => c.acIndex === undefined || c.acIndex < 1 || c.acIndex > acList.length;
  const acs = acList.map((a, idx) => {
    const own = claims.filter((c) => c.acIndex === idx + 1);
    const badges = own.map((c) => ` ${claimLink(c)}${c.note ? `<span class="claim-note">${text(c.note)}</span>` : ''}`).join('');
    return `<li>${text(a)}${badges}</li>`;
  }).join('');
  const storyClaims = claims.filter(isStoryLevel);
  const storyClaimsHtml = storyClaims.length
    ? `<div class="meta-line">story 级登记：${storyClaims.map((c) => `${claimLink(c)}${c.note ? `（${text(c.note)}）` : ''}`).join(' · ')}</div>`
    : '';
  return `<section class="card story">
<h3>${text(s.id)} ${text(s.title)} ${storyBadge(s)}${retry}</h3>
<ul class="acs">${acs}</ul>
${storyClaimsHtml}
${renderNotes(s.notes)}
${renderGallery(shots, anyClaims ? new Set(claims.map((c) => c.file)) : null)}
</section>`;
}
```

改造 `renderShotFigure` 与 `renderGallery`。**「未登记」语义**：只有全局存在任何 claim（本轮有登记习惯）时，未登记才是有信息量的对账信号——全局零 claim 时不标注也不排序，保证无 evidence 输出与 0.19.0 逐字节一致（`claimedFiles === null` 表示「无 claim 语境」）：

```ts
function renderShotFigure(s: ScreenshotEntry, markUnclaimed: boolean): string {
  const name = text(s.filename);
  const tag = markUnclaimed ? '<span class="unclaimed">未登记</span>' : '';
  if (!s.isImage) {
    // download：非图片附件（pdf 等）不应在浏览器内联打开而应强制下载；
    // rel 防 target="_blank" 的反向 window.opener 访问——此处非 _blank 也一并加固，成本为零
    return `<div class="artifact-link"><a href="${imgSrc(s.filename)}" download rel="noopener noreferrer">📎 ${name}</a>${tag}</div>`;
  }
  return `<figure class="shot"><a href="${imgSrc(s.filename)}" target="_blank" rel="noopener noreferrer"><img src="${imgSrc(s.filename)}" alt="${name}" loading="lazy"></a><figcaption>${name}${tag}</figcaption></figure>`;
}

// claimedFiles=null：全局无任何 claim（无 evidence 或无登记）——不标注不排序，视觉与 0.19.0 一致
function renderGallery(shots: ScreenshotEntry[], claimedFiles: ReadonlySet<string> | null = null): string {
  if (shots.length === 0) return '';
  const groups = [
    { phase: 'builder' as const, label: 'builder 截图' },
    { phase: 'validator' as const, label: 'validator 截图' },
  ];
  const parts: string[] = [];
  for (const g of groups) {
    const own = shots.filter((s) => s.phase === g.phase);
    if (own.length === 0) continue;
    // 登记优先：有 claim 的排前（组内稳定排序，登记态相同保持名序）；无 claim 语境保持名序
    const sorted = claimedFiles === null ? own
      : [...own].sort((a, b) => Number(claimedFiles.has(b.filename)) - Number(claimedFiles.has(a.filename)));
    parts.push(
      `<div class="gallery-group"><div class="gallery-label">${g.label}（${own.length}）</div>` +
      `<div class="gallery">${sorted.map((s) => renderShotFigure(s, claimedFiles !== null && !claimedFiles.has(s.filename))).join('')}</div></div>`,
    );
  }
  return parts.join('');
}
```

注意两处调用方同步：`renderUnattributed` 内改为 `renderShotFigure(s, false)`（未归类区不叠「未登记」标注——它已在未归类区，双重标注是噪音）；`renderStoryCard` 传给 `renderGallery` 的第二参为 `anyClaims ? new Set(claims.map((c) => c.file)) : null`——`anyClaims` 是全局是否存在 claim 的布尔，经 `renderStoryCard` 第四参传入（见下方签名修正）。

改造 `renderUnattributed`（加孤儿 claim 参数）：

```ts
function renderUnattributed(shots: ScreenshotEntry[], orphanClaims: ScreenshotClaim[]): string {
  const orphan = shots.filter((s) => s.storyId === null);
  if (orphan.length === 0 && orphanClaims.length === 0) return '';
  const claimLines = orphanClaims.map((c) =>
    `<div class="artifact-link">${claimLink(c)}（登记 storyId：<code>${text(c.storyId)}</code> 未匹配任何 story）${c.note ? ` ${text(c.note)}` : ''}</div>`,
  ).join('');
  return `<section class="card"><h2>未归类工件</h2><div class="gallery">${orphan.map((s) => renderShotFigure(s, false)).join('')}</div>${claimLines}</section>`;
}
```

改造 `renderRedFlags`（tamper 记录补轮次时刻）：

```ts
function renderRedFlags(tampered: string[], records: EvidenceRecord[]): string {
  const tamperEvents = records.filter((r): r is Extract<EvidenceRecord, { type: 'tamper' }> => r.type === 'tamper');
  if (tampered.length === 0 && tamperEvents.length === 0) return '';
  const eventOf = new Map(tamperEvents.filter((t) => t.archive !== null).map((t) => [t.archive as string, t]));
  const files = tampered.map((f) => {
    const ev = eventOf.get(f);
    return `<li><code>${text(f)}</code>${ev ? `（第 ${ev.iteration} 轮 ${stampOf(ev.at)} 检出）` : ''}</li>`;
  }).join('');
  const deletions = tamperEvents.filter((t) => t.archive === null).map((t) =>
    `<li>第 ${t.iteration} 轮 ${stampOf(t.at)} 检出删除类篡改（无存档）</li>`,
  ).join('');
  return `<section class="card red-flag">
<h2>🚩 红旗区：运行期篡改存档</h2>
<p>运行期间 prd.json 被修改过，引擎已按启动快照恢复并存档（ADR-007）。合并裁决前请逐个核对：</p>
<ul>${files}${deletions}</ul>
<p>指引：<code>diff</code> 存档与 <code>prd.json</code>，核对运行期被改了什么；与预期不符须停止合并。</p>
</section>`;
}
```

`renderReportHtml` 主装配改造：

```ts
export function renderReportHtml(data: ReportData): string {
  const { prd, stories } = data;
  const byStory = new Map<string, ScreenshotEntry[]>();
  for (const s of data.screenshots) {
    if (s.storyId === null) continue;
    const list = byStory.get(s.storyId) ?? [];
    list.push(s);
    byStory.set(s.storyId, list);
  }
  // claim 归属：storyId 大小写不敏感匹配（对齐 parseScreenshotEntry 先例）；匹配不到的落未归类
  const allClaims = data.evidence.records.filter((r): r is ScreenshotClaim => r.type === 'screenshot-claim');
  const idByLower = new Map(stories.map((s) => [String(s.id).toLowerCase(), s.id]));
  const claimsByStory = new Map<string, ScreenshotClaim[]>();
  const orphanClaims: ScreenshotClaim[] = [];
  for (const c of allClaims) {
    const realId = idByLower.get(c.storyId.toLowerCase());
    if (realId === undefined) { orphanClaims.push(c); continue; }
    const list = claimsByStory.get(realId) ?? [];
    list.push(c);
    claimsByStory.set(realId, list);
  }
  const cards = stories.map((s) => renderStoryCard(s, byStory.get(s.id) ?? [], claimsByStory.get(s.id) ?? [], allClaims.length > 0)).join('\n');
  const claimDisclaimer = allClaims.length > 0
    ? '<p class="placeholder">「agent 声明」类证据由 builder/validator 自行登记，真实性以截图内容与 git 历史为准。</p>'
    : '';
  const stateWarn = data.stateCorrupted
    ? '<div class="meta-line warn">⚠️ state.json 已损坏，已按 prd.json 内嵌旧格式状态回退显示，可能非最新执行结果（建议 npx coding-x repair）</div>'
    : '';
  const evidenceWarn = data.evidence.skippedLines > 0
    ? `<div class="meta-line warn">⚠️ evidence.jsonl 有 ${data.evidence.skippedLines} 行无法解析已跳过</div>`
    : '';
  const title = `${text(prd.project)} · 验证报告`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
<header class="card">
<h1>${title}</h1>
${renderBanner(stories)}
<div class="meta-line">分支：<code>${text(prd.branchName)}</code>${prd.sourcePrd ? ` · 源 PRD：<code>${text(prd.sourcePrd)}</code>` : ''}</div>
<div class="meta-line">生成时间：${formatStamp(data.generatedAt)} · workspace：<code>${text(data.workspace)}</code></div>
${stateWarn}
${evidenceWarn}
${renderGateConfig(data)}
${renderGateHistory(data.evidence.records)}
${renderModels(data)}
<div class="meta-line">统计：${stories.length} story · ${data.screenshots.length} 个截图工件 · ${data.reviews.length} 份人审留痕</div>
</header>
${renderRedFlags(data.tamperedArchives, data.evidence.records)}
<h2 class="section-title">story 证据</h2>
${claimDisclaimer}
${cards}
${renderUnattributed(data.screenshots, orphanClaims)}
${renderTimeline(data.evidence.records)}
${renderReviews(data.reviews)}
${renderProgressSection(data.progress)}
<footer>由 coding-x report 生成 · ${formatStamp(data.generatedAt)}</footer>
</main>
</body>
</html>`;
}
```

`REPORT_CSS` 末尾（`footer` 规则之后）追加：

```css
.evidence-table { border-collapse: collapse; font-size: 12px; margin: 6px 0 10px; }
.evidence-table th, .evidence-table td { border: 1px solid var(--border); padding: 4px 10px; text-align: left; }
.evidence-table th { background: hsl(240 4% 93%); font-weight: 600; }
.ac-claim { font-size: 12px; margin-left: 6px; word-break: break-all; }
.claim-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: hsl(36 100% 50% / 0.15); color: hsl(36 100% 32%); margin-left: 4px; vertical-align: middle; }
.claim-note { font-size: 12px; color: var(--muted); margin-left: 6px; }
.unclaimed { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: hsl(0 0% 72% / 0.25); color: var(--muted); margin-left: 4px; vertical-align: middle; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/report/report.test.ts src/report/render.test.ts`
Expected: PASS（含既有全部用例——「无 evidence 视觉一致」用例守住 0.19.0 兼容）。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。cli.test 与 loop.test 中经由 writeReport 的端到端用例不受影响（evidence 字段全容错）。

```bash
git add src/report/report.ts src/report/report.test.ts src/report/render.ts src/report/render.test.ts
git commit -m "feat: 验证报告消费 evidence——门禁执行历史/AC 证据对账/登记优先画廊/轮次时间线/红旗区轮次时刻，agent 声明与未登记诚实标注（#4 evidence 索引 T5）"
```

---

### Task 6: prd-to-json 归档清单 + 文档同步

**Files:**
- Modify: `skills/prd-to-json/SKILL.md`（「归档之前的运行」节）
- Modify: `README.md`、`docs/architecture.md`

**Interfaces:**
- Consumes: 无代码接口；T1-T5 的行为事实。
- Produces: 文档与归档约定同步。

- [ ] **Step 1: prd-to-json 归档清单**

`skills/prd-to-json/SKILL.md` 「归档之前的运行」节——把复制清单行：

```
   - 将当前的 `prd.json`、`state.json`（如存在）、`progress.md` 和 `review-*.md` 留痕文件（如存在）复制到归档
```

改为：

```
   - 将当前的 `prd.json`、`state.json`、`progress.md`、`review-*.md` 留痕、`evidence.jsonl`、`report.html` 与 `screenshots/` 目录（均为如存在）复制到归档
```

「删除工作区中的旧 `state.json`」条目之后追加一条：

```
   - **同时删除工作区中的旧 `evidence.jsonl`**——记录按轮次追加且不含轮次归属标识以外的运行标记，残留旧轮记录会污染新轮验证报告的门禁历史与时间线
```

- [ ] **Step 2: README 与 architecture.md**

`README.md`：
1. 特性列表「静态验证报告」条目内，在「篡改红旗区汇总为零依赖单页」之后补一句：「0.20.0 起叠加 evidence 结构化索引：门禁执行历史（含通过轮）、轮次时间线、截图↔验收标准对账（agent 登记，报告诚实标注信任级别）」。
2. `.workspace` 相关目录结构/产物描述处（第 30 行附近数据流段），在提到三份文件的句子后补：「`evidence.jsonl`（结构化证据索引：引擎机械记录+agent 截图登记，0.20.0 起）」。

`docs/architecture.md`：
1. 模块表「prd 守卫」行之后插入一行：

```markdown
| 证据索引 | `src/engine/evidence.ts` | evidence.jsonl 的 schema 单源（iteration/gate-run/tamper/screenshot-claim 四类判别联合）与追加/读取（坏行与未知 type 跳过计数）；loop 写机械记录，builder/validator 按指令登记截图，验证报告消费并按 source 区分信任级别 |
```

2. 「数据流」节验证报告句子之前补一句：「循环运行期引擎向 `evidence.jsonl` 追加机械证据（门禁执行含通过、轮次事件、篡改事件），agent 按指令登记截图元数据（AC 级关联）——append-only、坏行只损失自己。」
3. frontmatter `updated:` 刷新为提交当日。

- [ ] **Step 3: 全量回归 + 提交**

Run: `npm run typecheck && npm test && node dist/cli.js doctor 2>&1 | tail -3`
Expected: 双绿 + doctor 全部通过（doctor 用旧 dist 亦可，仅查文档健康）。

```bash
git add skills/prd-to-json/SKILL.md README.md docs/architecture.md
git commit -m "docs: evidence 归档清单与文档同步——prd-to-json 归档补 evidence.jsonl/report.html/screenshots 并删旧 evidence，README/架构地图登记（#4 evidence 索引 T6）"
```

---

### Task 7: 发版 0.20.0（前置：人审通过）

**前置 gate：本任务只在 /review-loop 人审 + 用户裁决放行之后执行，不随 T1-T6 连跑。**

**Files:**
- Modify: `docs/superpowers/specs/2026-07-08-evidence-index-design.md`（status → done）
- Modify: `docs/superpowers/plans/2026-07-08-evidence-index.md`（status → done）
- `package.json` 等版本落点由 `npm version` 钩子自动同步，不手改。

- [ ] **Step 1: 终验**

Run: `npm run typecheck && npm test && npm run build`
Expected: 三绿。

- [ ] **Step 2: 真实 workspace 冒烟**

Run:
```bash
node dist/cli.js report --workspace .superpowers/fixtures/study-report-dogfood/.workspace
```
Expected: 退出码 0（fixture 无 evidence.jsonl → 报告与 0.19.0 视觉一致，无新区块）。再手工造最小 evidence 验证增强区：

```bash
WS=.superpowers/fixtures/study-report-dogfood/.workspace
printf '%s\n' '{"type":"gate-run","source":"engine","at":"2026-07-08T06:00:00.000Z","iteration":1,"storyId":"US-001","ok":true,"total":2,"ran":2,"ms":8000}' '{"type":"screenshot-claim","source":"validator","at":"2026-07-08T06:01:00.000Z","storyId":"US-001","acIndex":1,"file":"validator-us-001-pass-1.png","note":"冒烟登记"}' > "$WS/evidence.jsonl"
node dist/cli.js report --workspace "$WS"
grep -c "门禁执行历史\|agent 声明\|冒烟登记" "$WS/report.html"
```
Expected: 匹配数 ≥3（三个标记都渲染）。冒烟后清理：`rm "$WS/evidence.jsonl" "$WS/report.html"`（fixture 不留生成物）。

- [ ] **Step 3: 文档状态收尾**

spec 与本计划 frontmatter `status: active` → `done`、`updated` 刷新；提交：

```bash
git add docs/superpowers/specs/2026-07-08-evidence-index-design.md docs/superpowers/plans/2026-07-08-evidence-index.md
git commit -m "docs: evidence 索引 spec/plan 交付置 done"
```

- [ ] **Step 4: 发版**

```bash
npm version minor -m "release: v%s"
git push --follow-tags
```

Expected: 版本落 0.20.0，钩子同步三插件清单与 lock；push 后**停手**——publish 与 GitHub Release 归 tag 触发的 CI（0.14.3 教训）。

- [ ] **Step 5: CI 确认**

Run: `gh run list --limit 3` 稍后 `npm view coding-x version`
Expected: Test+Publish 双绿、npm 显示 0.20.0。

---

## Self-Review（计划完成后自检记录）

1. **Spec coverage**：schema 四类+守卫+前向兼容→T1；GateResult/PrdReadResult 扩展→T2；loop 三处写入+吞错→T3；两指令登记模板+1-based 明示+弱依赖→T4；报告四点增强+大小写不敏感+越界归 story 级+孤儿 claim+免责+skippedLines+tamper 轮次→T5；归档清单+README/架构→T6；0.20.0→T7；非目标（status 消费/repair/逐条计时/防伪/内容校验）未出现在任何任务 ✓。
2. **Placeholder scan**：全任务代码完整可抄，无 TBD/「适当处理」✓。
3. **Type consistency**：`EvidenceRecord`/`ScreenshotClaim`/`EvidenceReadResult`/`appendEvidence(workspace, record)`/`readEvidence(workspace)` 贯穿 T1/T3/T5 一致；`GateResult.total/ran/ms` 与 T3 的 gate-run 字段一致；`PrdReadResult.tamperedArchive` 三态与 T3 recordTamper 判定一致；T5 的 `renderStoryCard(s, shots, claims, anyClaims)`/`renderGallery(shots, claimedFiles: Set|null)`/`renderShotFigure(s, markUnclaimed)`/`renderUnattributed(shots, orphanClaims)`/`renderRedFlags(tampered, records)` 签名在实现与全部调用处一致（含「全局零 claim 不标未登记」的 null 语境链路：主装配 `allClaims.length > 0` → 卡片第四参 → 画廊 null → figure false）✓。自检修正记录：初稿 `renderGallery` 空集合缺省会让无 evidence 时全部截图标「未登记」，破坏 0.19.0 视觉一致承诺——已改为 null 语境三处联动。

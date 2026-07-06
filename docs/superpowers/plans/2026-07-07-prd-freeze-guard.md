# prd.json 运行期冻结（门禁配置防篡改）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引擎运行期把 prd.json 冻结为启动快照——agent/外部进程的磁盘篡改被自动检测、存档、恢复、告警，堵死「builder 改 prd.json 架空门禁/验收/完成判定」三个漏洞面（规格：`docs/superpowers/specs/2026-07-07-prd-freeze-guard-design.md`）。

**Architecture:** 新模块 `src/engine/prd-guard.ts` 提供 `createPrdGuard(prdPath)` 闭包，持有快照（原始字符串 + 解析对象）；`read()` 做「读磁盘 → 字符串全等比较 → 不一致则存档+写回+告警 → 恒返快照」。loop.ts 现有三处 `tryReadPrd` 收口为 `guard.read()` 并在 builder 后新增第四检测点（validator 拉起前必须恢复磁盘）；写回失败的轮次跳过 validator。

**Tech Stack:** TypeScript（strict, ESM）、node:fs、Vitest（测试与源码同目录）。

## Global Constraints

- `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）
- 提交前必须通过 `npm run typecheck` 与 `npm test`
- 提交说明中文，conventional 前缀保留英文（feat:/fix:/docs:/release:）
- 引擎运行时状态只读写 `--workspace` 目录（存档文件写在 prdPath 同目录，即 workspace 内）
- 面向用户的行为变更升 minor 版本并同步 README（本计划 0.16.0 → 0.17.0）
- 代码注释只写代码本身讲不出的约束，密度跟随现有文件（gate.ts/loop.ts 风格）

---

### Task 1: prd-guard 模块（快照、检测、存档、恢复、告警）

**Files:**
- Create: `src/engine/prd-guard.ts`
- Test: `src/engine/prd-guard.test.ts`

**Interfaces:**
- Consumes: `Prd` 类型（`./prd.js`，已存在）
- Produces（Task 2 依赖，签名务必一致）:
  ```typescript
  export interface PrdReadResult {
    prd: Prd | null;          // 快照建立后恒为快照解析结果；仅快照未建立且磁盘缺失/损坏时 null
    restoreFailed: boolean;   // 本次 read 检测到篡改且快照写回失败——磁盘仍是篡改版
  }
  export interface TamperSummary {
    count: number;            // 去重后的篡改事件数（同一磁盘内容反复出现计 1 次）
    archives: string[];       // 已写入的篡改存档文件路径
  }
  export interface PrdGuard {
    read(): PrdReadResult;
    summary(): TamperSummary;
  }
  export function createPrdGuard(prdPath: string): PrdGuard;
  ```

- [ ] **Step 1: 写失败测试（第一批：快照建立与一致读取）**

创建 `src/engine/prd-guard.test.ts`：

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrdGuard } from './prd-guard.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
  vi.restoreAllMocks();
});

function setup(content?: string): { dir: string; prdPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prd-guard-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const prdPath = join(dir, 'prd.json');
  if (content !== undefined) writeFileSync(prdPath, content);
  return { dir, prdPath };
}

const PRD = JSON.stringify({
  project: 'p', branchName: 'ralph/x', description: 'd',
  qualityChecks: ['npm test'],
  userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: ['原始验收标准'], priority: 1 }],
});

describe('createPrdGuard: 快照建立与一致读取', () => {
  it('第一次成功读取建立快照并返回解析结果', () => {
    const { prdPath } = setup(PRD);
    const guard = createPrdGuard(prdPath);
    const r = guard.read();
    expect(r.prd?.qualityChecks).toEqual(['npm test']);
    expect(r.restoreFailed).toBe(false);
    expect(guard.summary().count).toBe(0);
  });

  it('磁盘未变时重复读取返回快照且不告警', () => {
    const { prdPath } = setup(PRD);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    const r = guard.read();
    expect(r.prd?.project).toBe('p');
    expect(warn).not.toHaveBeenCalled();
  });

  it('启动缺失返回 null；文件出现后顺延建立快照', () => {
    const { prdPath } = setup(); // 不写文件
    const guard = createPrdGuard(prdPath);
    expect(guard.read().prd).toBeNull();
    writeFileSync(prdPath, PRD);
    expect(guard.read().prd?.project).toBe('p');
  });

  it('启动损坏（非法 JSON）返回 null 不建快照，修好后建立', () => {
    const { prdPath } = setup('{ broken');
    const guard = createPrdGuard(prdPath);
    expect(guard.read().prd).toBeNull();
    writeFileSync(prdPath, PRD);
    expect(guard.read().prd?.project).toBe('p');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/engine/prd-guard.test.ts`
Expected: FAIL——`Cannot find module './prd-guard.js'`（或等价的模块不存在错误）

- [ ] **Step 3: 最小实现（快照与一致路径，篡改路径先占位返回快照不处置）**

创建 `src/engine/prd-guard.ts`：

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Prd } from './prd.js';

export interface PrdReadResult {
  /** 快照建立后恒为快照解析结果；仅快照未建立且磁盘缺失/损坏时为 null */
  prd: Prd | null;
  /** 本次 read 检测到篡改且快照写回磁盘失败——磁盘仍是篡改版，本轮 validator 不可信 */
  restoreFailed: boolean;
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
      return readFileSync(prdPath, 'utf-8');
    } catch {
      return null;
    }
  }

  function handleTamper(raw: string | null): boolean {
    return false; // Task 1 Step 5 实现
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
      const restoreFailed = handleTamper(raw);
      return { prd: snapshotPrd, restoreFailed };
    },
    summary(): TamperSummary {
      return { count, archives: [...archives] };
    },
  };
}
```

- [ ] **Step 4: 运行第一批测试确认通过**

Run: `npx vitest run src/engine/prd-guard.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: 写失败测试（第二批：篡改处置——存档/恢复/告警/去重/写回失败）**

追加到 `src/engine/prd-guard.test.ts`：

```typescript
describe('createPrdGuard: 篡改处置', () => {
  it('篡改后 read 返回快照、磁盘被恢复、篡改版被存档', () => {
    const { dir, prdPath } = setup(PRD);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read(); // 建快照
    const tampered = PRD.replace('原始验收标准', '被改弱的标准');
    writeFileSync(prdPath, tampered);
    const r = guard.read();
    expect(r.prd?.userStories[0].acceptanceCriteria).toEqual(['原始验收标准']); // 返回快照
    expect(r.restoreFailed).toBe(false);
    expect(readFileSync(prdPath, 'utf-8')).toBe(PRD); // 磁盘已恢复
    const archived = readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'));
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(dir, archived[0]), 'utf-8')).toBe(tampered); // 存档=篡改版
    expect(warn).toHaveBeenCalled();
    expect(guard.summary().count).toBe(1);
    expect(guard.summary().archives).toHaveLength(1);
  });

  it('同一篡改内容反复出现只存档一次、只告警一次（写回后再次同内容篡改）', () => {
    const { dir, prdPath } = setup(PRD);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    const tampered = PRD.replace('npm test', 'echo skip');
    writeFileSync(prdPath, tampered);
    guard.read(); // 第一次：存档+告警+恢复
    writeFileSync(prdPath, tampered);
    guard.read(); // 同内容再现：不再存档/告警，仍恢复
    expect(readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'))).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('检测到 prd.json'))).toHaveLength(1);
    expect(readFileSync(prdPath, 'utf-8')).toBe(PRD);
    expect(guard.summary().count).toBe(1);
  });

  it('不同篡改内容各自存档、各自计数', () => {
    const { dir, prdPath } = setup(PRD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    writeFileSync(prdPath, PRD.replace('npm test', 'echo a'));
    guard.read();
    writeFileSync(prdPath, PRD.replace('npm test', 'echo b'));
    guard.read();
    expect(readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'))).toHaveLength(2);
    expect(guard.summary().count).toBe(2);
  });

  it('快照建立后文件被删：按篡改处置，恢复文件、无存档（无内容可存）', () => {
    const { dir, prdPath } = setup(PRD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    unlinkSync(prdPath);
    const r = guard.read();
    expect(r.prd?.project).toBe('p');
    expect(r.restoreFailed).toBe(false);
    expect(readFileSync(prdPath, 'utf-8')).toBe(PRD); // 文件被恢复
    expect(readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'))).toHaveLength(0);
    expect(guard.summary().count).toBe(1);
  });

  it('快照建立后文件损坏（非法 JSON）：损坏内容存档、磁盘恢复', () => {
    const { dir, prdPath } = setup(PRD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    writeFileSync(prdPath, '{ broken');
    const r = guard.read();
    expect(r.prd?.project).toBe('p');
    expect(readFileSync(prdPath, 'utf-8')).toBe(PRD);
    const archived = readdirSync(dir).filter((f) => f.startsWith('prd.tampered-'));
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(dir, archived[0]), 'utf-8')).toBe('{ broken');
  });

  it('写回失败时 restoreFailed=true（prd.json 被替换为同名目录）', () => {
    const { prdPath } = setup(PRD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createPrdGuard(prdPath);
    guard.read();
    unlinkSync(prdPath);
    mkdirSync(prdPath); // 同名目录：读抛 EISDIR→按删除篡改；写回 writeFileSync 抛 EISDIR→失败
    const r = guard.read();
    expect(r.prd?.project).toBe('p'); // 引擎自身仍用快照
    expect(r.restoreFailed).toBe(true);
  });
});
```

- [ ] **Step 6: 运行确认第二批失败**

Run: `npx vitest run src/engine/prd-guard.test.ts`
Expected: 第二批 6 个用例 FAIL（handleTamper 是占位实现：不存档、不恢复、不告警），第一批仍 PASS

- [ ] **Step 7: 实现 handleTamper**

替换 `src/engine/prd-guard.ts` 中的占位 `handleTamper`：

```typescript
  /** 处置篡改：存档（内容去重）→ 快照写回 → 告警（内容去重）。返回写回是否失败。 */
  function handleTamper(raw: string | null): boolean {
    const isNew = lastTampered === undefined || raw !== lastTampered;
    if (isNew) {
      lastTampered = raw;
      count++;
      let archiveNote = '文件被删除或不可读';
      if (raw !== null) {
        const archivePath = join(dirname(prdPath), `prd.tampered-${fileStamp(new Date())}.json`);
        try {
          writeFileSync(archivePath, raw, 'utf-8');
          archives.push(archivePath);
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
      return false;
    } catch (e) {
      console.warn(`⚠️  prd.json 快照写回失败（${(e as Error).message}）：磁盘仍是篡改版，本轮 validator 验收不可信`);
      return true;
    }
  }
```

注意：写回失败告警不去重（持续失败每轮都该提醒）；篡改发现告警按内容去重（isNew 分支内）。

- [ ] **Step 8: 运行全部 prd-guard 测试确认通过**

Run: `npx vitest run src/engine/prd-guard.test.ts`
Expected: PASS（10 个用例全绿）

- [ ] **Step 9: typecheck 后提交**

```bash
npm run typecheck
git add src/engine/prd-guard.ts src/engine/prd-guard.test.ts
git commit -m "feat: prd-guard 模块——运行期 prd.json 快照冻结与篡改处置（存档/恢复/告警，ADR-007）"
```

---

### Task 2: loop.ts 接线四处检测点与写回失败降级

**Files:**
- Modify: `src/engine/loop.ts`（import 区、:78 bootPrd、:99 before、:130-137 门禁取数、:155-164 validator、:168 after、:172-175 结束摘要）
- Test: `src/engine/loop.test.ts`（新增 describe）

**Interfaces:**
- Consumes: `createPrdGuard(prdPath): PrdGuard`、`PrdReadResult { prd, restoreFailed }`、`summary(): { count, archives }`（Task 1）
- Produces: 无新导出（loop 行为变更：篡改轮 validator 照常仅当磁盘可恢复；写回失败轮跳过 validator；结束摘要含篡改提示）

- [ ] **Step 1: 写失败集成测试**

追加到 `src/engine/loop.test.ts`（复用文件顶部已有的 `setup`/`story` 帮手）：

```typescript
describe('runLoop prd freeze', () => {
  it('builder 删除 qualityChecks 也架空不了门禁：文件被恢复、门禁照跑照打回', async () => {
    // 漏洞路径：builder 改写 prd.json 删掉 qualityChecks → 下轮门禁静默失效。
    // 修复后：builder 之后的检测点恢复文件，门禁按快照命令执行、失败打回并跳过 validator。
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const prdPath = join(workspace, 'prd.json');
    const original = readFileSync(prdPath, 'utf-8');
    const fake = join(workspace, 'fake-tamper.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      delete prd.qualityChecks;
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      // 门禁没有被架空：按快照命令执行并打回
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].notes).toContain('[门禁失败 - 第1次]');
      expect(state['US-001'].notes).toContain('gate-boom');
      // 门禁失败跳过 validator：stub 只被调了一次（builder）
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      // 磁盘被恢复为原版、篡改版被存档
      expect(readFileSync(prdPath, 'utf-8')).toBe(original);
      const archived = readdirSync(workspace).filter((f) => f.startsWith('prd.tampered-'));
      expect(archived).toHaveLength(1);
      expect(warns.some((w) => w.includes('检测到 prd.json 在运行期被修改'))).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('builder 改弱 AC 后 validator 读到的磁盘已是恢复的原版', async () => {
    // validator 是独立进程直读磁盘——第四检测点（builder 后）必须先恢复文件。
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['原始验收标准'] })]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-weaken.mjs');
    const calls = join(workspace, 'calls.txt');
    const seenByValidator = join(workspace, 'validator-saw.json');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, appendFileSync, existsSync, copyFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const n = readFileSync(${JSON.stringify(calls)}, 'utf-8').trim().split('\\n').length;
      if (n === 1) {
        // builder：改弱 AC 并翻绿
        const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
        prd.userStories[0].acceptanceCriteria = ['被改弱的标准'];
        writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
        writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        }));
      } else {
        // validator：记录此刻磁盘上的 prd.json（它验收时读到的东西）
        copyFileSync(${JSON.stringify(prdPath)}, ${JSON.stringify(seenByValidator)});
      }
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
      expect(code).toBe(0); // builder 翻绿、validator 跑过、完成判定放行
      const saw = JSON.parse(readFileSync(seenByValidator, 'utf-8'));
      expect(saw.userStories[0].acceptanceCriteria).toEqual(['原始验收标准']); // 不是被改弱的
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('删 story 骗不过完成判定：完成判定用快照，未完成照样跑满返回 1', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-drop.mjs');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      prd.userStories = []; // 删光 story：若完成判定读磁盘会误判全绿提前 exit 0
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
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
      expect(code).toBe(1); // story 从未通过，不被空列表骗成 0
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('写回失败的轮次跳过 validator，结束摘要报告篡改', async () => {
    // builder 删 prd.json 并在原路径建同名目录：读抛 EISDIR（按删除篡改）、写回抛 EISDIR（恢复失败）。
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-break.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { appendFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      if (existsSync(${JSON.stringify(prdPath)})) {
        unlinkSync(${JSON.stringify(prdPath)});
        mkdirSync(${JSON.stringify(prdPath)});
      }
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      // 写回失败 → 本轮 validator 被跳过：stub 只跑了一次
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      expect(warns.some((w) => w.includes('快照写回失败'))).toBe(true);
      expect(warns.some((w) => w.includes('跳过本轮 validator'))).toBe(true);
      // 结束摘要报告篡改事件
      expect(warns.some((w) => w.includes('运行期间检测到 prd.json 被修改'))).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});
```

同时在 `loop.test.ts` 顶部 import 里补 `readdirSync`（`node:fs`，现有 import 行追加）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/engine/loop.test.ts -t "prd freeze"`
Expected: 4 个用例 FAIL（当前 loop 直用 tryReadPrd，无恢复/跳过/摘要行为）

- [ ] **Step 3: 接线 loop.ts**

对 `src/engine/loop.ts` 做以下修改（行号为改前参照）：

(a) import 区（:4 附近）——`tryReadPrd` 仅 dashboard 之外不再使用则从 import 中移除，加 guard：

```typescript
import { type Prd } from './prd.js';
import { createPrdGuard } from './prd-guard.js';
```

（注意：若 `tryReadPrd` 在本文件已无其他使用处，从 import 中删除，避免未使用导入报错。）

(b) `runLoop` 开头（:61-62 之后）：

```typescript
  const prdPath = join(cfg.workspace, 'prd.json');
  const statePath = join(cfg.workspace, 'state.json');
  const guard = createPrdGuard(prdPath);
```

(c) 启动读取（:78）：

```typescript
    const bootPrd = guard.read().prd;
```

(d) 每轮开头（:99-100）：

```typescript
      const beforeRead = guard.read();
      const before = beforeRead.prd;
      // 写回失败=磁盘仍是篡改版=本轮 validator 读到的验收标准不可信 → 跳过（下轮开头重试恢复）
      let skipValidator = beforeRead.restoreFailed;
      const beforeState = before ? readRunState(statePath, before) : null;
```

(e) 门禁检测点（:130-137，builder 之后）——原 `const checks = readQualityChecks(before);` 替换为：

```typescript
      // 第四检测点：builder 刚跑完、validator 未拉起——本轮 builder 的篡改必须在此恢复，
      // 否则 validator（独立进程直读磁盘）当轮就会按假 AC 验收（ADR-007）。
      const gateRead = guard.read();
      if (gateRead.restoreFailed) skipValidator = true;
      const checks = readQualityChecks(gateRead.prd);
```

(f) validator 执行（:158-164）——`if (validator)` 改为：

```typescript
      if (validator && skipValidator) {
        console.warn('⚠️  prd.json 快照写回失败，跳过本轮 validator（磁盘验收标准不可信）');
      } else if (validator) {
        // …原有 validator 执行体不变…
      }
```

(g) 完成判定（:168）：

```typescript
      const after = guard.read().prd;
```

(h) 结束摘要（:177 `if (cfg.keepOpen)` 之前）：

```typescript
    const tamper = guard.summary();
    if (tamper.count > 0) {
      console.warn(
        `\n⚠️  运行期间检测到 prd.json 被修改 ${tamper.count} 次（引擎已按启动快照恢复并继续）。` +
        (tamper.archives.length > 0 ? `篡改存档：\n${tamper.archives.map((a) => `  - ${a}`).join('\n')}` : '（文件删除类篡改无存档）'),
      );
    }
```

- [ ] **Step 4: 运行 prd freeze 测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts -t "prd freeze"`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: 全量测试防回归（既有 quality gate/model routing 用例依赖每轮重读行为，重点确认）**

Run: `npm run typecheck && npm test`
Expected: 全绿。特别注意 `warns only once across rounds and disables routing on malformed models` 用例——它的 prd.json 顶层 `models: 'opus'` 是非法形状但 JSON 合法，快照照常建立、每轮返回快照解析结果，警告去重行为不变，应仍通过。若有用例因「循环中改 prd.json」的前置假设失败，按新语义逐个改造用例而非放宽 guard。

- [ ] **Step 6: 提交**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: 引擎接线 prd 冻结守卫——四处检测点、写回失败跳过 validator、结束摘要篡改报告"
```

---

### Task 3: 文档同步（ADR-007、ADR-005 修订、README、architecture.md）

**Files:**
- Create: `docs/decisions/007-prd-runtime-freeze.md`
- Modify: `docs/decisions/005-engine-quality-gate.md`（后果节）
- Modify: `README.md`（数据流段 :30、机械门禁条目 :67）
- Modify: `docs/architecture.md`（模块表、数据流节）

**Interfaces:**
- Consumes: 无代码接口；事实来源为 Task 1/2 的落地行为与规格锁定决策
- Produces: 无

- [ ] **Step 1: 新建 ADR-007**

创建 `docs/decisions/007-prd-runtime-freeze.md`：

```markdown
---
title: 007-prd-runtime-freeze
status: active
updated: 2026-07-07
scope: root
---

# 007. 运行期 prd.json 冻结（快照防篡改）

## 背景

ADR-005 宣称机械门禁「不可绕过、不可共谋」，但引擎每轮从磁盘重读 prd.json，而「运行期只读」只是指令约束、无机械强制。三个篡改面：builder 删改 `qualityChecks` 下轮起门禁静默失效；builder 改弱 acceptanceCriteria 则 validator（独立进程直读磁盘）当轮即按假标准验收；删 story 可骗过完成判定提前 exit 0。`.workspace/` 不进 git，篡改无痕迹。外部触发：no-mistakes 源码调研——其「代码执行配置只从受信任默认分支读取」的防御思路，映射到本项目即「只信引擎启动时刻的 prd.json」。

## 决策

新模块 `src/engine/prd-guard.ts`：第一次成功解析 prd.json 时建立快照（原始字符串+解析对象），此后引擎全部 prd 读取（启动、每轮开头、builder 后门禁前、完成判定共四处检测点）收口为 guard.read()——磁盘与快照不一致即篡改：篡改版存档到 `.workspace/prd.tampered-<时间戳>.json`（内容去重）、快照写回磁盘恢复、console 告警（内容去重、含正路指引）、循环继续。写回失败的轮次跳过 validator（磁盘验收标准不可信）。改需求的正路：停引擎 → 修订源 PRD → prd-to-json 再派生 → 重跑（引擎重启即快照合法刷新点）。

## 理由与备选

- **为什么不是仅 qualityChecks 内存快照**：validator 是独立子进程、自己读磁盘的 acceptanceCriteria——内存快照护不住验收面与完成判定面，是半个修复；恢复必须写回磁盘。
- **为什么不终止循环**：无人值守是核心定位，过夜跑一旦触发即整晚停摆；恢复+继续使篡改完全失效，无需戏剧化反应。
- **为什么不写 story notes**：篡改是 PRD 级事件且归因不清（builder/validator/外部进程均可能），写进某个 story 的 notes 会误导 builder 下轮「针对性处理」。留证走存档文件+console。
- **为什么按字符串全等而非语义比较**：运行期没有合法写方，任何字节变化都可疑；格式化差异也是变更，宁严勿松。

## 后果

- 「运行中热更新需求」不再可行（从未被文档承诺；幂等续跑使停机成本≈0）。
- 每轮多两次文件读取与字符串比较（几十 KB 级，可忽略）。
- 新产物文件 `prd.tampered-*.json` 落在 workspace，人审时一眼可见；/review-loop 对其的高亮消费留给后续吸收项。
- state.json 篡改面（builder 批量写 passes=true 跳过 validator 复核）不在本决策范围：state.json 是 agent 合法写入目标、不能冻结，防线是机械门禁+/review-loop+人审。
```

- [ ] **Step 2: 修订 ADR-005 后果节**

在 `docs/decisions/005-engine-quality-gate.md` 的「## 后果」节末尾追加一行，并更新 frontmatter 的 `updated` 为 2026-07-07：

```markdown
- 「不可绕过、不可共谋」的论证隐含依赖 prd.json 运行期不可变——该前提当时无机械保证（builder 改写 qualityChecks 可延迟一轮静默架空门禁），由 ADR-007 运行期冻结闭环。
```

- [ ] **Step 3: 更新 README**

(a) 数据流段（原文含「`prd.json`（需求，运行期只读）」的句子，:30 附近），把「运行期只读」扩为：

```markdown
`prd.json`（需求，运行期只读且被引擎冻结——启动时快照，运行中的磁盘修改会被自动恢复并存档为 `.workspace/prd.tampered-*.json` 供人审；改需求请停引擎 → 修订源 PRD → 重新派生 → 重跑）
```

(b) 机械门禁条目（:67「builder 谎报『检查通过』会被零成本戳穿」句后）追加一句：

```markdown
门禁配置受快照保护：运行期改写 prd.json（含删改 `qualityChecks` / 验收标准）会被检测、恢复并存档，无法架空门禁与验收（ADR-007）。
```

- [ ] **Step 4: 更新 architecture.md**

(a) 模块表（「模型路由」行之后）加一行：

```markdown
| prd 守卫 | `src/engine/prd-guard.ts` | 运行期 prd.json 冻结：首次成功读取建快照，四处检测点校验，篡改自动存档（去重）+快照写回恢复+告警；写回失败信号驱动 loop 跳过该轮 validator（ADR-007） |
```

(b) 数据流节「运行期只读」处补充：

原句「`prd.json`（需求，由 `docs/prds/` 源 PRD 经 prd-to-json 派生，顶层 `sourcePrd` 记录来源，运行期只读）」改为：

```markdown
`prd.json`（需求，由 `docs/prds/` 源 PRD 经 prd-to-json 派生，顶层 `sourcePrd` 记录来源，运行期只读——引擎以启动快照冻结，磁盘篡改自动恢复并存档，ADR-007）
```

同时更新 `docs/architecture.md` frontmatter 的 `updated` 为 2026-07-07。

- [ ] **Step 5: grep 验证文档一致性（限定目标文件，防自命中）**

```bash
grep -c "ADR-007\|007-prd-runtime-freeze" docs/decisions/005-engine-quality-gate.md README.md docs/architecture.md
grep -n "prd.tampered" README.md docs/decisions/007-prd-runtime-freeze.md
```

Expected: 三个文件各至少 1 处引用 007；README 与 ADR-007 都出现 `prd.tampered` 产物说明。

- [ ] **Step 6: 提交**

```bash
git add docs/decisions/007-prd-runtime-freeze.md docs/decisions/005-engine-quality-gate.md README.md docs/architecture.md
git commit -m "docs: ADR-007 运行期 prd 冻结——ADR-005 后果节补篡改漏洞闭环，README/架构图同步冻结语义与 prd.tampered 产物"
```

---

### Task 4: 发版 0.17.0（规格收尾 + npm version + push 后停手）

**Files:**
- Modify: `docs/superpowers/specs/2026-07-07-prd-freeze-guard-design.md`（frontmatter status）
- Modify: `package.json` 等（由 `npm version` 钩子自动同步插件清单与 lock）

**Interfaces:**
- Consumes: Task 1-3 全部完成且提交
- Produces: tag v0.17.0；npm publish 与 GitHub Release 由 tag 触发的 CI 完成——**本地不做**

- [ ] **Step 1: 规格状态收尾**

`docs/superpowers/specs/2026-07-07-prd-freeze-guard-design.md` frontmatter：`status: active` → `status: done`，`updated: 2026-07-07`。

```bash
git add docs/superpowers/specs/2026-07-07-prd-freeze-guard-design.md
git commit -m "docs: prd 冻结设计规格按落地置 done"
```

- [ ] **Step 2: 全量验证**

```bash
npm run typecheck && npm test && npm run build
```

Expected: 全绿（build 确认 tsup 打包含新模块无误）。

- [ ] **Step 3: 发版**

```bash
npm version minor -m "release: v%s"
```

Expected: 版本 0.16.0 → 0.17.0，钩子自动同步插件清单与 lock 文件进同一提交，生成 tag v0.17.0。

- [ ] **Step 4: 推送后停手**

```bash
git push --follow-tags
```

Expected: push 成功。**到此为止**——npm publish 与 GitHub Release 由 tag 触发的 CI 完成，本地绝不抢发（0.14.3 实翻教训）。可用 `gh run watch` 观察 CI，但不做任何发布操作。

---

## 自审记录

- **规格覆盖**：决策 1-9 → Task 1/2；决策 10（版本与文档）→ Task 3/4；改动清单 8 行全部有对应任务（fake-agent.mjs 一行以「loop.test.ts 内联 fake」替代——与现有集成测试模式一致，改动更小，规格意图「测试基建支持篡改场景」已满足）；非目标 5 条无任务（正确）。
- **占位符**：无 TBD/「适当处理」；Task 1 Step 3 的 `handleTamper` 占位是 TDD 中间态，Step 7 给出完整实现。
- **类型一致性**：`PrdReadResult`/`TamperSummary`/`createPrdGuard` 在 Task 1 Interfaces、Step 3 实现、Task 2 接线中签名一致；告警文案「检测到 prd.json 在运行期被修改」「快照写回失败」「跳过本轮 validator」「运行期间检测到 prd.json 被修改」在实现（Task 1 Step 7、Task 2 Step 3(f)(h)）与测试断言（Task 1 Step 5、Task 2 Step 1）间逐字对应。
```

import { join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
import { runAgent, type AgentKind } from './agent.js';
import { type Prd } from './prd.js';
import { createPrdGuard } from './prd-guard.js';
import type { PrdReadResult } from './prd-guard.js';
import { ensureStateFile, blankStateFor, tryReadState, getCurrentStoryId, allStoriesResolved, type RunState } from './state.js';
import { runQualityChecks, readQualityChecks, applyGateFailure, applyAbortRollback, MAX_RETRIES, ARBITRATION_PREFIXES } from './gate.js';
import { readModelsConfig, resolveBuilderModel, resolveValidatorModel } from './models.js';
import * as dashboard from '../dashboard/server.js';
import { writeReport } from '../report/report.js';
import { appendEvidence, type EvidenceRecord } from './evidence.js';
import { acquireLock, LockConflictError, type LockHandle } from './lock.js';

export interface LoopConfig {
  kind: AgentKind;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  /** 临时覆盖 builder 阶段模型（压过 prd.json models 与升级链） */
  builderModel?: string;
  /** 临时覆盖 validator 阶段模型（压过 prd.json models.validator） */
  validatorModel?: string;
  workspace: string;
  instructionsDir: string;
  port?: number;
  openBrowser?: boolean;
  /** 运行结束后保留仪表盘直到 interrupt（默认 Ctrl+C）；退出码仍是循环的真实结果 */
  keepOpen?: boolean;
  /** keepOpen 的放行信号，默认等待 SIGINT；测试注入用 */
  interrupt?: Promise<void>;
  /** 连续无进展轮（no-op/超时/异常退出）熔断上限；缺省 3 */
  stallLimit?: number;
}

function waitForSigint(): Promise<void> {
  return new Promise((resolve) => process.once('SIGINT', () => resolve()));
}

function readInstruction(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf-8');
  } catch {
    return null;
  }
}

// Instruction files use the {{WORKSPACE}} placeholder instead of a hardcoded
// '.workspace/' prefix so a custom --workspace path reaches the agent. The
// agent runs at the project root, and cfg.workspace is resolved the same way
// the engine resolves it (relative to the project root, or absolute), so the
// agent and engine always share the same prd.json / state.json / progress.md.
export function renderInstruction(text: string, workspace: string): string {
  return text
    .replaceAll('{{WORKSPACE}}', workspace)
    .replaceAll('{{MAX_RETRIES}}', String(MAX_RETRIES))
    .replaceAll('{{ARBITRATION_PREFIXES}}', ARBITRATION_PREFIXES.join('、'));
}

// 运行期读取执行状态；缺失/损坏时按全部未开始处理（绝不覆盖原文件，交给 repair）。
function readRunState(statePath: string, prd: Prd): RunState {
  const state = tryReadState(statePath);
  if (state) return state;
  console.warn('⚠️  state.json 缺失或不可读，本轮按全部 story 未开始处理；若文件损坏请运行 npx coding-x repair');
  return blankStateFor(prd);
}

export async function runLoop(cfg: LoopConfig): Promise<number> {
  // 单写者互斥（ADR-008）：活锁 fail-fast、stale 自动接管；冲突时未启动任何资源，直接退出码 2
  let lock: LockHandle;
  try {
    lock = acquireLock(cfg.workspace, 'run');
  } catch (err) {
    if (err instanceof LockConflictError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  const prdPath = join(cfg.workspace, 'prd.json');
  const statePath = join(cfg.workspace, 'state.json');
  const guard = createPrdGuard(prdPath);
  const builderRaw = readInstruction(cfg.instructionsDir, 'builder.md');
  const validatorRaw = readInstruction(cfg.instructionsDir, 'validator.md');
  const builder = builderRaw === null ? null : renderInstruction(builderRaw, cfg.workspace);
  const validator = validatorRaw === null ? null : renderInstruction(validatorRaw, cfg.workspace);

  const server = dashboard.start({
    workspace: cfg.workspace,
    maxIterations: cfg.maxIterations,
    port: cfg.port,
    openBrowser: cfg.openBrowser ?? true,
  });

  try {
    // 启动时保证 state.json 存在：v0.4 及更早的 prd.json 把状态写在 story 上，
    // ensureStateFile 会把它们抽取成 state.json（一次性迁移）。
    const bootPrd = guard.read().prd;
    if (bootPrd) ensureStateFile(cfg.workspace, bootPrd);
    // Agents must run at the project root (the engine process's cwd), NOT at
    // cfg.workspace. The engine reads prd.json at join(cfg.workspace,
    // 'prd.json'), which for the default relative '.workspace' resolves against
    // the process cwd → <root>/.workspace/prd.json. The builder/validator
    // instructions also read '.workspace/prd.json' and root AGENTS.md/tasks/,
    // assuming cwd == project root. Spawning at cfg.workspace would make the
    // agent resolve '.workspace/prd.json' to <root>/.workspace/.workspace/prd.json,
    // so engine and agent would never share state and the loop would always hit
    // maxIterations. (See loop.test.ts "spawns the agent at the project root".)
    const agentCwd = process.cwd();
    const progressPath = join(cfg.workspace, 'progress.md');
    const rawOf = (p: string): string | null => {
      try { return readFileSync(p, 'utf-8'); } catch { return null; }
    };
    const outcomeOf = (r: { timedOut: boolean; exitCode: number | null }): 'completed' | 'timeout' | 'error' =>
      r.timedOut ? 'timeout' : r.exitCode === 0 ? 'completed' : 'error';
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
    // 四处提前退出（builder 异常轮熔断 / no-op 全部 resolved 快路径 / no-op 非 resolved 熔断 / validator 异常轮熔断）
    // break 前统一补一次 guard.read()+recordTamper()——它们都复用轮首快照提前结束本轮，
    // 若 builder 在本轮篡改了 prd.json，不补这一读就不会被检测/恢复/存档（与标准完成判定
    // 路径:344-345 的读点同形态）。guard.read() 幂等：磁盘未变时是真无操作。
    const tamperCheckBeforeExit = (iteration: number) => {
      const r = guard.read();
      recordTamper(r, iteration);
    };
    // 模型路由警告去重：非法 models 配置的警告每轮都会重新产生，同一条只打一次
    const warnedModels = new Set<string>();
    const warnModelsOnce = (msgs: string[]) => {
      for (const m of msgs) {
        if (!warnedModels.has(m)) { warnedModels.add(m); console.warn(m); }
      }
    };
    const stallLimit = cfg.stallLimit ?? 3;
    let stallCount = 0;
    // stall 熔断判定：stall 轮调用；达限打横幅并返回 true（调用方 break）
    const stalled = (): boolean => {
      stallCount += 1;
      if (stallCount < stallLimit) return false;
      console.error(`\n🛑 连续 ${stallLimit} 轮无进展（no-op/超时/异常退出），提前终止。排查 agent CLI 可用性、模型名与网络后重跑（引擎幂等续跑）。`);
      return true;
    };
    let exitCode = 1;
    for (let i = 1; i <= cfg.maxIterations; i++) {
      lock.verify(); // 轮首自愈：agent 误删/改写锁时告警重建（同 prd-guard 的机械防护哲学）
      const stateRawBefore = rawOf(statePath);
      const progressRawBefore = rawOf(progressPath);
      const beforeRead = guard.read();
      recordTamper(beforeRead, i);
      const before = beforeRead.prd;
      // 写回失败=磁盘仍是篡改版=本轮 validator 读到的验收标准不可信 → 跳过（下轮开头重试恢复）
      let skipValidator = beforeRead.restoreFailed;
      const beforeState = before ? readRunState(statePath, before) : null;
      const currentStory = before && beforeState ? getCurrentStoryId(before, beforeState) : null;
      const modelsRead = readModelsConfig(before);
      warnModelsOnce(modelsRead.warnings);
      const currentStoryObj = before?.userStories.find((s) => s.id === currentStory) ?? null;
      const retryCount = currentStory && beforeState ? (beforeState[currentStory]?.retryCount ?? 0) : 0;
      // 异常轮回写：本轮把当前 story 的 passes 从 false 翻到 true 且未 blocked → 回写待复核。
      // state 读取失败（缺失/损坏）不回写不覆盖（同门禁打回的保守语义）。返回是否发生回写。
      const rollbackIfUnvalidatedPass = (side: 'builder' | 'validator', r: { timedOut: boolean; exitCode: number | null }): boolean => {
        if (!currentStory) return false;
        const passedBefore = beforeState?.[currentStory]?.passes ?? false;
        const st = tryReadState(statePath);
        const cur = st?.[currentStory];
        if (!st || !cur || !cur.passes || cur.blocked || passedBefore) return false;
        const next = applyAbortRollback(st, currentStory, { side, timedOut: r.timedOut, exitCode: r.exitCode }, new Date());
        writeFileAtomicSync(statePath, JSON.stringify(next, null, 2));
        console.warn(`⚠️  ${currentStory} 在中断轮被置为通过，未经完整验收——已回写待复核（${side} ${r.timedOut ? '超时' : `退出码 ${r.exitCode}`}）`);
        return true;
      };
      const builderChoice = resolveBuilderModel({
        cliOverride: cfg.builderModel, config: modelsRead.config, story: currentStoryObj, retryCount,
      });
      warnModelsOnce(builderChoice.warnings);

      dashboard.setState({ iteration: i, phase: 'developing', currentStory, model: builderChoice.model ?? null });

      // Developer
      let builderOutcome: 'completed' | 'timeout' | 'error' | undefined;
      let builderRollback = false;
      if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else {
        if (builderChoice.model) {
          console.log(`🧠 builder 模型: ${builderChoice.model}${builderChoice.escalated ? `（${currentStory} 第 ${retryCount} 次重试，升级）` : ''}`);
        }
        const dev = await runAgent({
          kind: cfg.kind, prompt: builder, cwd: agentCwd, timeoutMs: cfg.devTimeoutMs,
          model: builderChoice.model,
        });
        builderOutcome = outcomeOf(dev);
        if (builderOutcome !== 'completed') {
          builderRollback = rollbackIfUnvalidatedPass('builder', dev);
          // evidence=引擎机械事实：agentBlocked 不能硬编码 false——agent 可能同轮已置 blocked:true
          // 又以非零码退出（如仲裁上报后环境异常收尾），此处需实时读一次 state 反映真实情况。
          const blockedNow = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
          recordEvidence({
            type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
            storyId: currentStory, builderRan: true, builderModel: builderChoice.model ?? null,
            validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: blockedNow,
            builderOutcome, ...(builderRollback ? { abortRollback: { storyId: currentStory! } } : {}),
          });
          dashboard.setState({ phase: 'idle', model: null });
          if (stalled()) { tamperCheckBeforeExit(i); break; }
          continue; // 异常轮：跳过门禁与验收，下轮重试（回写已保证不带走未验收的 true）
        }
      }

      // no-op 空转检测：builder 正常结束但 state 与 progress 双无变化（机械信号）——
      // 跳过门禁与验收（省一次强模型调用），计入 stall。
      if (builder && builderOutcome === 'completed'
          && rawOf(statePath) === stateRawBefore && rawOf(progressPath) === progressRawBefore) {
        // 双无变化不等于「无事发生」：本轮开始时可能已经全部 resolved（如 legacy 迁移在
        // bootstrap 就把 passes 写进 state.json，或断点续跑接手一个已完成的工作区）——
        // before/beforeState 就是这轮唯一会有的磁盘状态（没变化），完成判定照样要跑，
        // 否则已完工的工作区会被当成空转一路吃到熔断。
        if (before && beforeState && allStoriesResolved(before, beforeState)) {
          // 每轮一条 iteration 不变式：这条快路径 break 前也要留痕，否则已完工工作区
          // 重跑的终轮在 evidence 时间线上是空洞（其余所有退出路径都恰写一条）。
          recordEvidence({
            type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
            storyId: currentStory, builderRan: true, builderModel: builderChoice.model ?? null,
            validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
            builderOutcome: 'completed', noop: true,
          });
          tamperCheckBeforeExit(i);
          dashboard.setState({ phase: 'done' });
          console.log('\n💡 全部 story 已通过。建议先运行 /review-loop 审查本轮产物（人审后合并），再用 /compound-docs 收口沉淀。');
          exitCode = 0;
          break;
        }
        console.warn('⏭️  本轮 builder 无任何产出（state/progress 双无变化），跳过门禁与验收');
        recordEvidence({
          type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
          storyId: currentStory, builderRan: true, builderModel: builderChoice.model ?? null,
          validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
          builderOutcome: 'completed', noop: true,
        });
        dashboard.setState({ phase: 'idle', model: null });
        if (stalled()) { tamperCheckBeforeExit(i); break; }
        continue;
      }

      // 机械门禁：builder 之后、validator 之前确定性执行质量检查（fail-fast）。
      // 失败即机械打回并跳过本轮 validator——builder 谎报「检查通过」在此被零成本戳穿。
      // 第四检测点：builder 刚跑完、validator 未拉起——本轮 builder 的篡改必须在此恢复，
      // 否则 validator（独立进程直读磁盘）当轮就会按假 AC 验收（ADR-007）。
      const gateRead = guard.read();
      recordTamper(gateRead, i);
      if (gateRead.restoreFailed) skipValidator = true;
      // agent 轮内显式置 blocked（仲裁上报，如 [需要人工核实]）：机械路径不得推进它——
      // 当轮跳过门禁执行与验收，完成判定按 resolved 正常收敛。
      // 第四检测点（上方 guard.read()）保持无条件执行：篡改恢复不因跳过而延后。
      const agentBlocked = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
      if (agentBlocked) {
        console.log(`⏭️  ${currentStory} 已被置 blocked（待人工处理），本轮跳过门禁与验收`);
      }
      const checks = readQualityChecks(gateRead.prd);
      if (checks === 'invalid') {
        console.warn('⚠️  prd.json 的 qualityChecks 形状非法（应为字符串数组），机械门禁未启用');
      } else if (!agentBlocked && checks && currentStory) {
        dashboard.setState({ phase: 'gating', model: null });
        const gate = await runQualityChecks(checks, agentCwd);
        recordEvidence({
          type: 'gate-run', source: 'engine', at: new Date().toISOString(), iteration: i,
          storyId: currentStory, ok: gate.ok, total: gate.total, ran: gate.ran, ms: gate.ms,
          ...(gate.failure ? {
            failedCommand: gate.failure.command, exitCode: gate.failure.exitCode, timedOut: gate.failure.timedOut,
          } : {}),
        });
        if (!gate.ok) {
          console.error(`\n❌ 机械门禁未通过（${gate.failure!.command}），打回 ${currentStory} 待下轮重试`);
          const st = tryReadState(statePath);
          if (st) {
            const next = applyGateFailure(st, currentStory, gate.failure!, new Date());
            writeFileAtomicSync(statePath, JSON.stringify(next, null, 2));
          } else {
            // 缺失/损坏都不落盘打回：绝不覆盖可能损坏的文件（同 ensureStateFile 语义）
            console.warn('⚠️  state.json 缺失或不可读，门禁打回未落盘；若文件损坏请运行 npx coding-x repair');
          }
          recordEvidence({
            type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
            storyId: currentStory, builderRan: !!builder, builderModel: builderChoice.model ?? null,
            validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
            ...(builderOutcome ? { builderOutcome } : {}), validatorOutcome: 'skipped', gateRejected: true,
          });
          stallCount = 0; // 有 state 写入=有活动；打回预算由 MAX_RETRIES 独立约束
          // 已知不对称：门禁把最后一个 story 打到 blocked 时，本轮 continue 跳过完成判定，
          // 完成要到下一轮才被发现；发生在末轮迭代时退出码为 1（validator 打回则当轮判定）。低频且 blocked→1 语义诚实，接受。
          dashboard.setState({ phase: 'idle', model: null });
          continue;
        }
      }

      // Validator
      const validatorModel = resolveValidatorModel({ cliOverride: cfg.validatorModel, config: modelsRead.config });
      dashboard.setState({ phase: 'validating', model: validatorModel ?? null });
      let validatorOutcome: 'completed' | 'timeout' | 'error' | 'skipped' | undefined;
      let validatorRollback = false;
      if (validator && skipValidator) {
        console.warn('⚠️  prd.json 快照写回失败，跳过本轮 validator（磁盘验收标准不可信）');
        validatorOutcome = 'skipped';
      } else if (validator && !agentBlocked) {
        if (validatorModel) console.log(`🧠 validator 模型: ${validatorModel}`);
        const val = await runAgent({
          kind: cfg.kind, prompt: validator, cwd: agentCwd, timeoutMs: cfg.valTimeoutMs,
          model: validatorModel,
        });
        validatorOutcome = outcomeOf(val);
        if (validatorOutcome !== 'completed') {
          // validator 异常结局：本轮 builder 置的 true 未经复核 → 回写待复核
          validatorRollback = rollbackIfUnvalidatedPass('validator', val);
        }
      } else if (validator && agentBlocked) {
        validatorOutcome = 'skipped';
      }

      // 每轮一条 iteration 不变式：continue 路径（builder 异常/no-op/门禁打回）各自留痕后跳出，
      // 走到这里的轮在此记录——evidence 时间线零空洞（v0.22.0，dogfood 发现 B）。
      recordEvidence({
        type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
        storyId: currentStory,
        builderRan: !!builder,
        builderModel: builderChoice.model ?? null,
        validatorRan: !!validator && !skipValidator && !agentBlocked,
        validatorModel: validatorModel ?? null,
        skippedValidator: skipValidator, agentBlocked,
        ...(builderOutcome ? { builderOutcome } : {}),
        ...(validatorOutcome ? { validatorOutcome } : {}),
        ...(validatorRollback ? { abortRollback: { storyId: currentStory! } } : {}),
      });

      if (validatorOutcome === 'timeout' || validatorOutcome === 'error') {
        if (stalled()) { tamperCheckBeforeExit(i); break; }
      } else {
        stallCount = 0; // 正常走完的轮（含 agentBlocked/skipValidator 跳过轮）清零
      }

      // Completion check
      dashboard.setState({ phase: 'idle', model: null });
      const afterRead = guard.read();
      recordTamper(afterRead, i);
      const after = afterRead.prd;
      const afterState = after ? readRunState(statePath, after) : null;
      if (after && afterState && allStoriesResolved(after, afterState)) {
        dashboard.setState({ phase: 'done' });
        console.log('\n💡 全部 story 已通过。建议先运行 /review-loop 审查本轮产物（人审后合并），再用 /compound-docs 收口沉淀。');
        exitCode = 0;
        break;
      }
    }
    const tamper = guard.summary();
    if (tamper.count > 0) {
      console.warn(
        `\n⚠️  运行期间检测到 prd.json 被修改 ${tamper.count} 次（引擎已按启动快照恢复并继续）。` +
        (tamper.archives.length > 0 ? `篡改存档：\n${tamper.archives.map((a) => `  - ${a}`).join('\n')}` : '（文件删除类篡改无存档）'),
      );
    }
    // 循环结束无条件生成静态验证报告（进行中态也诚实存档）；
    // 报告是副产物：任何失败只 warn，绝不影响循环退出码。
    try {
      const report = writeReport(cfg.workspace, new Date());
      if (report.status === 'written') {
        console.log(`📄 验证报告: ${report.path}`);
      } else {
        console.warn(`⚠️  验证报告未生成（prd.json ${report.status === 'missing' ? '缺失' : '不可解析'}）`);
      }
    } catch (err) {
      console.warn(`⚠️  验证报告生成失败：${err instanceof Error ? err.message : String(err)}`);
    }
    // keepOpen 等待阶段只读、无需持锁；此处释放同时注销信号 handler，
    // 等待期 Ctrl+C 完全走既有 waitForSigint 语义（真实退出码保留）
    lock.release();
    if (cfg.keepOpen) {
      const url = `http://localhost:${server.address().port}`;
      console.log(`\n✅ 运行结束（退出码 ${exitCode}）。仪表盘仍在 ${url} ，按 Ctrl+C 退出。`);
      await (cfg.interrupt ?? waitForSigint());
    }
    return exitCode;
  } finally {
    lock.release(); // 幂等：正常路径已释放则短路；异常路径在此兜底
    server.close();
  }
}

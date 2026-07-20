import { join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
import { permissionWarning, runAgent, type AgentKind } from './agent.js';
import { type Prd } from './prd.js';
import { createPrdGuard } from './prd-guard.js';
import type { PrdReadResult } from './prd-guard.js';
import {
  ensureStateFile, blankStateFor, tryReadState, getCurrentStoryId, allStoriesResolved,
  enableEscalation, restoreEscalated, type RunState, type StoryState,
} from './state.js';
import { runQualityChecks, readQualityChecks, applyGateFailure, applyAbortRollback, abortDesc, MAX_RETRIES, ARBITRATION_PREFIXES } from './gate.js';
import { resolveBuilderModel, resolveValidatorModel } from './models.js';
import { ModelPreflightError, preflightModelRouting, renderPreflightSummary } from './model-preflight.js';
import type { ModelDiscoveryResult } from './model-discovery.js';
import * as dashboard from '../dashboard/server.js';
import { writeReport } from '../report/report.js';
import { appendEvidence, type EvidenceRecord } from './evidence.js';
import { acquireLock, LockConflictError, type LockHandle } from './lock.js';

export interface LoopConfig {
  kind: AgentKind;
  /** CLI 位置参数是否显式指定 kind；直接 API 调用缺省视为显式。 */
  kindExplicit?: boolean;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  /** 临时覆盖 builder 阶段模型（压过 prd.json models 与升级链） */
  builderModel?: string;
  /** 临时覆盖 validator 阶段模型（压过 prd.json models.validator） */
  validatorModel?: string;
  /** 临时覆盖升级 builder 模型；只在 state.escalated=true 时生效。 */
  escalationModel?: string;
  /** 测试注入；生产缺省调用公开 runner 探测。 */
  modelDiscovery?: (runner: AgentKind) => Promise<ModelDiscoveryResult>;
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

// 收敛出口单源：两个 allStoriesResolved 出口（no-op 快路径/轮末完成判定）共用，
// blocked>0 时 exit 3——「收敛但待人工」对所有出口成立（ADR-009/发现 D）
const convergedExit = (prd: Prd, state: RunState): number => {
  const blockedIds = prd.userStories.filter((s) => state[s.id]?.blocked).map((s) => s.id);
  if (blockedIds.length > 0) {
    const passedCount = prd.userStories.length - blockedIds.length;
    console.log(`\n⏸️  ${passedCount} 个 story 通过，${blockedIds.length} 个 blocked 待人工处理（${blockedIds.join(', ')}）。处理后重跑引擎收敛剩余项；人审入口见 .workspace/report.html 与 state.json notes。`);
    return 3;
  }
  console.log('\n💡 全部 story 已通过。建议先运行 /review-loop 审查本轮产物（人审后合并），再用 /compound-docs 收口沉淀。');
  return 0;
};

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

  let server: ReturnType<typeof dashboard.start> | null = null;
  try {
    // 启动时保证 state.json 存在：v0.4 及更早的 prd.json 把状态写在 story 上，
    // ensureStateFile 会把它们抽取成 state.json（一次性迁移）。
    const bootPrd = guard.read().prd;
    if (bootPrd) ensureStateFile(cfg.workspace, bootPrd);
    // ensureStateFile 为了 legacy 迁移会在损坏 state 时返回内嵌旧状态，但运行期
    // 绝不能因此“复活”旧 passes。重读磁盘：新迁移文件可读则正常使用，
    // 仍损坏则与轮内 readRunState 一样按全未开始处理，且不覆盖原文件。
    const bootState = bootPrd
      ? (tryReadState(statePath) ?? blankStateFor(bootPrd))
      : null;
    let preflight;
    try {
      preflight = await preflightModelRouting({
        prd: bootPrd,
        state: bootState,
        requestedRunner: cfg.kind,
        runnerExplicit: cfg.kindExplicit ?? true,
        builderOverride: cfg.builderModel,
        validatorOverride: cfg.validatorModel,
        escalationOverride: cfg.escalationModel,
        ...(cfg.modelDiscovery ? { discover: cfg.modelDiscovery } : {}),
      });
    } catch (err) {
      if (err instanceof ModelPreflightError) {
        console.error(`❌ 模型路由预检失败：${err.message}`);
        return 2;
      }
      throw err;
    }
    const runKind = preflight.runner;
    const bootResolved = !!(bootPrd && bootState && allStoriesResolved(bootPrd, bootState));
    for (const warning of preflight.warnings) console.warn(`⚠️  ${warning}`);
    console.log(renderPreflightSummary(preflight));
    if (!bootResolved) console.warn(permissionWarning(runKind));

    server = dashboard.start({
      workspace: cfg.workspace,
      maxIterations: cfg.maxIterations,
      port: cfg.port,
      openBrowser: cfg.openBrowser ?? true,
    });
    dashboard.setState({ runner: runKind });
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
    if (bootResolved) {
      dashboard.setState({ phase: 'done', model: null, routeSource: null, storyDifficulty: null });
      exitCode = convergedExit(bootPrd!, bootState!);
    }
    for (let i = 1; !bootResolved && i <= cfg.maxIterations; i++) {
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
      const currentStoryObj = before?.userStories.find((s) => s.id === currentStory) ?? null;
      const routeTampers: Array<{
        expected: boolean; received: boolean | 'missing'; side: 'builder' | 'validator';
      }> = [];
      const restoreRouteOwnership = (
        side: 'builder' | 'validator', expectedState: StoryState | undefined,
      ): void => {
        if (!currentStory) return;
        const state = tryReadState(statePath);
        if (!state) return;
        const expected = expectedState?.escalated ?? false;
        const restored = restoreEscalated(state, currentStory, expected, expectedState);
        if (!restored.tamper) return;
        routeTampers.push({ ...restored.tamper, side });
        writeFileAtomicSync(statePath, JSON.stringify(restored.state, null, 2));
        console.warn(
          `⚠️  ${side} 修改了引擎独占的 ${currentStory}.escalated ` +
          `(${restored.tamper.expected} → ${restored.tamper.received})，已恢复`,
        );
      };
      const hasDedicatedEscalation = Boolean(cfg.escalationModel || preflight.config?.escalation);
      const triggerEscalation = (reason: 'gate' | 'validator' | 'noop'): boolean => {
        if (!currentStory) return false;
        const state = tryReadState(statePath);
        if (!state) return false;
        const enabled = enableEscalation(state, currentStory, hasDedicatedEscalation);
        if (!enabled.changed) return false;
        writeFileAtomicSync(statePath, JSON.stringify(enabled.state, null, 2));
        console.log(`⬆️  ${currentStory} 首次有效失败（${reason}），下轮起使用 escalation 模型`);
        return true;
      };
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
        console.warn(`⚠️  ${currentStory} 在中断轮被置为通过，未经完整验收——已回写待复核（${side} ${abortDesc(r)}）`);
        return true;
      };
      const builderChoice = resolveBuilderModel({
        builderOverride: cfg.builderModel, escalationOverride: cfg.escalationModel,
        config: preflight.config, story: currentStoryObj,
        escalated: currentStory && beforeState ? (beforeState[currentStory]?.escalated ?? false) : false,
      });
      // 「每轮一条 iteration」五个写入点的公共底座单源：各点只传差异字段——
      // 0.22.0 轮五点位分四批才靠审查抓齐，字段漂移风险有实证，底座必须只有一份。
      const recordIteration = (over: Partial<Extract<EvidenceRecord, { type: 'iteration' }>>) => {
        recordEvidence({
          type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
          storyId: currentStory, builderRan: !!builder, builderModel: builderChoice.model ?? null,
          validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
          builderRouteSource: builderChoice.source,
          ...(currentStoryObj?.difficulty ? { storyDifficulty: currentStoryObj.difficulty } : {}),
          ...(routeTampers.length > 0 ? { stateRouteTamper: [...routeTampers] } : {}),
          ...over,
        });
      };

      dashboard.setState({
        iteration: i, phase: 'developing', currentStory,
        model: builder ? (builderChoice.model ?? null) : null,
        routeSource: builder ? builderChoice.source : null,
        storyDifficulty: currentStoryObj?.difficulty ?? null,
      });

      // Developer
      let builderOutcome: 'completed' | 'timeout' | 'error' | undefined;
      let builderRollback = false;
      if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else {
        console.log(
          `🧠 builder 实际模型: ${builderChoice.model ?? 'runner 默认'} [${builderChoice.source}]` +
          `${currentStoryObj?.difficulty ? ` · 难度 ${currentStoryObj.difficulty}` : ''}` +
          `${builderChoice.escalated ? ` · ${currentStory} 升级路由` : ''}`,
        );
        const dev = await runAgent({
          kind: runKind, prompt: builder, cwd: agentCwd, timeoutMs: cfg.devTimeoutMs,
          model: builderChoice.model,
        });
        builderOutcome = outcomeOf(dev);
        restoreRouteOwnership('builder', beforeState?.[currentStory ?? '']);
        if (builderOutcome !== 'completed') {
          builderRollback = rollbackIfUnvalidatedPass('builder', dev);
          // evidence=引擎机械事实：agentBlocked 不能硬编码 false——agent 可能同轮已置 blocked:true
          // 又以非零码退出（如仲裁上报后环境异常收尾），此处需实时读一次 state 反映真实情况。
          const blockedNow = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
          recordIteration({
            agentBlocked: blockedNow,
            builderOutcome, ...(builderRollback ? { abortRollback: { storyId: currentStory! } } : {}),
          });
          dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
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
          recordIteration({ builderOutcome: 'completed', noop: true });
          tamperCheckBeforeExit(i);
          dashboard.setState({ phase: 'done', model: null, routeSource: null, storyDifficulty: null });
          exitCode = convergedExit(before, beforeState);
          break;
        }
        console.warn('⏭️  本轮 builder 无任何产出（state/progress 双无变化），跳过门禁与验收');
        const escalationTriggered = triggerEscalation('noop');
        recordIteration({
          builderOutcome: 'completed', noop: true,
          ...(escalationTriggered ? { escalationTriggeredBy: 'noop' as const } : {}),
        });
        dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
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
        dashboard.setState({
          phase: 'gating', model: null, routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
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
            const failed = applyGateFailure(st, currentStory, gate.failure!, new Date());
            const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
            writeFileAtomicSync(statePath, JSON.stringify(enabled.state, null, 2));
            if (enabled.changed) console.log(`⬆️  ${currentStory} 首次有效失败（gate），下轮起使用 escalation 模型`);
            recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}), validatorOutcome: 'skipped', gateRejected: true,
              ...(enabled.changed ? { escalationTriggeredBy: 'gate' as const } : {}),
            });
          } else {
            // 缺失/损坏都不落盘打回：绝不覆盖可能损坏的文件（同 ensureStateFile 语义）
            console.warn('⚠️  state.json 缺失或不可读，门禁打回未落盘；若文件损坏请运行 npx coding-x repair');
          }
          if (!st) recordIteration({
            ...(builderOutcome ? { builderOutcome } : {}), validatorOutcome: 'skipped', gateRejected: true,
          });
          stallCount = 0; // 有 state 写入=有活动；打回预算由 MAX_RETRIES 独立约束
          // 已知不对称：门禁把最后一个 story 打到 blocked 时，本轮 continue 跳过完成判定，
          // 完成要到下一轮才被发现；发生在末轮迭代时退出码为 1（validator 打回则当轮判定）。低频且 blocked→1 语义诚实，接受。
          dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
          continue;
        }
      }

      // Validator
      const validatorChoice = resolveValidatorModel({ cliOverride: cfg.validatorModel, config: preflight.config });
      const validatorModel = validatorChoice.model;
      const validatorWillRun = !!validator && !skipValidator && !agentBlocked;
      dashboard.setState({
        phase: 'validating', model: validatorWillRun ? (validatorModel ?? null) : null,
        routeSource: validatorWillRun ? validatorChoice.source : null,
        storyDifficulty: currentStoryObj?.difficulty ?? null,
      });
      let validatorOutcome: 'completed' | 'timeout' | 'error' | 'skipped' | undefined;
      let validatorRollback = false;
      let validatorEscalationTriggered = false;
      if (validator && skipValidator) {
        console.warn('⚠️  prd.json 快照写回失败，跳过本轮 validator（磁盘验收标准不可信）');
        validatorOutcome = 'skipped';
      } else if (validator && !agentBlocked) {
        console.log(`🧠 validator 实际模型: ${validatorModel ?? 'runner 默认'} [${validatorChoice.source}]`);
        const validatorStateBefore = currentStory ? tryReadState(statePath)?.[currentStory] : undefined;
        const val = await runAgent({
          kind: runKind, prompt: validator, cwd: agentCwd, timeoutMs: cfg.valTimeoutMs,
          model: validatorModel,
        });
        validatorOutcome = outcomeOf(val);
        restoreRouteOwnership('validator', validatorStateBefore);
        if (validatorOutcome !== 'completed') {
          // validator 异常结局：本轮 builder 置的 true 未经复核 → 回写待复核
          validatorRollback = rollbackIfUnvalidatedPass('validator', val);
        } else if (currentStory && validatorStateBefore) {
          const validatorStateAfter = tryReadState(statePath)?.[currentStory];
          const rejected = !!validatorStateAfter
            && !validatorStateAfter.passes
            && validatorStateAfter.retryCount > validatorStateBefore.retryCount;
          if (rejected) validatorEscalationTriggered = triggerEscalation('validator');
        }
      } else if (validator && agentBlocked) {
        validatorOutcome = 'skipped';
      }

      // 每轮一条 iteration 不变式：continue 路径（builder 异常/no-op/门禁打回）各自留痕后跳出，
      // 走到这里的轮在此记录——evidence 时间线零空洞（v0.22.0，dogfood 发现 B）。
      recordIteration({
        validatorRan: !!validator && !skipValidator && !agentBlocked,
        validatorModel: validatorModel ?? null,
        validatorRouteSource: validatorChoice.source,
        skippedValidator: skipValidator, agentBlocked,
        ...(builderOutcome ? { builderOutcome } : {}),
        ...(validatorOutcome ? { validatorOutcome } : {}),
        ...(validatorRollback ? { abortRollback: { storyId: currentStory! } } : {}),
        ...(validatorEscalationTriggered ? { escalationTriggeredBy: 'validator' as const } : {}),
      });

      if (validatorOutcome === 'timeout' || validatorOutcome === 'error') {
        if (stalled()) { tamperCheckBeforeExit(i); break; }
      } else {
        stallCount = 0; // 正常走完的轮（含 agentBlocked/skipValidator 跳过轮）清零
      }

      // Completion check
      dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
      const afterRead = guard.read();
      recordTamper(afterRead, i);
      const after = afterRead.prd;
      const afterState = after ? readRunState(statePath, after) : null;
      if (after && afterState && allStoriesResolved(after, afterState)) {
        dashboard.setState({ phase: 'done', model: null, routeSource: null, storyDifficulty: null });
        exitCode = convergedExit(after, afterState);
        break;
      }
    }
    // 循环终轮收口（第五处，ADR-007 交互残洞）：builder 异常/no-op 的 continue 路径
    // （:238/:273）在 i === maxIterations 且未触发 stall 熔断时自然耗尽本次运行，
    // 中间不会再有下一轮轮首读——本轮若被篡改，只有这里补一次 guard.read() 才能恢复/存档。
    // 对四个既有 break 出口而言是安全的幂等重复调用：它们各自最后一步已是同轮读，
    // break 前后都未再写 prd.json，磁盘已等于快照，这里的 read() 真无操作（prd-guard.ts:115）。
    const closeRead = guard.read();
    recordTamper(closeRead, cfg.maxIterations);
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
      const url = `http://localhost:${server!.address().port}`;
      console.log(`\n✅ 运行结束（退出码 ${exitCode}）。仪表盘仍在 ${url} ，按 Ctrl+C 退出。`);
      await (cfg.interrupt ?? waitForSigint());
    }
    return exitCode;
  } finally {
    lock.release(); // 幂等：正常路径已释放则短路；异常路径在此兜底
    server?.close();
  }
}

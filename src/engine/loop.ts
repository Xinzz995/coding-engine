import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { runAgent, type AgentKind } from './agent.js';
import { type Prd } from './prd.js';
import { createPrdGuard } from './prd-guard.js';
import { ensureStateFile, blankStateFor, tryReadState, getCurrentStoryId, allStoriesResolved, type RunState } from './state.js';
import { runQualityChecks, readQualityChecks, applyGateFailure, MAX_RETRIES, ARBITRATION_PREFIXES } from './gate.js';
import { readModelsConfig, resolveBuilderModel, resolveValidatorModel } from './models.js';
import * as dashboard from '../dashboard/server.js';

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
    // 模型路由警告去重：非法 models 配置的警告每轮都会重新产生，同一条只打一次
    const warnedModels = new Set<string>();
    const warnModelsOnce = (msgs: string[]) => {
      for (const m of msgs) {
        if (!warnedModels.has(m)) { warnedModels.add(m); console.warn(m); }
      }
    };
    let exitCode = 1;
    for (let i = 1; i <= cfg.maxIterations; i++) {
      const beforeRead = guard.read();
      const before = beforeRead.prd;
      // 写回失败=磁盘仍是篡改版=本轮 validator 读到的验收标准不可信 → 跳过（下轮开头重试恢复）
      let skipValidator = beforeRead.restoreFailed;
      const beforeState = before ? readRunState(statePath, before) : null;
      const currentStory = before && beforeState ? getCurrentStoryId(before, beforeState) : null;
      const modelsRead = readModelsConfig(before);
      warnModelsOnce(modelsRead.warnings);
      const currentStoryObj = before?.userStories.find((s) => s.id === currentStory) ?? null;
      const retryCount = currentStory && beforeState ? (beforeState[currentStory]?.retryCount ?? 0) : 0;
      const builderChoice = resolveBuilderModel({
        cliOverride: cfg.builderModel, config: modelsRead.config, story: currentStoryObj, retryCount,
      });
      warnModelsOnce(builderChoice.warnings);

      dashboard.setState({ iteration: i, phase: 'developing', currentStory, model: builderChoice.model ?? null });

      // Developer
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
        if (dev.timedOut) {
          dashboard.setState({ phase: 'idle', model: null });
          continue; // skip validator, retry next iteration
        }
      }

      // 机械门禁：builder 之后、validator 之前确定性执行质量检查（fail-fast）。
      // 失败即机械打回并跳过本轮 validator——builder 谎报「检查通过」在此被零成本戳穿。
      // 第四检测点：builder 刚跑完、validator 未拉起——本轮 builder 的篡改必须在此恢复，
      // 否则 validator（独立进程直读磁盘）当轮就会按假 AC 验收（ADR-007）。
      const gateRead = guard.read();
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
        if (!gate.ok) {
          console.error(`\n❌ 机械门禁未通过（${gate.failure!.command}），打回 ${currentStory} 待下轮重试`);
          const st = tryReadState(statePath);
          if (st) {
            const next = applyGateFailure(st, currentStory, gate.failure!, new Date());
            writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf-8');
          } else {
            // 缺失/损坏都不落盘打回：绝不覆盖可能损坏的文件（同 ensureStateFile 语义）
            console.warn('⚠️  state.json 缺失或不可读，门禁打回未落盘；若文件损坏请运行 npx coding-x repair');
          }
          // 已知不对称：门禁把最后一个 story 打到 blocked 时，本轮 continue 跳过完成判定，
          // 完成要到下一轮才被发现；发生在末轮迭代时退出码为 1（validator 打回则当轮判定）。低频且 blocked→1 语义诚实，接受。
          dashboard.setState({ phase: 'idle', model: null });
          continue;
        }
      }

      // Validator
      const validatorModel = resolveValidatorModel({ cliOverride: cfg.validatorModel, config: modelsRead.config });
      dashboard.setState({ phase: 'validating', model: validatorModel ?? null });
      if (validator && skipValidator) {
        console.warn('⚠️  prd.json 快照写回失败，跳过本轮 validator（磁盘验收标准不可信）');
      } else if (validator && !agentBlocked) {
        if (validatorModel) console.log(`🧠 validator 模型: ${validatorModel}`);
        await runAgent({
          kind: cfg.kind, prompt: validator, cwd: agentCwd, timeoutMs: cfg.valTimeoutMs,
          model: validatorModel,
        });
      }

      // Completion check
      dashboard.setState({ phase: 'idle', model: null });
      const after = guard.read().prd;
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
    if (cfg.keepOpen) {
      const url = `http://localhost:${server.address().port}`;
      console.log(`\n✅ 运行结束（退出码 ${exitCode}）。仪表盘仍在 ${url} ，按 Ctrl+C 退出。`);
      await (cfg.interrupt ?? waitForSigint());
    }
    return exitCode;
  } finally {
    server.close();
  }
}

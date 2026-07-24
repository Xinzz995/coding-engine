import type { Prd } from './prd.js';
import { blankStateFor, tryReadState, type RunState } from './state.js';

export function waitForSigint(): Promise<void> {
  return new Promise((resolve) => process.once('SIGINT', () => resolve()));
}

// 运行期读取执行状态；缺失/损坏时按全部未开始处理（绝不覆盖原文件，交给 repair）。
export function readRunState(statePath: string, prd: Prd): RunState {
  const state = tryReadState(statePath);
  if (state) return state;
  console.warn('⚠️  state.json 缺失或不可读，本轮按全部 story 未开始处理；若文件损坏请运行 npx coding-x repair');
  return blankStateFor(prd);
}

// 收敛出口单源：两个 allStoriesResolved 出口（no-op 快路径/轮末完成判定）共用，
// blocked>0 时 exit 3——「收敛但待人工」对所有出口成立（ADR-009/发现 D）
export function convergedExit(prd: Prd, state: RunState): number {
  const blockedIds = prd.userStories.filter((story) => state[story.id]?.blocked)
    .map((story) => story.id);
  if (blockedIds.length > 0) {
    const passedCount = prd.userStories.length - blockedIds.length;
    console.log(`\n⏸️  ${passedCount} 个 story 通过，${blockedIds.length} 个 blocked 待人工处理（${blockedIds.join(', ')}）。处理后重跑引擎收敛剩余项；人审入口见 .workspace/report.html 与 state.json notes。`);
    return 3;
  }
  console.log('\n✅ 实现已验证：全部 story 通过。交付尚未就绪；可先运行 /review-loop（复用 quality review）获取本地反馈，再提交 PR 让最新提交通过远端质量门禁；合并后运行 /compound-docs 收口。');
  return 0;
}

import { describe, it, expect } from 'vitest';
import { renderReportHtml, escapeHtml, renderMarkdownLite } from './render.js';
import type { ReportData } from './report.js';
import type { EvidenceRecord } from '../engine/evidence.js';
import type { ModelsConfig } from '../engine/prd.js';
import { acceptanceHash } from '../contracts/validation-contract.js';

function withModelsConfig(): ModelsConfig {
  return {
    runner: 'claude', builder: { low: 'fast-m', medium: 'mid-m', high: 'high-m' },
    validator: 'val-m', escalation: 'esc-m',
  };
}

function data(over: Partial<ReportData> = {}): ReportData {
  return {
    workspace: '.workspace',
    generatedAt: new Date('2026-07-08T12:34:00'),
    prdSource: 'disk',
    prd: {
      project: 'proj', branchName: 'ralph/x', description: 'd',
      userStories: [
        { id: 'US-001', title: '第一个', description: 'd', acceptanceCriteria: ['能打开页面'], priority: 1 },
      ],
    },
    stories: [
      {
        id: 'US-001', title: '第一个', description: 'd', acceptanceCriteria: ['能打开页面'],
        priority: 1, passes: true, validated: true, notes: '', retryCount: 0, blocked: false, escalated: false,
      },
    ],
    stateCorrupted: false,
    storyValidation: {
      gitHead: 'b'.repeat(40),
      current: true,
      invalidStoryIds: [],
      configurationError: null,
    },
    progress: '',
    reviews: [],
    tamperedArchives: [],
    screenshots: [],
    evidence: { records: [], skippedLines: 0 },
    finalReview: { read: { status: 'missing' }, current: false, staleReasons: [] },
    ...over,
  };
}

function ev(records: EvidenceRecord[], skippedLines = 0) {
  return { evidence: { records, skippedLines } };
}

function readyReview(shadow = false): ReportData['finalReview'] {
  const remote = {
    status: 'ready' as const,
    checks: [],
    rulesetErrors: [],
    checkedAt: '2026-07-08T12:34:00Z',
  };
  return {
    current: true,
    staleReasons: [],
    refreshedRemote: remote,
    read: {
      status: 'ready',
      state: {
      schemaVersion: 2,
      status: 'passed',
      deliveryStatus: shadow ? 'shadow' : 'ready',
      binding: {
        prNumber: 9, targetBranch: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
        prTitleDigest: 'title', prBodyDigest: 'body', specDigest: 'spec',
        engineeringStandardsDigest: 'standards', qualityContractDigest: 'contract',
        validationEnvironmentDigest: `sha256:${'0'.repeat(64)}`,
        codingXVersion: '0.30.0', runner: 'codex', model: 'gpt-test', runnerVersion: '1.0.0',
        reviewRulesVersion: '1.0.0', reviewRulesDigest: 'rules', riskDigest: 'risk',
        storyValidationDigest: `sha256:${'c'.repeat(64)}`,
      },
      risk: {
        triggered: false, categories: [], reasons: [], changedFiles: ['src/a.ts'],
        changedModules: ['src'], digest: 'risk',
      },
      axes: [{
        axis: 'spec', status: 'passed', summary: 'ok', findings: [],
        requestDeepReview: false, durationMs: 1, attempts: 1,
      }],
      remote,
      round: 1, shadow, startedAt: '2026-07-08T12:33:00Z', completedAt: '2026-07-08T12:34:00Z',
      },
    },
  };
}

describe('escapeHtml', () => {
  it('转义 & < > "', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});
describe('renderMarkdownLite 六构造', () => {
  it('标题映射 h4-h6（报告自身占用 h1-h3）', () => {
    expect(renderMarkdownLite('# A')).toBe('<h4>A</h4>');
    expect(renderMarkdownLite('## B')).toBe('<h5>B</h5>');
    expect(renderMarkdownLite('### C')).toBe('<h6>C</h6>');
  });
  it('列表、粗体、内联 code、段落', () => {
    const out = renderMarkdownLite('- 项目 **重点** `代码`\n\n普通段落');
    expect(out).toContain('<ul><li>项目 <strong>重点</strong> <code>代码</code></li></ul>');
    expect(out).toContain('<p>普通段落</p>');
  });
  it('围栏代码块内不再解析构造且转义生效', () => {
    const out = renderMarkdownLite('```\n- 不是列表 <b>\n```');
    expect(out).toContain('<pre class="code-block">- 不是列表 &lt;b&gt;</pre>');
  });
  it('md 文本先转义：注入标记不落地', () => {
    expect(renderMarkdownLite('<script>alert(1)</script>')).not.toContain('<script>');
  });
});

describe('renderReportHtml', () => {
  it('骨架：DOCTYPE、中文 lang、标题带 project、生成时间与 workspace 入页脚区', () => {
    const html = renderReportHtml(data());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('proj · 验证报告');
    expect(html).toContain('2026-07-08 12:34');
    expect(html).toContain('.workspace');
    expect(html).toContain('不自证写入后 workspace owner 已安全释放');
  });

  it('prd 缺 project/branchName 等必填字段时不抛，仍输出报告骨架（tryReadPrd 无逐字段守卫的脏数据防御）', () => {
    const brokenPrd = { description: 'd' } as unknown as ReportData['prd'];
    expect(() => renderReportHtml(data({ prd: brokenPrd }))).not.toThrow();
    const html = renderReportHtml(data({ prd: brokenPrd }));
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('通过 / blocked / 未完成徽章，重试次数仅 >0 显示', () => {
    const passed = renderReportHtml(data());
    expect(passed).toContain('✅ 通过');
    expect(passed).not.toContain('重试');
    const s = data().stories[0];
    const blocked = renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: true, retryCount: 5 }],
    }));
    expect(blocked).toContain('⛔ blocked');
    expect(blocked).toContain('重试 5 次');
    const pending = renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: false }],
    }));
    expect(pending).toContain('⬜ 未完成');
  });

  it('结果横幅三态', () => {
    expect(renderReportHtml(data())).toContain('Story 验证完成 1/1');
    const s = data().stories[0];
    expect(renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: true }],
    }))).toContain('blocked');
    expect(renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: false }],
    }))).toContain('进行中');
  });

  it('当前 HEAD 不可读取或凭证过期时不会展示 Story 完成绿灯', () => {
    const unavailable = renderReportHtml(
      data({
        storyValidation: {
          gitHead: null,
          current: false,
          invalidStoryIds: ['US-001'],
          configurationError: null,
        },
      }),
    );
    expect(unavailable).toContain('当前 Git HEAD 不可读取');
    expect(unavailable).not.toContain('Story 验证完成');

    const stale = renderReportHtml(
      data({
        storyValidation: {
          gitHead: 'c'.repeat(40),
          current: false,
          invalidStoryIds: ['US-001'],
          configurationError: null,
        },
      }),
    );
    expect(stale).toContain('Story 验收凭证已过期：US-001');
    expect(stale).not.toContain('Story 验证完成');
  });

  it('配置错误即使与 current=true 错误组合也会由渲染边界撤销绿灯', () => {
    const html = renderReportHtml(
      data({
        storyValidation: {
          gitHead: 'c'.repeat(40),
          current: true,
          invalidStoryIds: [],
          configurationError: 'userStories 包含重复 Story ID：US-001',
        },
      }),
    );
    expect(html).toContain('Story 验收配置或观察不可用：userStories 包含重复 Story ID：US-001');
    expect(html).toContain('🟨 待引擎验收');
    expect(html).not.toContain('✅ 通过');
  });

  it('只让过期 Story 失去验收状态，保留同一报告中仍有效的 Story', () => {
    const first = data().stories[0];
    const second = {
      ...first,
      id: 'US-002',
      title: '第二个',
      acceptanceCriteria: ['仍然有效'],
    };
    const html = renderReportHtml(
      data({
        prd: {
          ...data().prd,
          userStories: [
            data().prd.userStories[0],
            {
              id: 'US-002',
              title: '第二个',
              description: 'd',
              acceptanceCriteria: ['仍然有效'],
              priority: 2,
            },
          ],
        },
        stories: [first, second],
        storyValidation: {
          gitHead: 'c'.repeat(40),
          current: false,
          invalidStoryIds: ['US-001'],
          configurationError: null,
        },
      }),
    );

    expect(html).toMatch(/US-001 第一个 <span class="badge pending">🟨 待引擎验收<\/span>/u);
    expect(html).toMatch(/US-002 第二个 <span class="badge ok">✅ 通过<\/span>/u);
  });

  it('把 Story、本地 Review 和 GitHub 交付分开显示', () => {
    const pending = renderReportHtml(data());
    expect(pending).toContain('Story 结果不等于可交付');
    expect(pending).toContain('本地最终 Review 尚未运行');

    const ready = renderReportHtml(data({ finalReview: readyReview() }));
    expect(ready).toContain('本地 Review 与 GitHub 交付条件已就绪');
    expect(ready).toContain('PR #9');

    const staleReview = readyReview();
    staleReview.current = false;
    staleReview.staleReasons = ['Runner 版本已变化'];
    const stale = renderReportHtml(data({ finalReview: staleReview }));
    expect(stale).toContain('本地最终 Review 已过期或未完成当前性核验');
    expect(stale).toContain('Runner 版本已变化');
    expect(stale).not.toContain('本地 Review 与 GitHub 交付条件已就绪');

    const localOnlyReview = readyReview();
    delete localOnlyReview.refreshedRemote;
    const localOnly = renderReportHtml(data({ finalReview: localOnlyReview }));
    expect(localOnly).toContain('GitHub 交付条件尚未重新核验');
    expect(localOnly).not.toContain('本地 Review 与 GitHub 交付条件已就绪');

    const shadow = renderReportHtml(data({ finalReview: readyReview(true) }));
    expect(shadow).toContain('Shadow 结果不能表示可交付');

    const corrupted = renderReportHtml(data({ finalReview: readyReview(), stateCorrupted: true }));
    expect(corrupted).toContain('Story 状态未完成或不可验证，不能交付');
    expect(corrupted).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('空 userStories 显式警示横幅：不落入「进行中 0/0」', () => {
    const html = renderReportHtml(data({ stories: [] }));
    expect(html).toContain('没有任何 story');
    expect(html).not.toContain('进行中');
  });

  it('AC 逐条呈现且转义', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{ ...s, acceptanceCriteria: ['支持 <b> 标签展示'] }],
    }));
    expect(html).toContain('支持 &lt;b&gt; 标签展示');
  });

  it('AC 非数组形状时不抛，卡片仍渲染（tryReadPrd 无逐字段守卫的脏数据防御）', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{ ...s, acceptanceCriteria: 'nope' as unknown as string[] }],
    }));
    expect(html).toContain(s.id);
  });

  it('源 PRD：未设置整行省略；设置则显示路径', () => {
    expect(renderReportHtml(data())).not.toContain('源 PRD');
    const withSource = data();
    withSource.prd.sourcePrd = 'docs/prds/x.md';
    const html = renderReportHtml(withSource);
    expect(html).toContain('源 PRD');
    expect(html).toContain('docs/prds/x.md');
  });

  it('notes 行分类高亮：仲裁/门禁/Validator 失败/BLOCKED', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{
        ...s, passes: false,
        notes: '[需求冲突] 与文档矛盾\n[门禁失败 - 第1次] 2026-07-08 12:00\n[验证失败 - 第2次] 2026-07-08 12:10\n[BLOCKED: 已达到最大重试次数，跳过此 story]\n普通行',
      }],
    }));
    expect(html).toContain('class="note-line arbitration"');
    expect(html).toContain('class="note-line gate-fail"');
    expect(html).toContain('class="note-line blocked-line"');
    expect(html).toContain('[验证失败 - 第2次]');
  });

  it('notes 注入不执行：<script> 必须被转义', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{ ...s, notes: '<script>alert(1)</script>' }],
    }));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('截图画廊：相对 src、URL 编码、builder/validator 分组、非图片成链接、未归类单列', () => {
    const html = renderReportHtml(data({
      screenshots: [
        { filename: 'builder-US-001-1.png', storyId: 'US-001', phase: 'builder', isImage: true },
        { filename: 'validator us 001.png', storyId: 'US-001', phase: 'validator', isImage: true },
        { filename: 'builder-US-001-export.pdf', storyId: 'US-001', phase: 'builder', isImage: false },
        { filename: 'random.png', storyId: null, phase: null, isImage: true },
      ],
    }));
    expect(html).toContain('src="screenshots/builder-US-001-1.png"');
    expect(html).toContain('screenshots/validator%20us%20001.png');
    expect(html).toContain('builder 截图');
    expect(html).toContain('validator 截图');
    expect(html).toContain('builder-US-001-export.pdf');
    expect(html).not.toContain('img src="screenshots/builder-US-001-export.pdf"');
    expect(html).toContain('未归类工件');
    expect(html).toContain('random.png');
  });

  it('非图片链接强制下载而非浏览器内联打开；所有 target="_blank" 链接加 rel 防 window.opener 反向访问', () => {
    const html = renderReportHtml(data({
      screenshots: [
        { filename: 'builder-US-001-1.png', storyId: 'US-001', phase: 'builder', isImage: true },
        { filename: 'builder-US-001-export.pdf', storyId: 'US-001', phase: 'builder', isImage: false },
      ],
    }));
    expect(html).toContain(' download');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('红旗区条件渲染：有 tampered 才出现', () => {
    expect(renderReportHtml(data())).not.toContain('红旗区');
    const html = renderReportHtml(data({ tamperedArchives: ['prd.tampered-20260708-010101.json'] }));
    expect(html).toContain('红旗区');
    expect(html).toContain('prd.tampered-20260708-010101.json');
    expect(html).toContain('ADR-007');
  });

  it('历史 review Markdown 只作为本地反馈展示，不再声称是可信留痕', () => {
    expect(renderReportHtml(data())).toContain('尚无历史 Markdown 反馈');
    const html = renderReportHtml(data({
      reviews: [{ filename: 'review-2026-07-08.md', content: '## 层 2 发现清单\n- 发现 A' }],
    }));
    expect(html).toContain('review-2026-07-08.md');
    expect(html).toContain('<h5>层 2 发现清单</h5>');
    expect(html).toContain('<li>发现 A</li>');
    expect(html).not.toContain('尚无人审包');
    expect(html).toContain('不能作为通过证明');
    expect(html).toContain('GitHub 检查与 PR 历史');
  });

  it('progress 折叠附录：空则整节省略，有则在 details 内', () => {
    expect(renderReportHtml(data())).not.toContain('过程记录');
    const html = renderReportHtml(data({ progress: '## Codebase Patterns\n- 约定一' }));
    expect(html).toContain('<details>');
    expect(html).toContain('过程记录');
    expect(html).toContain('<li>约定一</li>');
  });

  it('质量契约快照：缺失、旧数组和非法形状告警，结构化快照列出检查', () => {
    expect(renderReportHtml(data())).toContain('PRD 未绑定派生快照');
    const withChecks = data();
    withChecks.prd.qualityChecks = {
      test: { checks: [{
        id: 'tests', module: 'root', command: {
          executable: 'npm', args: ['test'], cwd: '.', platforms: ['linux'], timeoutMs: 1000,
        },
      }] },
      build: { notApplicable: '无需构建' },
      static: { notApplicable: 'fixture' },
      security: { notApplicable: 'fixture' },
    };
    const html = renderReportHtml(withChecks);
    expect(html).toContain('质量契约派生检查');
    expect(html).toContain('<code>tests</code>');
    expect(html).toContain('无需构建');
    const legacy = data();
    legacy.prd.qualityChecks = ['npm test'];
    expect(renderReportHtml(legacy)).toContain('旧版字符串命令数组');
    const invalid = data();
    (invalid.prd as { qualityChecks?: unknown }).qualityChecks = 'npm test';
    expect(renderReportHtml(invalid)).toContain('派生快照形状非法');
  });

  it('模型路由：未配置整行省略；配置则显示', () => {
    expect(renderReportHtml(data())).not.toContain('模型路由');
    const withModels = data();
    withModels.prd.models = withModelsConfig();
    for (const story of withModels.prd.userStories) {
      story.difficulty = 'medium';
      story.difficultyReason = '命中 medium-1：沿用 src/api.ts 的既有接线模式。';
    }
    const html = renderReportHtml(withModels);
    expect(html).toContain('模型路由');
    expect(html).toContain('fast-m');
    expect(html).toContain('esc-m');
  });

  it('模型路由：models 形状非法显示警示，不与未配置混同', () => {
    const invalid = data();
    (invalid.prd as { models?: unknown }).models = 'opus';
    const html = renderReportHtml(invalid);
    expect(html).toContain('形状非法');
    expect(html).not.toContain('模型路由：');
  });

  it('模型路由：旧 escalateAfter 格式显示重新派生警示', () => {
    const withInvalidEscalate = data();
    (withInvalidEscalate.prd as { models?: unknown }).models = { ...withModelsConfig(), escalateAfter: 0 };
    const html = renderReportHtml(withInvalidEscalate);
    expect(html).toContain('escalateAfter');
    expect(html).toContain('prd-to-json');
  });

  it('模型路由：旧 profiles 格式显示重新派生警示', () => {
    const withProfiles = data();
    (withProfiles.prd as { models?: unknown }).models = { ...withModelsConfig(), profiles: { fast: { claude: 'sonnet' } } };
    const html = renderReportHtml(withProfiles);
    expect(html).toContain('models.profiles');
    expect(html).toContain('prd-to-json');
  });

  it('state 损坏时横幅与 story 卡都 fail-closed，不显示任何通过态', () => {
    expect(renderReportHtml(data())).not.toContain('state.json 已损坏');
    const html = renderReportHtml(data({ stateCorrupted: true }));
    expect(html).toContain('state.json 已损坏');
    expect(html).toContain('状态不可验证');
    expect(html).toContain('按全部 story 未验证处理');
    expect(html).not.toContain('全部通过');
    expect(html).not.toContain('✅ 通过');
  });

  it('引擎自动报告标明 PRD 来自启动快照，手动磁盘报告不冒充快照', () => {
    expect(renderReportHtml(data())).not.toContain('引擎启动快照');
    expect(renderReportHtml(data({ prdSource: 'engine-snapshot' }))).toContain('引擎启动快照');
  });

  it('报告零浏览器 JS', () => {
    expect(renderReportHtml(data())).not.toContain('<script');
  });
});

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
      { type: 'gate-run', source: 'engine', at: '2026-07-08T06:10:00.000Z', iteration: 2, storyId: 'US-001', ok: false, total: 2, ran: 1, ms: 500, failedCommand: 'npm test', exitCode: 7, timedOut: false, diagnosticTail: 'FAIL test_x\n<b>expected 1</b>' },
    ])));
    expect(html).toContain('门禁执行历史');
    expect(html).toContain('✅ 通过');
    expect(html).toContain('❌ 未通过');
    expect(html).toContain('2/2');
    expect(html).toContain('1/2');
    expect(html).toContain('npm test');
    expect(html).toContain('退出码 7');
    expect(html).toContain('门禁输出尾部');
    expect(html).toContain('FAIL test_x');
    expect(html).toContain('&lt;b&gt;expected 1&lt;/b&gt;');
    expect(html).not.toContain('<b>expected 1</b>');
    expect(html).toContain('防伪加固属后续评估'); // engine 记录区免责标注（A3，发现 5 裁决）
  });

  it('TDD 配置与最终门禁历史明确区分政策完整性和覆盖命令', () => {
    const input = data(ev([
      {
        type: 'tdd-gate', source: 'engine', at: '2026-07-23T06:00:00.000Z',
        phase: 'preflight', iteration: 0, storyId: null,
        ok: true, policyOk: true, commandRan: false, ms: 10,
      },
      {
        type: 'tdd-gate', source: 'engine', at: '2026-07-23T06:10:00.000Z',
        phase: 'post-builder', iteration: 1, storyId: 'US-001',
        ok: false, policyOk: true, commandRan: true, ms: 500,
        failureCode: 'coverage-check-failed', failedCommand: 'npm run coverage',
        exitCode: 7, timedOut: false, diagnosticTail: 'branch 80% < 90%',
      },
    ]));
    input.prd.tdd = {
      coverageCheck: 'npm run coverage',
      sourcePathspecs: [':(glob)src/**'],
      policyFiles: [{ path: 'vitest.config.ts', sha256: 'a'.repeat(64) }],
      baselineRef: 'b'.repeat(40),
      forbiddenAddedPatterns: ['c8 ignore'],
    };
    const html = renderReportHtml(input);
    expect(html).toContain('TDD 门禁：已启用');
    expect(html).toContain('npm run coverage');
    expect(html).toContain('TDD 门禁执行历史');
    expect(html).toContain('启动预检');
    expect(html).toContain('政策通过');
    expect(html).toContain('覆盖命令未通过');
    expect(html).toContain('branch 80% &lt; 90%');
  });

  it('提交漂移后保留命令事实，但成功、失败和 HEAD 不可读都明确显示结果未采用', () => {
    const head = 'a'.repeat(40);
    const html = renderReportHtml(data(ev([
      {
        type: 'gate-run', source: 'engine', at: '2026-08-02T06:00:00.000Z',
        iteration: 1, storyId: 'US-001', ok: true, total: 1, ran: 1, ms: 20,
        accepted: false,
      },
      {
        type: 'gate-run', source: 'engine', at: '2026-08-02T06:01:00.000Z',
        iteration: 2, storyId: 'US-001', ok: false, total: 1, ran: 1, ms: 20,
        accepted: false, failedCommand: 'npm test', exitCode: 1, timedOut: false,
      },
      {
        type: 'tdd-gate', source: 'engine', at: '2026-08-02T06:02:00.000Z',
        phase: 'post-builder', iteration: 3, storyId: 'US-001', ok: true,
        policyOk: true, commandRan: true, ms: 20, accepted: false,
      },
      {
        type: 'iteration', source: 'engine', at: '2026-08-02T06:03:00.000Z',
        iteration: 3, storyId: 'US-001', builderRan: false, builderModel: null,
        validatorRan: false, validatorModel: null, skippedValidator: false,
        agentBlocked: false,
        validationHeadAbort: {
          phase: 'validator-start', reason: 'head-unreadable',
          expectedGitHead: head, actualGitHead: null,
          diagnostic: 'Validator 请求建立前无法读取 HEAD',
        },
      },
    ])));
    expect(html).toContain('⚠️ 已执行，结果未采用（命令通过）');
    expect(html).toContain('⚠️ 已执行，结果未采用（命令未通过）');
    expect(html).toContain('覆盖命令通过，结果未采用');
    expect(html).toContain('检查链中止：提交身份不可读@validator-start');
    expect(html).toContain('实际 unavailable');
    expect(html).not.toContain('✅ 通过</td><td>1/1');
  });

  it('同轮后续边界才发现提交漂移时，已通过的 gate 与 TDD 也不显示绿灯', () => {
    const head = 'a'.repeat(40);
    const runId = '11111111-1111-4111-8111-111111111111';
    const html = renderReportHtml(data(ev([
      {
        type: 'gate-run', source: 'engine', at: '2026-08-02T07:00:00.000Z',
        runId, iteration: 4, storyId: 'US-001', ok: true, total: 1, ran: 1, ms: 20,
      },
      {
        type: 'tdd-gate', source: 'engine', at: '2026-08-02T07:00:01.000Z',
        runId, phase: 'post-builder', iteration: 4, storyId: 'US-001', ok: true,
        policyOk: true, commandRan: true, commandOk: true, ms: 20,
      },
      {
        type: 'iteration', source: 'engine', at: '2026-08-02T07:00:02.000Z',
        runId, iteration: 4, storyId: 'US-001', builderRan: false, builderModel: null,
        validatorRan: false, validatorModel: null, skippedValidator: false,
        agentBlocked: false,
        validationHeadAbort: {
          phase: 'validator-start', reason: 'head-unreadable',
          expectedGitHead: head, actualGitHead: null, diagnostic: 'HEAD unreadable',
        },
      },
    ])));
    expect(html).toContain(
      '<tr><td>4</td><td>US-001</td><td>⚠️ 已执行，结果未采用（命令通过）</td>',
    );
    expect(html).toContain(
      '<tr><td>第 4 轮</td><td>US-001</td><td>⚠️ 流程结束，结果未采用（覆盖命令通过）</td>',
    );
    expect(html).not.toContain(
      '<tr><td>4</td><td>US-001</td><td>✅ 通过</td>',
    );
    expect(html).not.toContain(
      '<tr><td>第 4 轮</td><td>US-001</td><td>✅ 通过</td>',
    );
  });

  it('coverage 成功但命令后政策复核失败时，报告不把覆盖命令写成失败', () => {
    const html = renderReportHtml(data(ev([{
      type: 'tdd-gate', source: 'engine', at: '2026-08-02T08:00:00.000Z',
      phase: 'post-builder', iteration: 5, storyId: 'US-001', ok: false,
      policyOk: false, commandRan: true, commandOk: true, ms: 20,
      failureCode: 'policy-hash-mismatch', failedCommand: '[tdd-policy]',
      exitCode: null, timedOut: false, diagnosticTail: 'policy changed after command',
    }])));
    expect(html).toContain('政策未通过');
    expect(html).toContain('覆盖命令通过');
    expect(html).not.toContain('覆盖命令未通过');
  });

  it('跨进程重复 iteration 编号不会把已经闭合的历史轮误标成未采用', () => {
    const head = 'a'.repeat(40);
    const firstRun = '11111111-1111-4111-8111-111111111111';
    const secondRun = '22222222-2222-4222-8222-222222222222';
    const iteration = {
      type: 'iteration' as const, source: 'engine' as const,
      storyId: 'US-001', builderRan: false, builderModel: null,
      validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
    };
    const html = renderReportHtml(data(ev([
      {
        type: 'gate-run', source: 'engine', at: '2026-08-02T08:10:00.000Z',
        runId: firstRun, iteration: 1, storyId: 'US-001', ok: true, total: 1, ran: 1, ms: 20,
      },
      { ...iteration, runId: firstRun, at: '2026-08-02T08:10:01.000Z', iteration: 1 },
      {
        type: 'gate-run', source: 'engine', at: '2026-08-02T08:20:00.000Z',
        runId: secondRun, iteration: 1, storyId: 'US-001', ok: true, total: 1, ran: 1, ms: 20,
      },
      {
        ...iteration, runId: secondRun, at: '2026-08-02T08:20:01.000Z', iteration: 1,
        validationHeadAbort: {
          phase: 'validator-start' as const, reason: 'head-unreadable' as const,
          expectedGitHead: head, actualGitHead: null, diagnostic: 'HEAD unreadable',
        },
      },
    ])));
    expect(html.match(/<td>✅ 通过<\/td><td>1\/1<\/td>/gu)).toHaveLength(1);
    expect(html.match(/⚠️ 已执行，结果未采用（命令通过）/gu)).toHaveLength(1);
  });

  it('旧运行缺少 closing iteration 时也不会被新运行的漂移误伤', () => {
    const head = 'a'.repeat(40);
    const firstRun = '11111111-1111-4111-8111-111111111111';
    const secondRun = '22222222-2222-4222-8222-222222222222';
    const html = renderReportHtml(data(ev([
      {
        type: 'gate-run', source: 'engine', at: '2026-08-02T08:10:00.000Z',
        runId: firstRun, iteration: 1, storyId: 'US-001', ok: true,
        total: 1, ran: 1, ms: 20,
      },
      {
        type: 'gate-run', source: 'engine', at: '2026-08-02T08:20:00.000Z',
        runId: secondRun, iteration: 1, storyId: 'US-001', ok: true,
        total: 1, ran: 1, ms: 20,
      },
      {
        type: 'iteration', source: 'engine', at: '2026-08-02T08:20:01.000Z',
        runId: secondRun, iteration: 1, storyId: 'US-001',
        builderRan: false, builderModel: null, validatorRan: false, validatorModel: null,
        skippedValidator: false, agentBlocked: false,
        validationHeadAbort: {
          phase: 'validator-start', reason: 'head-unreadable',
          expectedGitHead: head, actualGitHead: null, diagnostic: 'HEAD unreadable',
        },
      },
    ])));
    expect(html.match(/<td>✅ 通过<\/td><td>1\/1<\/td>/gu)).toHaveLength(1);
    expect(html.match(/⚠️ 已执行，结果未采用（命令通过）/gu)).toHaveLength(1);
  });

  it('状态保护覆盖总失败原因时仍展示 coverage 命令的真实失败', () => {
    const html = renderReportHtml(data(ev([{
      type: 'tdd-gate', source: 'engine', at: '2026-08-02T08:30:00.000Z',
      phase: 'post-builder', iteration: 6, storyId: 'US-001', ok: false,
      policyOk: false, commandRan: true, commandOk: false, ms: 20,
      failureCode: 'source-scan-failed', failedCommand: '[state-ownership]',
      exitCode: null, timedOut: false, diagnosticTail: '状态被恢复',
    }])));
    expect(html).toContain('覆盖命令未通过');
    expect(html).not.toContain('覆盖命令通过</td>');
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
    // A5（triage 14）：越界/缺省 claim 只应落在 story 级登记行，不应混进 AC 徽标列表
    const acsSection = /<ul class="acs">[\s\S]*?<\/ul>/.exec(html);
    expect(acsSection).not.toBeNull();
    expect(acsSection![0]).not.toContain('builder-US-001-1.png');
    expect(acsSection![0]).not.toContain('builder-US-001-2.png');
  });

  it('claim 的 acIndex 非整数（如 1.5）归 story 级登记，不静默丢弃（发现 1）', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{ ...s, acceptanceCriteria: ['第一条', '第二条'] }],
      ...ev([
        { type: 'screenshot-claim', source: 'builder', at: '2026-07-08T06:00:00.000Z', storyId: 'US-001', file: 'builder-US-001-noninteger.png', acIndex: 1.5 },
      ]),
    }));
    expect(html).toContain('story 级登记');
    expect(html).toContain('builder-US-001-noninteger.png');
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
    expect(html).toContain('防伪加固属后续评估'); // engine 记录区免责标注（A3，发现 5 裁决）
  });

  it('Agent 调用凭证展示耗时/退出码，并把异常输出按纯文本转义', () => {
    const html = renderReportHtml(data(ev([{
      type: 'iteration', source: 'engine', at: '2026-07-22T10:40:23.145Z',
      iteration: 1, storyId: 'US-001', builderRan: true, builderModel: null,
      validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
      builderOutcome: 'error',
      builderInvocation: {
        durationMs: 4571, exitCode: 1,
        diagnosticTail: 'API Error: 402 <script>Account overdue</script>',
      },
    }])));
    expect(html).toContain('4.6s · exit 1');
    expect(html).toContain('Builder 进程输出尾部');
    expect(html).toContain('API Error: 402 &lt;script&gt;Account overdue&lt;/script&gt;');
    expect(html).not.toContain('<script>Account overdue</script>');
  });

  it('Agent 调用凭证单独展示输出通道终止原因', () => {
    const html = renderReportHtml(data(ev([{
      type: 'iteration', source: 'engine', at: '2026-07-22T10:40:23.145Z',
      iteration: 1, storyId: 'US-001', builderRan: true, builderModel: null,
      validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
      builderOutcome: 'error',
      builderInvocation: {
        durationMs: 812, exitCode: null, terminationReason: 'output-failure',
        diagnosticTail: 'builder output before sink failure',
      },
    }])));
    expect(html).toContain('0.8s · exit unavailable · reason output-failure');
    expect(html).toContain('builder output before sink failure');
  });

  it('validator 打回诊断进入时间线且按纯文本转义', () => {
    const html = renderReportHtml(data(ev([{
      type: 'iteration', source: 'engine', at: '2026-07-08T06:00:00.000Z',
      iteration: 1, storyId: 'US-001', builderRan: true, builderModel: null,
      validatorRan: true, validatorModel: null, skippedValidator: false, agentBlocked: false,
      builderOutcome: 'completed', validatorOutcome: 'completed',
      validatorDiagnostic: 'AC 2 未通过\n<img src=x onerror=alert(1)>',
    }])));
    expect(html).toContain('Validator 打回详情');
    expect(html).toContain('AC 2 未通过');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('结构化 claim 与协议错误分源展示并转义 agent 文本', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    const html = renderReportHtml(data(ev([
      {
        type: 'validation-claim', source: 'validator', at: '2026-07-22T06:00:00.000Z',
        iteration: 2, requestId: 'request-2', storyId: 'US-001',
        acceptanceHash: hash, gitHead: null, verdict: 'failed',
        checks: [{ acIndex: 1, passed: false, evidence: '收到 200 <script>alert(1)</script>' }],
        summary: 'AC 1 未通过',
      },
      {
        type: 'iteration', source: 'engine', at: '2026-07-22T06:00:01.000Z',
        iteration: 2, storyId: 'US-001', builderRan: true, builderModel: null,
        validatorRan: true, validatorModel: null, skippedValidator: false, agentBlocked: false,
        validationProtocol: 'invalid',
        validationTarget: {
          requestId: 'request-2', storyId: 'US-001', acceptanceHash: hash, gitHead: null,
        },
        validationProtocolError: { code: 'state-mutated', diagnostic: 'Validator 修改 state.json' },
        validatorStateMutation: true,
        validationRollback: true,
      },
    ])));

    expect(html).toContain('Validator 结构化声明');
    expect(html).toContain('source=validator');
    expect(html).toContain('是否最终采用');
    expect(html).toContain('同轮时间线、当前提交与验收凭证');
    expect(html).toContain('不是安全签名或 CI 证明');
    expect(html).toContain('❌ AC 1');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('结构化验收协议无效');
    expect(html).toContain('Git unavailable');
    expect(html).toContain('结构化验收协议错误');
    expect(html).toContain('state-mutated: Validator 修改 state.json');
    expect(html).toContain('Validator 改写 <code>state.json</code>');
    expect(html).toContain('拒绝该轮 claim');
  });

  it('passes=true 但无引擎验收凭证时不显示全绿', () => {
    const base = data();
    const html = renderReportHtml(data({
      stories: [{ ...base.stories[0], validated: false }],
    }));
    expect(html).toContain('待引擎验收');
    expect(html).toContain('进行中：0/1 通过');
    expect(html).not.toContain('全部通过 1/1');
  });

  it('明确显示仍绑定当前提交的 Validator 不可验证状态', () => {
    const base = data();
    const currentHead = base.storyValidation.gitHead!;
    const target = base.stories[0];
    const html = renderReportHtml(
      data({
        stories: [
          {
            ...target,
            validated: false,
            validatorUnverifiable: {
              schemaVersion: 1,
              gitHead: currentHead,
              acceptanceHash: acceptanceHash(target.id, target.acceptanceCriteria),
            },
          },
        ],
      }),
    );
    expect(html).toContain('Validator 无法可靠验证：US-001');
    expect(html).toContain('Validator 无法验证');
    expect(html).not.toContain('待引擎验收');
  });

  it('blocked 优先于矛盾的 passes 与 validated 组合', () => {
    const base = data();
    const html = renderReportHtml(data({
      stories: [{ ...base.stories[0], blocked: true }],
    }));
    expect(html).toContain('⛔ blocked');
    expect(html).toContain('0 通过 · 1 blocked');
    expect(html).not.toContain('全部通过 1/1');
  });

  it('验收凭证签发、回写与 validated 篡改进入时间线和红旗区', () => {
    const html = renderReportHtml(data(ev([
      {
        type: 'iteration', source: 'engine', at: '2026-07-22T06:00:00.000Z',
        iteration: 3, storyId: 'US-001', builderRan: true, builderModel: null,
        validatorRan: true, validatorModel: null, skippedValidator: false, agentBlocked: false,
        validationReceipt: true,
      },
      {
        type: 'iteration', source: 'engine', at: '2026-07-22T06:01:00.000Z',
        iteration: 4, storyId: 'US-002', builderRan: true, builderModel: null,
        validatorRan: false, validatorModel: null, skippedValidator: true, agentBlocked: false,
        validationRollback: true,
        stateValidationTamper: [{ expected: false, received: true, side: 'builder' }],
      },
    ])));
    expect(html).toContain('验收凭证已签发');
    expect(html).toContain('未签发验收凭证，已回写待复核');
    expect(html).toContain('改写 validated（false → true）已恢复');
    expect(html).toContain('引擎独占字段 <code>validated</code>');
    expect(html).toContain('红旗区：运行期状态 / PRD 篡改');
  });

  it('跨 story 所有权篡改展示实际目标，旧 evidence 回退轮次 storyId', () => {
    const html = renderReportHtml(data(ev([
      {
        type: 'iteration', source: 'engine', at: '2026-07-22T06:02:00.000Z',
        iteration: 5, storyId: 'US-001', builderRan: true, builderModel: null,
        validatorRan: true, validatorModel: null, skippedValidator: false, agentBlocked: false,
        stateValidationTamper: [
          { storyId: 'US-002', expected: false, received: true, side: 'builder' },
          { expected: false, received: 'missing', side: 'validator' },
        ],
      },
    ])));
    expect(html).toContain('US-002：builder 改写 validated（false → true）已恢复');
    expect(html).toContain('US-001：validator 改写 validated（false → missing）已恢复');
    expect(html).toContain('US-002：builder 改写引擎独占字段 <code>validated</code>');
    expect(html).toContain('US-001：validator 改写引擎独占字段 <code>validated</code>');
  });

  it('路由证据展示难度、实际模型来源、升级触发与状态篡改', () => {
    const base = data();
    const html = renderReportHtml(data({
      stories: [{
        ...base.stories[0], difficulty: 'high', difficultyReason: '命中 high-2：跨模块修改。', escalated: true,
      }],
      ...ev([{
        type: 'iteration', source: 'engine', at: '2026-07-08T06:00:00.000Z',
        iteration: 2, storyId: 'US-001', builderRan: true, builderModel: 'esc-m',
        validatorRan: true, validatorModel: 'val-m', skippedValidator: false, agentBlocked: false,
        storyDifficulty: 'high', builderRouteSource: 'escalation', validatorRouteSource: 'validator',
        escalationTriggeredBy: 'validator',
        stateRouteTamper: [{ expected: true, received: false, side: 'builder' }],
      }]),
    }));
    expect(html).toContain('命中 high-2');
    expect(html).toContain('⬆️ 已升级');
    expect(html).toContain('esc-m [escalation]');
    expect(html).toContain('val-m [validator]');
    expect(html).toContain('已触发升级（validator）');
    expect(html).toContain('改写 escalated（true → false）已恢复');
    expect(html).toContain('引擎独占字段');
  });

  it('renderTimeline validator 列三种跳过归因：agent blocked / 快照写回失败 / 未跑（triage 13）', () => {
    const base = {
      type: 'iteration' as const, source: 'engine' as const, at: '2026-07-08T06:00:00.000Z',
      iteration: 1, storyId: 'US-001', builderRan: true, builderModel: null,
      validatorRan: false, validatorModel: null,
    };
    const blockedHtml = renderReportHtml(data(ev([{ ...base, skippedValidator: false, agentBlocked: true }])));
    expect(blockedHtml).toContain('跳过（agent blocked）');
    const skippedHtml = renderReportHtml(data(ev([{ ...base, skippedValidator: true, agentBlocked: false }])));
    expect(skippedHtml).toContain('跳过（快照写回失败）');
    const notRunHtml = renderReportHtml(data(ev([{ ...base, skippedValidator: false, agentBlocked: false }])));
    expect(notRunHtml).toContain('未跑');
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

  it('tamper 记录带 archive 名但文件清单无匹配（归档已不在工作区）时补独立行，不留空 <ul>（发现 2）', () => {
    const html = renderReportHtml(data({
      tamperedArchives: [],
      ...ev([
        { type: 'tamper', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 4, archive: 'prd.tampered-20260708-070000.json' },
      ]),
    }));
    expect(html).toContain('红旗区');
    expect(html).toContain('已不在工作区');
    expect(html).not.toContain('<ul></ul>');
  });

  it('renderRedFlags 删除类篡改（archive:null）单独成行（triage 13）', () => {
    const html = renderReportHtml(data(ev([
      { type: 'tamper', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 5, archive: null },
    ])));
    expect(html).toContain('红旗区');
    expect(html).toContain('删除类篡改（无存档）');
    expect(html).toContain('第 5 轮');
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

describe('时间线区异常轮标注', () => {
  it('timeout/error/noop/gateRejected 轮在时间线行上可辨', () => {
    const base = {
      type: 'iteration' as const, source: 'engine' as const, at: '2026-07-08T06:00:00.000Z',
      storyId: 'US-001', builderRan: true, builderModel: null,
      validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
    };
    const html = renderReportHtml(data(ev([
      { ...base, iteration: 1, builderOutcome: 'timeout', abortRollback: { storyId: 'US-001' } },
      { ...base, iteration: 2, noop: true, builderOutcome: 'completed' },
      { ...base, iteration: 3, gateRejected: true, validatorOutcome: 'skipped' },
      { ...base, iteration: 4, builderOutcome: 'completed', validatorOutcome: 'completed' },
    ])));
    expect(html).toContain('builder 超时');
    expect(html).toContain('空转');
    expect(html).toContain('门禁打回');
    expect(html).toContain('已回写');
  });

  it('旧 evidence（无新字段）时间线渲染与 0.21.0 一致（零破坏）', () => {
    const html = renderReportHtml(data(ev([
      { type: 'iteration', source: 'engine', at: '2026-07-08T06:00:00.000Z', iteration: 1, storyId: 'US-001', builderRan: true, builderModel: 'fast-m', validatorRan: true, validatorModel: 'val-m', skippedValidator: false, agentBlocked: false },
    ])));
    expect(html).toContain('轮次时间线');
    expect(html).not.toContain('空转（无产出）');
    expect(html).toContain('<td>—</td>');
  });

  it('notes 中断标记行按引擎行样式高亮', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{
        ...s, passes: false,
        notes: '[中断轮待复核] 2026-07-17 10:00 builder 执行超时被终止：本轮 passes 置位未经完整验收，已回写；请确认实现后重新走完门禁与验收',
      }],
    }));
    expect(html).toContain('[中断轮待复核]');
    // 语义即「按引擎行样式高亮」——同 gate-fail 行复用同一 CSS 类，非纯文本可见性
    expect(html).toContain('class="note-line gate-fail"');
  });
});

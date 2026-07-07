import { describe, it, expect } from 'vitest';
import { renderReportHtml, escapeHtml, renderMarkdownLite } from './render.js';
import type { ReportData } from './report.js';

function data(over: Partial<ReportData> = {}): ReportData {
  return {
    workspace: '.workspace',
    generatedAt: new Date('2026-07-08T12:34:00'),
    prd: {
      project: 'proj', branchName: 'ralph/x', description: 'd',
      userStories: [
        { id: 'US-001', title: '第一个', description: 'd', acceptanceCriteria: ['能打开页面'], priority: 1 },
      ],
    },
    stories: [
      {
        id: 'US-001', title: '第一个', description: 'd', acceptanceCriteria: ['能打开页面'],
        priority: 1, passes: true, notes: '', retryCount: 0, blocked: false,
      },
    ],
    stateCorrupted: false,
    progress: '',
    reviews: [],
    tamperedArchives: [],
    screenshots: [],
    ...over,
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
  });

  it('徽章三态：通过 ✅ / blocked ⛔ / 未完成 ⬜，重试次数仅 >0 显示', () => {
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
    expect(renderReportHtml(data())).toContain('全部通过 1/1');
    const s = data().stories[0];
    expect(renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: true }],
    }))).toContain('blocked');
    expect(renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: false }],
    }))).toContain('进行中');
  });

  it('AC 逐条呈现且转义', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{ ...s, acceptanceCriteria: ['支持 <b> 标签展示'] }],
    }));
    expect(html).toContain('支持 &lt;b&gt; 标签展示');
  });

  it('notes 行分类高亮：仲裁标签行/门禁失败行/BLOCKED 行', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{
        ...s, passes: false,
        notes: '[需求冲突] 与文档矛盾\n[门禁失败 - 第1次] 2026-07-08 12:00\n[BLOCKED: 已达到最大重试次数，跳过此 story]\n普通行',
      }],
    }));
    expect(html).toContain('class="note-line arbitration"');
    expect(html).toContain('class="note-line gate-fail"');
    expect(html).toContain('class="note-line blocked-line"');
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

  it('红旗区条件渲染：有 tampered 才出现', () => {
    expect(renderReportHtml(data())).not.toContain('红旗区');
    const html = renderReportHtml(data({ tamperedArchives: ['prd.tampered-20260708-010101.json'] }));
    expect(html).toContain('红旗区');
    expect(html).toContain('prd.tampered-20260708-010101.json');
    expect(html).toContain('ADR-007');
  });

  it('review 留痕：无 → 占位指引；有 → 渲染 md 内容', () => {
    expect(renderReportHtml(data())).toContain('尚无人审包');
    const html = renderReportHtml(data({
      reviews: [{ filename: 'review-2026-07-08.md', content: '## 层 2 发现清单\n- 发现 A' }],
    }));
    expect(html).toContain('review-2026-07-08.md');
    expect(html).toContain('<h5>层 2 发现清单</h5>');
    expect(html).toContain('<li>发现 A</li>');
    expect(html).not.toContain('尚无人审包');
  });

  it('progress 折叠附录：空则整节省略，有则在 details 内', () => {
    expect(renderReportHtml(data())).not.toContain('过程记录');
    const html = renderReportHtml(data({ progress: '## Codebase Patterns\n- 约定一' }));
    expect(html).toContain('<details>');
    expect(html).toContain('过程记录');
    expect(html).toContain('<li>约定一</li>');
  });

  it('门禁配置：未配置显示未启用；配置则逐条列出；形状非法显示警示', () => {
    expect(renderReportHtml(data())).toContain('机械门禁：未启用');
    const withChecks = data();
    withChecks.prd.qualityChecks = ['npm test', 'npm run typecheck'];
    const html = renderReportHtml(withChecks);
    expect(html).toContain('npm test');
    expect(html).toContain('npm run typecheck');
    const invalid = data();
    (invalid.prd as { qualityChecks?: unknown }).qualityChecks = 'npm test';
    expect(renderReportHtml(invalid)).toContain('形状非法');
  });

  it('模型路由：未配置整行省略；配置则显示', () => {
    expect(renderReportHtml(data())).not.toContain('模型路由');
    const withModels = data();
    withModels.prd.models = { builder: 'fast-m', validator: 'val-m', escalation: 'esc-m' };
    const html = renderReportHtml(withModels);
    expect(html).toContain('模型路由');
    expect(html).toContain('fast-m');
    expect(html).toContain('esc-m');
  });

  it('state 损坏警示条件渲染', () => {
    expect(renderReportHtml(data())).not.toContain('state.json 已损坏');
    expect(renderReportHtml(data({ stateCorrupted: true }))).toContain('state.json 已损坏');
  });

  it('报告零浏览器 JS', () => {
    expect(renderReportHtml(data())).not.toContain('<script');
  });
});

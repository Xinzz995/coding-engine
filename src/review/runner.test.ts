import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  codexReviewPermissionOverrides,
  parseCodexReviewJsonl,
  parseModelReviewOutput,
} from './runner.js';

function valid(over: Record<string, unknown> = {}) {
  return {
    status: 'failed', summary: '发现一个阻断问题', requestDeepReview: false,
    findings: [{
      severity: 'P1', title: '错误传播丢失', location: { path: 'src/a.ts', line: 4 },
      ruleSource: 'AGENTS.md', impact: '调用方会收到假成功', recommendation: '保留失败状态',
      requiresHumanDecision: false,
    }],
    ...over,
  };
}

describe('parseModelReviewOutput', () => {
  it('derives blocking status from findings instead of trusting a passed claim', () => {
    expect(parseModelReviewOutput(valid({ status: 'passed' })).status).toBe('failed');
  });

  it('allows non-blocking findings while deriving passed', () => {
    const output = valid({
      status: 'failed',
      findings: [{
        severity: 'P2', title: '命名可读性', location: { path: 'src/a.ts' },
        ruleSource: 'engineering baseline', impact: '增加理解成本', recommendation: '后续改名',
        requiresHumanDecision: false,
      }],
    });
    expect(parseModelReviewOutput(output).status).toBe('passed');
  });

  it('rejects malformed, unbound or ambiguous output shapes', () => {
    expect(() => parseModelReviewOutput(valid({ extra: true }))).toThrow('未知字段');
    expect(() => parseModelReviewOutput(valid({ status: 'unverifiable', findings: [] })))
      .toThrow('提供原因');
    expect(() => parseModelReviewOutput(valid({ findings: [], status: 'failed' })))
      .toThrow('failed 必须包含');
    expect(() => parseModelReviewOutput(valid({
      findings: [{ ...valid().findings[0], location: { path: '../secret' } }],
    }))).toThrow('仓库相对路径');
  });
});

describe('parseCodexReviewJsonl', () => {
  it('extracts only a structured final agent message', () => {
    const answer = { status: 'passed', summary: 'ok', requestDeepReview: false, findings: [] };
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'checked' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    expect(parseCodexReviewJsonl(stdout)).toEqual(answer);
  });

  it.each(['command_execution', 'mcp_tool_call', 'web_search', 'file_change'])(
    'rejects an observed %s tool event even if a final answer exists',
    (type) => {
      const stdout = [
        JSON.stringify({ type: 'item.started', item: { type } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }),
      ].join('\n');
      expect(() => parseCodexReviewJsonl(stdout)).toThrow(`禁用工具事件：${type}`);
    },
  );
});

describe('codexReviewPermissionOverrides', () => {
  it('defaults to deny and grants read-only access only to the exact review package root', () => {
    const cwd = '/tmp/review package';
    expect(codexReviewPermissionOverrides(cwd)).toEqual([
      '-c', 'default_permissions="coding_x_review"',
      '-c', `permissions.coding_x_review.filesystem={ ":minimal" = "read", ${JSON.stringify(resolve(cwd))} = "read" }`,
      '-c', 'permissions.coding_x_review.network.enabled=true',
    ]);
  });
});

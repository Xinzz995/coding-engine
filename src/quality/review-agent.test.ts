import { describe, expect, it } from 'vitest';
import { buildReadOnlyReviewArgs } from './review-agent.js';

describe('read-only review agent arguments', () => {
  it('uses Codex read-only sandbox without bypass flags', () => {
    const args = buildReadOnlyReviewArgs('codex', 'prompt', {
      schemaPath: '/tmp/schema.json',
      outputPath: '/tmp/output.json',
    });
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--ephemeral');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('uses Claude plan permission mode without bypass', () => {
    const args = buildReadOnlyReviewArgs('claude', 'prompt', {
      schemaPath: '/tmp/schema.json',
      outputPath: '/tmp/output.json',
    });
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('uses Cursor plan mode without force', () => {
    const args = buildReadOnlyReviewArgs('cursor', 'prompt', {
      schemaPath: '/tmp/schema.json',
      outputPath: '/tmp/output.json',
    });
    expect(args).toContain('--mode');
    expect(args).toContain('plan');
    expect(args).not.toContain('--force');
  });
});

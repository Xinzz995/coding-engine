import { describe, expect, it, vi } from 'vitest';
import {
  callGitHubModel,
  normalizeReviewModelOutput,
  reviewResponseSchema,
} from './model.js';

describe('review model output', () => {
  it('normalizes finding identity and axis instead of trusting the model', () => {
    const result = normalizeReviewModelOutput({
      summary: 'one issue',
      findings: [{
        severity: 'high',
        file: 'src/app.ts',
        line: 12,
        title: 'Missing authorization',
        evidence: 'handler accepts all users',
        source: 'AGENTS.md',
        impact: 'unauthorized access',
        recommendation: 'check role',
      }],
    }, 'standards');
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.output.findings[0]).toMatchObject({
        axis: 'standards',
        severity: 'high',
      });
      expect(result.output.findings[0].id).toMatch(/^standards:src-app-ts:12:/);
    }
  });

  it.each([
    { summary: 'x', findings: [{ severity: 'high' }] },
    { summary: 'x', findings: [{ severity: 'urgent', file: 'x', line: null, title: 'x', evidence: 'x', source: 'x', impact: 'x', recommendation: 'x' }] },
    { summary: 'x', findings: [{ severity: 'low', file: '../secret', line: null, title: 'x', evidence: 'x', source: 'x', impact: 'x', recommendation: 'x' }] },
    { summary: '', findings: [] },
    { summary: 'x', findings: [], extra: true },
  ])('rejects malformed or schema-extra output', (input) => {
    expect(normalizeReviewModelOutput(input, 'spec').status).toBe('invalid');
  });

  it('calls GitHub Models without tools and validates JSON content', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload.tool_choice).toBe('none');
      expect(payload.max_tokens).toBe(4_000);
      expect(payload.response_format).toEqual(reviewResponseSchema);
      expect(String(init?.headers && (init.headers as Record<string, string>).Authorization))
        .toBe('Bearer token-value');
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ summary: 'clear', findings: [] }),
          },
        }],
      }), { status: 200 });
    });
    const result = await callGitHubModel({
      token: 'token-value',
      model: 'openai/gpt-4.1',
      systemPrompt: 'system',
      userPrompt: 'user',
      axis: 'spec',
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toMatchObject({ status: 'valid', output: { summary: 'clear', findings: [] } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['HTTP error', new Response('rate limited', { status: 429 })],
    ['bad envelope', new Response(JSON.stringify({ choices: [] }), { status: 200 })],
    ['bad JSON', new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { status: 200 })],
  ])('fails closed on %s', async (_name, response) => {
    const result = await callGitHubModel({
      token: 'token',
      model: 'openai/gpt-4.1',
      systemPrompt: 'system',
      userPrompt: 'user',
      axis: 'spec',
      fetchImpl: vi.fn(async () => response) as unknown as typeof fetch,
    });
    expect(result.status).toBe('invalid');
  });

  it('classifies the GitHub Models free-tier input limit for lossless sharding', async () => {
    const result = await callGitHubModel({
      token: 'token',
      model: 'openai/gpt-4.1',
      systemPrompt: 'system',
      userPrompt: 'oversized',
      axis: 'spec',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: {
          code: 'tokens_limit_reached',
          message: 'Request body too large. Max size: 8000 tokens.',
        },
      }), { status: 413 })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({
      status: 'invalid',
      reason: 'input-too-large',
    });
  });
});

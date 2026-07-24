import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GitHubClient,
  parseGitHubPullRequestEvent,
  qualityBranchRulesetPayload,
  verifyQualityBranchRuleset,
} from './github.js';

describe('GitHub pull request event', () => {
  it('binds exact repository, PR, base and head identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quality-gh-event-'));
    const path = join(dir, 'event.json');
    writeFileSync(path, JSON.stringify({
      repository: { full_name: 'owner/repo' },
      pull_request: {
        number: 12,
        title: 'quality',
        body: 'body',
        base: { ref: 'main', sha: 'a'.repeat(40) },
        head: { sha: 'b'.repeat(40) },
      },
    }));
    expect(parseGitHubPullRequestEvent(path)).toEqual({
      repository: 'owner/repo',
      number: 12,
      title: 'quality',
      body: 'body',
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });
  });

  it.each([
    {},
    { repository: { full_name: 'owner/repo' }, pull_request: {} },
    {
      repository: { full_name: 'other/repo' },
      pull_request: { number: 1, title: 'x', body: '', base: { ref: 'main', sha: 'bad' }, head: { sha: 'bad' } },
    },
  ])('fails closed on malformed identity', (value) => {
    const dir = mkdtempSync(join(tmpdir(), 'quality-gh-event-invalid-'));
    const path = join(dir, 'event.json');
    writeFileSync(path, JSON.stringify(value));
    expect(() => parseGitHubPullRequestEvent(path)).toThrow();
  });
});

describe('GitHub API client', () => {
  it('never sends a token in URL or body and validates response envelopes', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain('secret-token');
      expect(String(init?.body ?? '')).not.toContain('secret-token');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
      return new Response(JSON.stringify({ full_name: 'owner/repo', default_branch: 'main' }), {
        status: 200,
      });
    });
    const client = new GitHubClient('secret-token', 'owner/repo', fetchImpl as typeof fetch);
    await expect(client.getRepository()).resolves.toEqual({
      fullName: 'owner/repo',
      defaultBranch: 'main',
    });
  });

  it('publishes a completed check against the exact supplied head SHA', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: 42, html_url: 'https://github.com/check/42' }), {
        status: 201,
      });
    });
    const client = new GitHubClient('token', 'owner/repo', fetchImpl as typeof fetch);
    const result = await client.createCheckRun({
      name: 'coding-x / spec-review',
      headSha: 'b'.repeat(40),
      status: 'failed',
      title: 'Spec review failed',
      summary: 'one finding',
      text: 'details',
    });
    expect(result.id).toBe(42);
    expect(calls[0].body).toMatchObject({
      name: 'coding-x / spec-review',
      head_sha: 'b'.repeat(40),
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('surfaces non-2xx response diagnostics without leaking authorization', async () => {
    const client = new GitHubClient(
      'top-secret',
      'owner/repo',
      vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch,
    );
    await expect(client.getRepository()).rejects.toThrow('HTTP 403');
    await expect(client.getRepository()).rejects.not.toThrow('top-secret');
  });
});

describe('quality ruleset payload', () => {
  it('requires PR, latest checks, resolved conversations and blocks force/delete', () => {
    const payload = qualityBranchRulesetPayload('main', [
      { context: 'coding-x / project-checks', integration_id: 15368 },
      { context: 'coding-x / spec-review', integration_id: 15368 },
    ]);
    expect(payload).toMatchObject({
      name: 'coding-x quality gate',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    });
    expect(payload.rules.map((rule) => rule.type)).toEqual([
      'deletion', 'non_fast_forward', 'pull_request', 'required_status_checks',
    ]);
    const pr = payload.rules.find((rule) => rule.type === 'pull_request');
    expect(pr?.parameters).toMatchObject({
      required_approving_review_count: 0,
      required_review_thread_resolution: true,
      dismiss_stale_reviews_on_push: true,
    });
    const checks = payload.rules.find((rule) => rule.type === 'required_status_checks');
    expect(checks?.parameters).toMatchObject({ strict_required_status_checks_policy: true });
  });

  it('detects disabled rules, bypass actors and forged check sources on readback', () => {
    const expectedChecks = [
      { context: 'coding-x / project-checks', integration_id: 15368 },
    ];
    const payload = qualityBranchRulesetPayload('main', expectedChecks, 1);
    const healthy = { id: 1, ...payload };
    expect(verifyQualityBranchRuleset(healthy, {
      branch: 'main',
      requiredChecks: expectedChecks,
      requiredApprovals: 1,
    })).toEqual([]);
    const drifted = {
      ...healthy,
      enforcement: 'disabled',
      bypass_actors: [{ actor_id: 1 }],
      rules: payload.rules.map((rule) => rule.type === 'required_status_checks'
        ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              required_status_checks: [{
                context: 'coding-x / project-checks',
                integration_id: 999,
              }],
            },
          }
        : rule),
    };
    expect(verifyQualityBranchRuleset(drifted, {
      branch: 'main',
      requiredChecks: expectedChecks,
      requiredApprovals: 1,
    }).join('\n')).toMatch(/未启用|绕过|来源/);
  });
});

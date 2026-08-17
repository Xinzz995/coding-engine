import { describe, expect, it } from 'vitest';
import {
  GitHubQualityError,
  type GitHubRulesetPayload,
} from './github.js';
import {
  GhGitHubQualityClient,
  type GitHubCommandExecutor,
  type GitHubCommandInvocation,
} from './github-unmanaged.js';

const REPOSITORY_JSON = JSON.stringify({
  nameWithOwner: 'owner/repository',
  defaultBranchRef: { name: 'main' },
  isPrivate: false,
});

function commandFailure(detail: string, code?: string): Error & { stderr: string; code?: string } {
  const error = new Error(detail) as Error & { stderr: string; code?: string };
  error.stderr = detail;
  if (code) error.code = code;
  return error;
}

function rulesetPayload(): GitHubRulesetPayload {
  return {
    name: 'test ruleset',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [],
  };
}

const RULESET_DETAIL = {
  id: 7,
  name: 'test ruleset',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [{ type: 'deletion' }],
  updated_at: '2026-08-17T00:00:00.000Z',
};
const RULESET_HISTORY = [
  { version_id: 99, updated_at: '2026-08-17T00:00:00.100Z' },
];
const RULESET_HISTORY_VERSION = {
  version_id: 99,
  updated_at: '2026-08-17T00:00:00.100Z',
  state: { ...RULESET_DETAIL, updated_at: null, bypass_actors: [] },
};

function apiPath(invocation: GitHubCommandInvocation): string {
  return invocation.args.at(-1) ?? '';
}

describe('GhGitHubQualityClient read retries', () => {
  it('recovers from a transient GraphQL EOF with bounded backoff', () => {
    const invocations: GitHubCommandInvocation[] = [];
    const delays: number[] = [];
    let attempt = 0;
    const executor: GitHubCommandExecutor = (invocation) => {
      invocations.push(invocation);
      attempt++;
      if (attempt === 1) throw commandFailure('Post "https://api.github.com/graphql": EOF');
      return REPOSITORY_JSON;
    };
    const client = new GhGitHubQualityClient({ executor, sleep: (ms) => delays.push(ms) });

    expect(client.discoverRepository('/project')).toEqual({
      fullName: 'owner/repository',
      defaultBranch: 'main',
      isPrivate: false,
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({ cwd: '/project', timeoutMs: 10_000 });
    expect(delays).toEqual([250]);
  });

  it('retries a transient REST GET without retrying writes', () => {
    const invocations: GitHubCommandInvocation[] = [];
    const delays: number[] = [];
    const executor: GitHubCommandExecutor = (invocation) => {
      invocations.push(invocation);
      if (invocations.length === 1) throw commandFailure('gh: HTTP 503: Service Unavailable');
      return '{}';
    };
    const client = new GhGitHubQualityClient({ executor, sleep: (ms) => delays.push(ms) });

    client.verifyDefaultBranch({
      fullName: 'owner/repository',
      defaultBranch: 'main',
      isPrivate: false,
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.args[0]).toBe('api');
    expect(invocations[0]?.timeoutMs).toBe(10_000);
    expect(delays).toEqual([250]);
  });

  it('fails closed after three transient read attempts', () => {
    let calls = 0;
    const delays: number[] = [];
    const client = new GhGitHubQualityClient({
      executor: () => {
        calls++;
        throw commandFailure('Get "https://api.github.com/repos/owner/repository": EOF');
      },
      sleep: (ms) => delays.push(ms),
    });

    try {
      client.discoverRepository('/project');
      throw new Error('expected discoverRepository to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubQualityError);
      expect(error).toMatchObject({ kind: 'transient', retryable: true, attempts: 3 });
    }
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it.each([
    ['gh: HTTP 401: Bad credentials', 'unauthenticated'],
    ['To get started with GitHub CLI, please run: gh auth login', 'unauthenticated'],
    ['gh: HTTP 403: Resource not accessible by integration', 'forbidden'],
    ['GraphQL: Resource not accessible by integration (repository)', 'forbidden'],
    ['GraphQL: Resource not accessible by personal access token (repository)', 'forbidden'],
    ['gh: HTTP 403: API rate limit exceeded', 'rate-limit'],
    ['gh: HTTP 429: Too Many Requests', 'rate-limit'],
    ['gh: HTTP 404: Not Found', 'not-found'],
    ['gh: HTTP 422: Validation Failed', 'validation'],
    ['gh: HTTP 501: Not Implemented', 'unknown'],
    ['gh: HTTP 501: temporary failure', 'unknown'],
    ['gh: HTTP 505: HTTP Version Not Supported', 'unknown'],
    ['gh: HTTP 506: Variant Also Negotiates', 'unknown'],
    ['gh: HTTP 400: operation timed out', 'unknown'],
    ['wsarecv: An invalid argument was supplied.', 'unknown'],
  ] as const)('does not retry permanent read failure %s', (detail, kind) => {
    let calls = 0;
    const client = new GhGitHubQualityClient({
      executor: () => {
        calls++;
        throw commandFailure(detail);
      },
      sleep: () => {
        throw new Error('permanent failures must not sleep');
      },
    });

    try {
      client.discoverRepository('/project');
      throw new Error('expected discoverRepository to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubQualityError);
      expect(error).toMatchObject({ kind, retryable: false, attempts: 1 });
    }
    expect(calls).toBe(1);
  });

  it.each([408, 500, 502, 503, 504])(
    'retries explicitly allowed HTTP %i read failure',
    (status) => {
      const invocations: GitHubCommandInvocation[] = [];
      const delays: number[] = [];
      const client = new GhGitHubQualityClient({
        executor: (invocation) => {
          invocations.push(invocation);
          if (invocations.length === 1) {
            throw commandFailure(`gh: HTTP ${status}: temporary read failure`);
          }
          return REPOSITORY_JSON;
        },
        sleep: (delayMs) => delays.push(delayMs),
      });

      expect(client.discoverRepository('/project').fullName).toBe('owner/repository');
      expect(invocations).toHaveLength(2);
      expect(invocations.every((invocation) => invocation.timeoutMs === 10_000)).toBe(true);
      expect(delays).toEqual([250]);
    },
  );

  it.each([
    'dial tcp 192.0.2.1:443: i/o timeout',
    'connect: connection refused',
    'connectex: A connection attempt failed because the connected party did not properly respond',
    'read tcp 192.0.2.10:53120->140.82.114.6:443: wsarecv: An existing connection was forcibly closed by the remote host.',
    'operation timed out',
    'lookup api.github.com: no such host',
    'error connecting to github.com\ncheck your internet connection or https://githubstatus.com',
  ])('retries common gh network failure %s', (detail) => {
    let calls = 0;
    const client = new GhGitHubQualityClient({
      executor: () => {
        calls++;
        if (calls === 1) throw commandFailure(detail);
        return REPOSITORY_JSON;
      },
      sleep: () => {},
    });

    expect(client.discoverRepository('/project').fullName).toBe('owner/repository');
    expect(calls).toBe(2);
  });

  it('classifies child-process timeout as transient and a missing gh binary as permanent', () => {
    let timeoutCalls = 0;
    const timeoutClient = new GhGitHubQualityClient({
      executor: () => {
        timeoutCalls++;
        if (timeoutCalls === 1) throw commandFailure('spawnSync gh ETIMEDOUT', 'ETIMEDOUT');
        return REPOSITORY_JSON;
      },
      sleep: () => {},
    });
    expect(timeoutClient.discoverRepository('/project').fullName).toBe('owner/repository');
    expect(timeoutCalls).toBe(2);

    let missingCalls = 0;
    const missingClient = new GhGitHubQualityClient({
      executor: () => {
        missingCalls++;
        throw commandFailure('spawnSync gh ENOENT', 'ENOENT');
      },
      sleep: () => {
        throw new Error('missing gh must not sleep');
      },
    });
    expect(() => missingClient.discoverRepository('/project')).toThrowError(
      expect.objectContaining({ kind: 'tool', retryable: false, attempts: 1 }),
    );
    expect(missingCalls).toBe(1);
  });

  it('does not retry invalid JSON or remote writes', () => {
    let invalidCalls = 0;
    const invalidClient = new GhGitHubQualityClient({
      executor: () => {
        invalidCalls++;
        return '{not-json';
      },
      sleep: () => {
        throw new Error('invalid JSON must not sleep');
      },
    });
    expect(() => invalidClient.discoverRepository('/project')).toThrowError(
      expect.objectContaining({ kind: 'invalid-response', retryable: false, attempts: 1 }),
    );
    expect(invalidCalls).toBe(1);

    const writeInvocations: GitHubCommandInvocation[] = [];
    const writeClient = new GhGitHubQualityClient({
      executor: (invocation) => {
        writeInvocations.push(invocation);
        if (invocation.args.includes('POST')) {
          throw commandFailure('gh: HTTP 503: Service Unavailable');
        }
        throw commandFailure(
          'wsarecv: An existing connection was forcibly closed by the remote host.',
        );
      },
      sleep: () => {
        throw new Error('writes must not sleep');
      },
    });
    expect(() => writeClient.createRuleset('owner/repository', rulesetPayload())).toThrowError(
      expect.objectContaining({ kind: 'transient', retryable: false, attempts: 1 }),
    );
    expect(writeInvocations).toHaveLength(1);
    expect(writeInvocations[0]?.args).toContain('POST');
    expect(writeInvocations[0]?.timeoutMs).toBeUndefined();

    expect(() => writeClient.updateRuleset('owner/repository', 7, rulesetPayload())).toThrowError(
      expect.objectContaining({ kind: 'transient', retryable: false, attempts: 1 }),
    );
    expect(writeInvocations).toHaveLength(2);
    expect(writeInvocations[1]?.args).toContain('PUT');
    expect(writeInvocations[1]?.timeoutMs).toBeUndefined();
  });

  it('does not let an injected retryable error bypass the HTTP allowlist', () => {
    let calls = 0;
    const client = new GhGitHubQualityClient({
      executor: () => {
        calls++;
        throw new GitHubQualityError('temporary failure', undefined, {
          kind: 'transient',
          httpStatus: 501,
          retryable: true,
        });
      },
      sleep: () => {
        throw new Error('unlisted HTTP status must not sleep');
      },
    });

    expect(() => client.discoverRepository('/project')).toThrowError(
      expect.objectContaining({
        kind: 'transient',
        httpStatus: 501,
        retryable: false,
        attempts: 1,
      }),
    );
    expect(calls).toBe(1);
  });

  it('uses the structured 404 status when creating a missing label', () => {
    const invocations: GitHubCommandInvocation[] = [];
    const executor: GitHubCommandExecutor = (invocation) => {
      invocations.push(invocation);
      if (invocations.length === 1) throw commandFailure('gh: HTTP 404: Not Found');
      return '{}';
    };
    const client = new GhGitHubQualityClient({ executor, sleep: () => {} });

    client.ensureLabel('owner/repository', 'quality-policy-approved', '0052cc', 'approved');

    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.args).toContain('POST');
    expect(invocations[1]?.timeoutMs).toBeUndefined();
  });

  it('keeps the direct ruleset path when bypass actors are visible', () => {
    const invocations: GitHubCommandInvocation[] = [];
    const client = new GhGitHubQualityClient({
      executor: (invocation) => {
        invocations.push(invocation);
        return apiPath(invocation).includes('?includes_parents=')
          ? JSON.stringify([{ id: 7 }])
          : JSON.stringify({ ...RULESET_DETAIL, bypass_actors: [] });
      },
      sleep: () => {},
    });

    expect(client.listRulesets('owner/repository')).toEqual([
      expect.objectContaining({ id: 7, bypass_actors: [] }),
    ]);
    expect(invocations.map(apiPath)).toEqual([
      'repos/owner/repository/rulesets?includes_parents=false&per_page=100',
      'repos/owner/repository/rulesets/7',
    ]);
  });

  it('recovers an omitted bypass list only from one stable latest history version', () => {
    const invocations: GitHubCommandInvocation[] = [];
    const client = new GhGitHubQualityClient({
      executor: (invocation) => {
        invocations.push(invocation);
        const path = apiPath(invocation);
        if (path.includes('?includes_parents=')) return JSON.stringify([{ id: 7 }]);
        if (path.endsWith('/history?per_page=1')) return JSON.stringify(RULESET_HISTORY);
        if (path.endsWith('/history/99')) return JSON.stringify(RULESET_HISTORY_VERSION);
        return JSON.stringify(RULESET_DETAIL);
      },
      sleep: () => {},
    });

    expect(client.listRulesets('owner/repository')).toEqual([
      expect.objectContaining({
        id: 7,
        name: 'test ruleset',
        bypass_actors: [],
        rules: [{ type: 'deletion' }],
      }),
    ]);
    expect(invocations.map(apiPath)).toEqual([
      'repos/owner/repository/rulesets?includes_parents=false&per_page=100',
      'repos/owner/repository/rulesets/7',
      'repos/owner/repository/rulesets/7/history?per_page=1',
      'repos/owner/repository/rulesets/7/history/99',
      'repos/owner/repository/rulesets/7',
      'repos/owner/repository/rulesets/7/history?per_page=1',
    ]);
  });

  it('rejects a ruleset history version race instead of reusing an old bypass list', () => {
    let historyReads = 0;
    const client = new GhGitHubQualityClient({
      executor: (invocation) => {
        const path = apiPath(invocation);
        if (path.includes('?includes_parents=')) return JSON.stringify([{ id: 7 }]);
        if (path.endsWith('/history?per_page=1')) {
          historyReads++;
          return JSON.stringify(
            historyReads === 1
              ? RULESET_HISTORY
              : [{ version_id: 100, updated_at: '2026-08-17T00:00:01.000Z' }],
          );
        }
        if (path.endsWith('/history/99')) return JSON.stringify(RULESET_HISTORY_VERSION);
        return JSON.stringify(RULESET_DETAIL);
      },
      sleep: () => {},
    });

    expect(() => client.listRulesets('owner/repository')).toThrow(
      '最新历史版本在补证期间变化',
    );
  });

  it('rejects a current ruleset detail race during history recovery', () => {
    let detailReads = 0;
    const client = new GhGitHubQualityClient({
      executor: (invocation) => {
        const path = apiPath(invocation);
        if (path.includes('?includes_parents=')) return JSON.stringify([{ id: 7 }]);
        if (path.endsWith('/history?per_page=1')) return JSON.stringify(RULESET_HISTORY);
        if (path.endsWith('/history/99')) return JSON.stringify(RULESET_HISTORY_VERSION);
        detailReads++;
        return JSON.stringify(
          detailReads === 1
            ? RULESET_DETAIL
            : { ...RULESET_DETAIL, updated_at: '2026-08-17T00:00:02.000Z' },
        );
      },
      sleep: () => {},
    });

    expect(() => client.listRulesets('owner/repository')).toThrow(
      '当前详情在历史补证期间变化',
    );
  });

  it.each([
    [
      'history state drift',
      { ...RULESET_HISTORY_VERSION, state: { ...RULESET_HISTORY_VERSION.state, rules: [] } },
      '历史状态与当前详情不一致',
    ],
    [
      'history bypass omission',
      {
        ...RULESET_HISTORY_VERSION,
        state: RULESET_DETAIL,
      },
      '缺少 bypass_actors',
    ],
  ])('rejects %s', (_label, historyVersion, message) => {
    const client = new GhGitHubQualityClient({
      executor: (invocation) => {
        const path = apiPath(invocation);
        if (path.includes('?includes_parents=')) return JSON.stringify([{ id: 7 }]);
        if (path.endsWith('/history?per_page=1')) return JSON.stringify(RULESET_HISTORY);
        if (path.endsWith('/history/99')) return JSON.stringify(historyVersion);
        return JSON.stringify(RULESET_DETAIL);
      },
      sleep: () => {},
    });

    expect(() => client.listRulesets('owner/repository')).toThrow(message);
  });
});

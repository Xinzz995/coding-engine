import { describe, expect, it } from 'vitest';
import { GitHubQualityError } from '../quality/github.js';
import { runBoundedGitHubReadRetry } from './github-read-retry.js';
import { ReviewTemporaryDirectoryError } from './temporary-directory.js';

function transient(attempts: number, detail = 'GraphQL EOF'): GitHubQualityError {
  return new GitHubQualityError('GitHub 远端暂时不可用', detail, {
    kind: 'transient',
    retryable: true,
    attempts,
  });
}

describe('bounded GitHub read retry controller', () => {
  it('does not start an attempt when already interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const delays: number[] = [];

    await expect(
      runBoundedGitHubReadRetry({
        operationName: '测试读取',
        attempt: async () => {
          calls++;
          return { status: 'complete', value: 'must-not-run' };
        },
        termination: {
          signal: controller.signal,
          error: () => new Error('测试读取已中断'),
        },
        sleep: (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toThrow('测试读取已中断');
    expect(calls).toBe(0);
    expect(delays).toEqual([]);
  });

  it('prefers an interruption received during an attempt over its result', async () => {
    const controller = new AbortController();
    let calls = 0;
    const delays: number[] = [];

    await expect(
      runBoundedGitHubReadRetry({
        operationName: '测试读取',
        attempt: async () => {
          calls++;
          controller.abort();
          return { status: 'complete', value: 'stale-success' };
        },
        termination: {
          signal: controller.signal,
          error: () => new Error('测试读取已中断'),
        },
        sleep: (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toThrow('测试读取已中断');
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('preserves a cleanup failure thrown after an interruption', async () => {
    const controller = new AbortController();
    const cleanupFailure = new ReviewTemporaryDirectoryError(
      'authority 临时域已保留 /tmp/retained：原始失败：GraphQL EOF；清理失败：EPERM',
    );
    let calls = 0;
    const delays: number[] = [];

    await expect(
      runBoundedGitHubReadRetry({
        operationName: '测试读取',
        attempt: async () => {
          calls++;
          controller.abort();
          throw cleanupFailure;
        },
        termination: {
          signal: controller.signal,
          error: () => new Error('测试读取已中断'),
        },
        sleep: (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toBe(cleanupFailure);
    expect(cleanupFailure.message).toBe(
      'authority 临时域已保留 /tmp/retained：原始失败：GraphQL EOF；清理失败：EPERM',
    );
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('recovers after one qualified transient failure with bounded backoff', async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(
      runBoundedGitHubReadRetry({
        operationName: '测试读取',
        attempt: async (attempt) => {
          calls++;
          return attempt === 1
            ? { status: 'retry', failure: transient(attempt) }
            : { status: 'complete', value: 'recovered' };
        },
        sleep: (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).resolves.toBe('recovered');
    expect(calls).toBe(2);
    expect(delays).toEqual([250]);
  });

  it('propagates a permanent failure without retrying', async () => {
    let calls = 0;
    const failure = new GitHubQualityError('GitHub API 权限不足', 'HTTP 403', {
      kind: 'forbidden',
      retryable: false,
      attempts: 1,
    });
    await expect(
      runBoundedGitHubReadRetry({
        operationName: '测试读取',
        attempt: async () => {
          calls++;
          throw failure;
        },
        sleep: () => {
          throw new Error('永久错误不得退避');
        },
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it('stops during backoff when interrupted', async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let calls = 0;
    await expect(
      runBoundedGitHubReadRetry({
        operationName: '测试读取',
        attempt: async (attempt) => {
          calls++;
          return { status: 'retry', failure: transient(attempt) };
        },
        termination: {
          signal: controller.signal,
          error: () => new Error('测试读取已中断'),
        },
        sleep: (delayMs) => {
          delays.push(delayMs);
          controller.abort();
        },
      }),
    ).rejects.toThrow('测试读取已中断');
    expect(calls).toBe(1);
    expect(delays).toEqual([250]);
  });

  it('reports three exhausted attempts and the final reason', async () => {
    const delays: number[] = [];
    let calls = 0;
    const error = await runBoundedGitHubReadRetry({
      operationName: '测试读取',
      attempt: async (attempt) => {
        calls++;
        return { status: 'retry', failure: transient(attempt, 'HTTP 503 final') };
      },
      sleep: (delayMs) => {
        delays.push(delayMs);
      },
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ kind: 'transient', retryable: true, attempts: 3 });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /测试读取连续 3 次失败：最后一次失败：HTTP 503 final/u,
    );
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it.each([
    ['ordinary success', null],
    ['identity drift result', 'PR 身份发生变化'],
  ] as const)('returns %s immediately', async (_name, value) => {
    let calls = 0;
    await expect(
      runBoundedGitHubReadRetry({
        operationName: '测试读取',
        attempt: async () => {
          calls++;
          return { status: 'complete', value };
        },
        sleep: () => {
          throw new Error('完成结果不得退避');
        },
      }),
    ).resolves.toBe(value);
    expect(calls).toBe(1);
  });
});

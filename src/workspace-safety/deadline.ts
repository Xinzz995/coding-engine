import { performance } from 'node:perf_hooks';

export interface MonotonicClock {
  now(): number;
}

const SYSTEM_MONOTONIC_CLOCK: MonotonicClock = Object.freeze({
  now: () => performance.now(),
});

/**
 * A phase owns one absolute deadline. Every wait in that phase must consume this object's
 * remaining budget instead of constructing a fresh relative timeout.
 */
export class MonotonicDeadline {
  #expiresAt: number;
  readonly #clock: MonotonicClock;

  private constructor(expiresAt: number, clock: MonotonicClock) {
    this.#expiresAt = expiresAt;
    this.#clock = clock;
  }

  static after(
    durationMs: number,
    clock: MonotonicClock = SYSTEM_MONOTONIC_CLOCK,
  ): MonotonicDeadline {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new TypeError('deadline duration must be a non-negative safe integer');
    }
    const now = clock.now();
    if (!Number.isFinite(now)) throw new TypeError('monotonic clock returned a non-finite value');
    return new MonotonicDeadline(now + durationMs, clock);
  }

  remainingMs(): number {
    const now = this.#clock.now();
    if (!Number.isFinite(now)) return 0;
    return Math.max(0, Math.ceil(this.#expiresAt - now));
  }

  get expired(): boolean {
    return this.remainingMs() === 0;
  }

  /** A later failure or termination may make a phase stricter, but can never extend it. */
  tightenAfter(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new TypeError('deadline duration must be a non-negative safe integer');
    }
    const now = this.#clock.now();
    if (!Number.isFinite(now)) {
      this.#expiresAt = Number.NEGATIVE_INFINITY;
      return;
    }
    this.#expiresAt = Math.min(this.#expiresAt, now + durationMs);
  }

  async run<T>(operation: () => T | PromiseLike<T>, timeoutError: () => Error): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining === 0) throw timeoutError();

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      if (this.expired) throw timeoutError();
      throw error;
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const rejectWhenExpired = (): void => {
        if (settled) return;
        const stillRemaining = this.remainingMs();
        if (stillRemaining > 0) {
          timer = setTimeout(rejectWhenExpired, stillRemaining);
          return;
        }
        settled = true;
        reject(timeoutError());
      };
      timer = setTimeout(rejectWhenExpired, remaining);
      void pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.expired) reject(timeoutError());
          else resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.expired) reject(timeoutError());
          else reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}

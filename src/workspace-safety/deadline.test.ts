import { describe, expect, it } from 'vitest';
import { MonotonicDeadline, type MonotonicClock } from './deadline.js';

class FakeClock implements MonotonicClock {
  value = 0;

  now(): number {
    return this.value;
  }
}

describe('MonotonicDeadline', () => {
  it('keeps one absolute budget when a phase advances through multiple waits', () => {
    const clock = new FakeClock();
    const deadline = MonotonicDeadline.after(100, clock);

    clock.value = 35;
    expect(deadline.remainingMs()).toBe(65);
    clock.value = 99.2;
    expect(deadline.remainingMs()).toBe(1);
    clock.value = 100;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired).toBe(true);
  });

  it('is unaffected by wall-clock rollback because only the injected monotonic clock is read', () => {
    const clock = new FakeClock();
    clock.value = 500;
    const deadline = MonotonicDeadline.after(40, clock);

    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      clock.value = 525;
      expect(deadline.remainingMs()).toBe(15);
    } finally {
      Date.now = originalNow;
    }
  });

  it('does not start an operation after the shared phase deadline expired', async () => {
    const clock = new FakeClock();
    const deadline = MonotonicDeadline.after(10, clock);
    clock.value = 10;
    let started = false;

    await expect(
      deadline.run(
        () => {
          started = true;
        },
        () => new Error('phase timed out'),
      ),
    ).rejects.toThrow(/phase timed out/u);
    expect(started).toBe(false);
  });

  it('rejects a successful operation that synchronously crosses the absolute deadline', async () => {
    const clock = new FakeClock();
    const deadline = MonotonicDeadline.after(10, clock);

    await expect(
      deadline.run(
        () => {
          clock.value = 10;
          return 'late success';
        },
        () => new Error('phase timed out'),
      ),
    ).rejects.toThrow(/phase timed out/u);
  });

  it('allows a termination transition to tighten but never extend an existing deadline', () => {
    const clock = new FakeClock();
    const deadline = MonotonicDeadline.after(100, clock);

    clock.value = 25;
    deadline.tightenAfter(40);
    expect(deadline.remainingMs()).toBe(40);

    clock.value = 35;
    deadline.tightenAfter(500);
    expect(deadline.remainingMs()).toBe(30);
  });
});

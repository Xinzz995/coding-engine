import { describe, expect, it } from 'vitest';
import { createTerminationTrigger as createPosixTerminationTrigger } from './posix-supervisor.js';
import { createTerminationTrigger as createWindowsTerminationTrigger } from './windows-supervisor-integration.js';

const factories = [
  ['POSIX', createPosixTerminationTrigger],
  ['Windows', createWindowsTerminationTrigger],
] as const;

describe.each(factories)('%s command deadline arbitration', (_platform, createTrigger) => {
  it('turns an event observed after the absolute deadline into timeout before the timer callback runs', () => {
    const trigger = createTrigger(20, undefined);
    trigger.startCommandTimer();
    const deadline = trigger.commandDeadline;
    if (!deadline) throw new Error('command deadline was not created');

    while (!deadline.expired) {
      // Keep the event loop blocked so the timeout callback cannot be the source of this verdict.
    }

    expect(trigger.reason).toBeUndefined();
    expect(trigger.commandDeadlineExpired()).toBe(true);
    expect(trigger.reason).toBe('timeout');
    trigger.dispose();
  });

  it('retires the command deadline after a timely RESULT so later natural drain stays eligible', () => {
    const trigger = createTrigger(20, undefined);
    trigger.startCommandTimer();
    const deadline = trigger.commandDeadline;
    if (!deadline) throw new Error('command deadline was not created');

    trigger.rootCompleted();
    while (!deadline.expired) {
      // Model natural drain continuing beyond the retired command deadline.
    }

    expect(trigger.commandDeadline).toBeUndefined();
    expect(trigger.commandDeadlineExpired()).toBe(false);
    expect(trigger.reason).toBeUndefined();
    trigger.dispose();
  });

  it('does not replace an earlier user interrupt with a later timeout', () => {
    const controller = new AbortController();
    const trigger = createTrigger(20, {
      signal: controller.signal,
      reason: 'user-interrupt',
    });
    trigger.startCommandTimer();
    const deadline = trigger.commandDeadline;
    if (!deadline) throw new Error('command deadline was not created');
    controller.abort();

    while (!deadline.expired) {
      // Ensure the absolute deadline is also expired before arbitration.
    }

    expect(trigger.commandDeadlineExpired()).toBe(false);
    expect(trigger.reason).toBe('user-interrupt');
    trigger.dispose();
  });
});

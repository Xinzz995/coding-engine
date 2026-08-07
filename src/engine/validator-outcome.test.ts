import { describe, expect, it } from 'vitest';
import { classifyValidatorAttempt } from './validator-outcome.js';

describe('classifyValidatorAttempt', () => {
  it.each([
    ['missing result', 'completed', 'invalid'],
    ['abnormal exit', 'error', 'invalid'],
    ['timeout', 'timeout', 'invalid'],
    ['Validator unavailable', 'skipped', 'invalid'],
  ] as const)('classifies %s as unverifiable', (_name, runnerOutcome, protocol) => {
    expect(
      classifyValidatorAttempt({
        expected: true,
        runnerOutcome,
        protocol,
        receiptIssued: false,
      }),
    ).toBe('unverifiable');
  });

  it('accepts only a completed, fully bound passed result with an issued receipt', () => {
    expect(
      classifyValidatorAttempt({
        expected: true,
        runnerOutcome: 'completed',
        protocol: 'passed',
        receiptIssued: true,
      }),
    ).toBe('passed');
    expect(
      classifyValidatorAttempt({
        expected: true,
        runnerOutcome: 'completed',
        protocol: 'passed',
        receiptIssued: false,
      }),
    ).toBe('unverifiable');
  });

  it('keeps a completed, valid failed claim distinct from unverifiable execution', () => {
    expect(
      classifyValidatorAttempt({
        expected: true,
        runnerOutcome: 'completed',
        protocol: 'failed',
        receiptIssued: false,
      }),
    ).toBe('failed');
  });

  it('does not invent a Validator outcome when validation was not expected', () => {
    expect(
      classifyValidatorAttempt({
        expected: false,
        runnerOutcome: 'skipped',
        protocol: undefined,
        receiptIssued: false,
      }),
    ).toBe('not-run');
  });
});

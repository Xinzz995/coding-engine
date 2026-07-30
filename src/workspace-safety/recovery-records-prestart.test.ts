import { describe, expect, it } from 'vitest';
import { jsonBytes } from './filesystem.js';
import {
  createRecoveryClaimBytes,
  parseRecoveryClaim,
  type PrestartRecoveryOperationBinding,
} from './recovery-records.js';

const RECOVERY_ID = '00000000-0000-4000-8000-0000000000a1';
const OPERATION_ID = '00000000-0000-4000-8000-0000000000a2';
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

const prestart: PrestartRecoveryOperationBinding = {
  kind: 'prestart-operation-v1',
  operationId: OPERATION_ID,
  activeState: 'prepared-bound',
  proof: 'supervisor-exact-dead-never-armed-v1',
  activeChildDigest: digest('1'),
  delegatedBaselineDigest: digest('2'),
  helperDigest: digest('3'),
  prestartDrainedDigest: null,
  existingAbortDigest: null,
};

function create(
  mode: 'mechanical-empty' | 'delegated-finalize' | 'bootstrap-complete' | 'mutation-resume',
  binding: PrestartRecoveryOperationBinding | null,
): Buffer {
  return createRecoveryClaimBytes({
    recoveryId: RECOVERY_ID,
    sourceSnapshotDigest: digest('5'),
    mode,
    delegatedOperation:
      mode === 'delegated-finalize'
        ? {
            operationId: OPERATION_ID,
            activeChildDigest: digest('1'),
            delegatedBaselineDigest: digest('2'),
            drainedReceiptDigest: digest('6'),
          }
        : null,
    prestartOperation: binding,
    rebootProof: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
  });
}

describe('prestart recovery claim records', () => {
  it('round-trips the exact nullable mechanical prestart binding', () => {
    expect(parseRecoveryClaim(create('mechanical-empty', prestart))).toMatchObject({
      mode: 'mechanical-empty',
      delegatedOperation: null,
      prestartOperation: prestart,
    });
    expect(parseRecoveryClaim(create('mechanical-empty', null)).prestartOperation).toBeNull();
  });

  it.each(['delegated-finalize', 'bootstrap-complete', 'mutation-resume'] as const)(
    'rejects prestart identity in %s claims',
    (mode) => {
      expect(() => create(mode, prestart)).toThrow(
        /prestart operation binding requires mechanical/u,
      );
    },
  );

  it('rejects unknown fields and inconsistent state/drained combinations', () => {
    const unknown = JSON.parse(create('mechanical-empty', prestart).toString('utf8')) as Record<
      string,
      unknown
    >;
    (unknown.prestartOperation as Record<string, unknown>).extra = true;
    expect(() => parseRecoveryClaim(jsonBytes(unknown))).toThrow(/unknown field/u);

    const inconsistent = {
      ...prestart,
      activeState: 'prepared' as const,
    };
    expect(() => create('mechanical-empty', inconsistent)).toThrow(/state and recovery proof/u);

    const callerDrained = { ...prestart, prestartDrainedDigest: digest('4') };
    expect(() => create('mechanical-empty', callerDrained)).toThrow(/caller-supplied drained/u);
  });
});

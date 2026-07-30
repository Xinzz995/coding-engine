import type { OperationDiskInspection } from './disk-evaluator-operation.js';
import { digestBytes, jsonBytes } from './filesystem.js';
import type { MutationDomain } from './mutation-domain.js';
import { mutationStateBytes } from './mutation-records.js';
import { PRESTART_ABORT_SCHEMA_VERSION } from './operation-records.js';
import type { RecoveryDomain } from './recovery-domain.js';

export function recoveryBindingMatches(
  recovery: RecoveryDomain,
  operation: OperationDiskInspection | undefined,
  mutation: MutationDomain | undefined,
): boolean {
  if (recovery.claim.mode === 'bootstrap-complete') return false;
  if (recovery.claim.mode === 'mutation-resume') {
    if (!mutation || operation) return false;
    const expectedPhase = recovery.state.expectedMutationPhase;
    const expectedDigest = recovery.state.expectedMutationDigest;
    if (expectedPhase === null || expectedDigest === null) return false;
    const currentDigest = digestBytes(mutation.stateBytes);
    if (mutation.state.phase === expectedPhase && currentDigest === expectedDigest) return true;
    const next =
      expectedPhase === 'staged'
        ? 'archiving'
        : expectedPhase === 'archiving'
          ? 'applying'
          : expectedPhase === 'applying'
            ? 'committed'
            : undefined;
    return Boolean(
      recovery.state.phase === 'claimed' &&
      next === mutation.state.phase &&
      digestBytes(mutationStateBytes({ ...mutation.state, phase: expectedPhase })) ===
        expectedDigest,
    );
  }
  if (mutation) return false;
  if (recovery.claim.mode === 'mechanical-empty') {
    const binding = recovery.claim.prestartOperation;
    if (!binding) return operation === undefined;
    if (!operation || operation.state === 'armed') return false;
    if (
      binding.operationId !== operation.active.operationId ||
      binding.activeState !== operation.active.state ||
      binding.activeChildDigest !== digestBytes(operation.activeBytes) ||
      binding.delegatedBaselineDigest !== digestBytes(operation.baselineBytes) ||
      binding.helperDigest !== operation.active.helperDigest ||
      binding.prestartDrainedDigest !== null ||
      (operation.active.state === 'prepared' &&
        binding.proof !== 'canonical-prepared-start-never-authorized-v1') ||
      (operation.active.state === 'prepared-bound' &&
        binding.proof !== 'supervisor-exact-dead-never-armed-v1')
    ) {
      return false;
    }
    if (binding.existingAbortDigest !== null) {
      return (
        operation.prestartAbortBytes !== undefined &&
        digestBytes(operation.prestartAbortBytes) === binding.existingAbortDigest
      );
    }
    if (!operation.prestartAbortBytes) return true;
    return operation.prestartAbortBytes.equals(
      jsonBytes({
        schemaVersion: PRESTART_ABORT_SCHEMA_VERSION,
        ownerId: operation.active.ownerId,
        operationId: operation.active.operationId,
        activeChildDigest: digestBytes(operation.activeBytes),
        delegatedBaselineDigest: digestBytes(operation.baselineBytes),
        reason: 'setup-failed',
        proof:
          operation.active.state === 'prepared'
            ? 'supervisor-never-bound-v1'
            : 'recovery-supervisor-exact-dead-never-armed-v1',
        prestartDrainedDigest: null,
        abortedAt: recovery.claim.createdAt,
      }),
    );
  }
  const binding = recovery.claim.delegatedOperation;
  return Boolean(
    binding &&
    operation?.state === 'armed' &&
    operation.receiptBytes &&
    binding.operationId === operation.active.operationId &&
    binding.activeChildDigest === digestBytes(operation.activeBytes) &&
    binding.delegatedBaselineDigest === digestBytes(operation.baselineBytes) &&
    binding.drainedReceiptDigest === digestBytes(operation.receiptBytes),
  );
}

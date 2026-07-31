import type { IdentityVerdict, QuarantineReason, WorkspaceSafetyClassification } from './types.js';

export type CanonicalValidity = 'valid' | 'invalid';
export type CanonicalPresence = 'absent' | 'valid' | 'invalid';
export type RecoveryPresence = 'absent' | 'valid' | 'invalid';
export type ContainmentVerdict = 'not-applicable' | 'empty' | 'alive' | 'unknown';
export type RecoveryInputVerdict = 'valid' | 'insufficient' | 'invalid';

export interface WorkspaceSafetyFacts {
  canonical: CanonicalValidity;
  quarantine: QuarantineReason | null;
  recovery: RecoveryPresence;
  bootstrapLease: boolean;
  legacyArtifacts: boolean;
  owner: IdentityVerdict | 'absent';
  containment: ContainmentVerdict;
  recoveryInputs: RecoveryInputVerdict;
  foreignHost: boolean;
  protocol: CanonicalPresence;
  marker: CanonicalPresence;
  lease: CanonicalPresence;
  directoryEmpty: boolean;
}

const TERMINAL_QUARANTINES = new Set<QuarantineReason>([
  'operation-proof-missing',
  'workspace-integrity-violation',
]);

function hasInvalidCanonicalRecord(facts: WorkspaceSafetyFacts): boolean {
  return (
    facts.canonical === 'invalid' ||
    facts.recovery === 'invalid' ||
    facts.protocol === 'invalid' ||
    facts.marker === 'invalid' ||
    facts.lease === 'invalid' ||
    facts.recoveryInputs === 'invalid'
  );
}

function hasImpossibleCanonicalShape(facts: WorkspaceSafetyFacts): boolean {
  if (facts.lease === 'valid' && facts.owner === 'absent') return true;
  if (facts.lease === 'absent' && facts.owner !== 'absent') return true;
  if (facts.marker === 'valid' && facts.protocol !== 'valid') return true;
  if (facts.lease === 'valid' && facts.protocol !== 'valid') return true;
  if (facts.protocol === 'valid' && facts.marker === 'absent' && !facts.bootstrapLease) {
    return true;
  }
  return false;
}

function classifyLease(facts: WorkspaceSafetyFacts): WorkspaceSafetyClassification {
  // Exact-live already proves this is the current owner domain. A live child is
  // normal for armed work; containment only decides takeover after owner loss.
  if (facts.owner === 'alive' && !facts.foreignHost) return 'active';
  if (
    facts.foreignHost ||
    facts.recoveryInputs === 'insufficient' ||
    facts.containment === 'alive' ||
    facts.containment === 'unknown' ||
    facts.owner === 'unknown'
  ) {
    return 'isolated';
  }
  if (
    facts.owner === 'dead' &&
    (facts.containment === 'empty' || facts.containment === 'not-applicable')
  ) {
    return 'recoverable';
  }
  return 'isolated';
}

/**
 * Maps already-normalized disk facts to exactly one user-visible state.
 * It deliberately performs no I/O so callers cannot reorder the frozen priority.
 */
export function classifyWorkspaceSafetyFacts(
  facts: WorkspaceSafetyFacts,
): WorkspaceSafetyClassification {
  // 1. Invalid canonical safety bytes/bindings always win.
  if (hasInvalidCanonicalRecord(facts) || hasImpossibleCanonicalShape(facts)) return 'invalid';

  // 2. Integrity and missing-operation-proof quarantines are terminal isolation.
  if (facts.quarantine && TERMINAL_QUARANTINES.has(facts.quarantine)) return 'isolated';

  // 3. A valid fixed recovery domain wins over containment quarantine.
  if (facts.recovery === 'valid') return 'recovering';

  // 4. Containment quarantine remains isolated until a strict recovery exists.
  if (facts.quarantine === 'containment-unconfirmed') return 'isolated';

  // 5. Bootstrap protocol + canonical lease is never legacy.
  if (facts.bootstrapLease) {
    if (facts.protocol !== 'valid' || facts.lease !== 'valid') return 'invalid';
    return classifyLease(facts);
  }

  // 6. Runtime bytes without a valid bootstrap protocol/marker remain legacy.
  if (facts.legacyArtifacts && facts.protocol === 'absent' && facts.marker === 'absent') {
    return 'legacy';
  }

  // 7-9. Ordinary active lease: isolate uncertainty, then recover dead, then accept live.
  if (facts.lease === 'valid') return classifyLease(facts);

  // An owner record cannot exist outside the canonical lease.
  if (facts.owner !== 'absent') return 'invalid';

  // A concurrently disappearing lease must not let stale unsafe probe facts
  // fall through to ready/uninitialized.
  if (
    facts.foreignHost ||
    facts.containment !== 'not-applicable' ||
    facts.recoveryInputs === 'insufficient'
  ) {
    return 'isolated';
  }

  // 10. A mutually validated permanent protocol and marker with no lease is ready.
  if (facts.protocol === 'valid' && facts.marker === 'valid' && facts.lease === 'absent') {
    return 'ready';
  }

  // 11. Only the strictly empty, entirely uninitialized shape is bootstrap-eligible.
  if (
    facts.directoryEmpty &&
    facts.protocol === 'absent' &&
    facts.marker === 'absent' &&
    facts.lease === 'absent'
  ) {
    return 'uninitialized-empty';
  }

  // Valid but incomplete observations never become ready by default.
  return 'isolated';
}

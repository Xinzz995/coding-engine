import type { DrainedReason } from '../workspace-safety/supervisor-protocol.js';
import { observeManagedProcessSettlement } from '../workspace-safety/operation.js';

export interface ManagedTemporaryUse {
  confirmManagedUseSettled(): void;
}

/**
 * A managed process can finish before workspace settlement rejects its semantic delta. In that
 * case callers may close only the temporary domains their normal result path would have closed for
 * the same drained reason. Identity failures remain recorded by each domain and are surfaced by
 * cleanup; they must not replace the primary workspace failure here.
 */
export function confirmTemporaryUsesAfterSettledProcessFailure(
  failure: unknown,
  temporaryUses: readonly ManagedTemporaryUse[],
  acceptedDrainReasons: readonly DrainedReason[],
): void {
  const settlement = observeManagedProcessSettlement(failure);
  if (settlement.status !== 'confirmed' || !acceptedDrainReasons.includes(settlement.drainReason)) {
    return;
  }
  for (const temporary of temporaryUses) {
    try {
      temporary.confirmManagedUseSettled();
    } catch {
      // The domain records an unsafe identity itself; cleanup will retain and report it.
    }
  }
}

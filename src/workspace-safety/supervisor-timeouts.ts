import type { PosixSupervisorTimeouts } from './posix-supervisor.js';
import type { WindowsSupervisorTimeouts } from './windows-supervisor-launch.js';

/** Public, platform-neutral phase budgets accepted by the coordinator. */
export interface ManagedSupervisorTimeouts {
  readonly prepareMs?: number;
  readonly naturalDrainMs?: number;
  readonly terminateDrainMs?: number;
  readonly ackExitMs?: number;
  readonly pollMs?: number;
}

export function mapManagedTimeoutsToPosix(
  input: ManagedSupervisorTimeouts | undefined,
): PosixSupervisorTimeouts | undefined {
  if (!input) return undefined;
  return {
    handshakeMs: input.prepareMs,
    naturalDrainMs: input.naturalDrainMs,
    killMs: input.terminateDrainMs,
    ackMs: input.ackExitMs,
    pollMs: input.pollMs,
  };
}

export function mapManagedTimeoutsToWindows(
  input: ManagedSupervisorTimeouts | undefined,
): Partial<WindowsSupervisorTimeouts> | undefined {
  if (!input) return undefined;
  return {
    handshakeMs: input.prepareMs,
    naturalDrainMs: input.naturalDrainMs,
    terminateMs: input.terminateDrainMs,
    ackMs: input.ackExitMs,
    pollMs: input.pollMs,
  };
}

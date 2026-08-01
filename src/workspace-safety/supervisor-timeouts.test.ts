import { describe, expect, it } from 'vitest';
import {
  mapManagedTimeoutsToPosix,
  mapManagedTimeoutsToWindows,
  type ManagedSupervisorTimeouts,
} from './supervisor-timeouts.js';

describe('managed supervisor timeout mapping', () => {
  it('maps every public phase budget explicitly to both platform adapters', () => {
    const input: ManagedSupervisorTimeouts = {
      prepareMs: 101,
      naturalDrainMs: 102,
      terminateDrainMs: 103,
      ackExitMs: 104,
      pollMs: 5,
    };

    expect(mapManagedTimeoutsToPosix(input)).toEqual({
      handshakeMs: 101,
      naturalDrainMs: 102,
      killMs: 103,
      ackMs: 104,
      pollMs: 5,
    });
    expect(mapManagedTimeoutsToWindows(input)).toEqual({
      handshakeMs: 101,
      naturalDrainMs: 102,
      terminateMs: 103,
      ackMs: 104,
      pollMs: 5,
    });
  });

  it('does not invent platform defaults in the public mapping layer', () => {
    expect(mapManagedTimeoutsToPosix(undefined)).toBeUndefined();
    expect(mapManagedTimeoutsToWindows(undefined)).toBeUndefined();
    expect(mapManagedTimeoutsToPosix({})).toEqual({
      handshakeMs: undefined,
      naturalDrainMs: undefined,
      killMs: undefined,
      ackMs: undefined,
      pollMs: undefined,
    });
  });
});

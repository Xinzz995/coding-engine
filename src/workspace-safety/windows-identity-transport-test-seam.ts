/**
 * TEST-ONLY seam for deterministic timeout and retry proofs.
 *
 * Production callers must use readWindowsIdentitySnapshot from windows-identity-transport.ts.
 */
export {
  readWindowsIdentitySnapshotControlled,
  type WindowsIdentityTransportRuntime,
} from './windows-identity-transport.js';

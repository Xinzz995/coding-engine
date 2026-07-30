/**
 * TEST-ONLY workspace owner authority seam.
 *
 * Production and future activation code must use bootstrapWorkspace/acquireWorkspaceLease, which
 * capture exact OS identity internally. This module exists only for deterministic platform and
 * crash fixtures that need synthetic owner records.
 */
export {
  bootstrapWorkspaceControlled as bootstrapWorkspaceWithAuthority,
  type ControlledBootstrapWorkspaceOptions as BootstrapWorkspaceWithAuthorityOptions,
} from './bootstrap.js';
export {
  acquireWorkspaceLeaseControlled as acquireWorkspaceLeaseWithAuthority,
  type ControlledAcquireWorkspaceLeaseOptions as AcquireWorkspaceLeaseWithAuthorityOptions,
} from './lease.js';
export {
  createWorkspaceSessionControlled as createWorkspaceSessionWithAuthority,
  type ControlledWorkspaceSessionOptions as WorkspaceSessionWithAuthorityOptions,
} from './session.js';

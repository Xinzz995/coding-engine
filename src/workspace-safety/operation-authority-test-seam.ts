/**
 * Test-only access to the low-level operation coordinator boundary.
 *
 * Production modules must never import this file. Tests intentionally use explicit WithAuthority
 * names so a fixture cannot be mistaken for a public or business-safe operation entrypoint.
 */
export {
  runWorkspaceOperationControlled as runWorkspaceOperationWithAuthority,
  type WorkspaceOperationHandleControlled as WorkspaceOperationHandleWithAuthority,
} from './operation.js';
export type {
  OperationHooksControlled as OperationHooksWithAuthority,
  PrepareWorkspaceOperationOptionsControlled as PrepareWorkspaceOperationWithAuthorityOptions,
} from './operation-records.js';

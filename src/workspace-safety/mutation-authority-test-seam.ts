/**
 * Test-only access to the generic mutation coordinator.
 *
 * Production modules must never import this file. generic-v1 plans are destructive fixtures, not
 * a public apply-prd or repair policy.
 */
export {
  runWorkspaceMutationControlled as runWorkspaceMutationWithAuthority,
  type WorkspaceMutationPlanControlled as WorkspaceMutationPlanWithAuthority,
} from './mutation.js';

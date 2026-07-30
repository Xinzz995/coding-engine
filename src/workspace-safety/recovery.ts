// Public recovery surface. Authority-controlled cores are deliberately excluded; deterministic
// fixtures import recovery-authority-test-seam.ts explicitly instead.
export {
  acquireBootstrapRecoveryAttempt,
  BootstrapRecoveryAttemptHandle,
  captureBootstrapRecoverySourceSnapshotDigest,
  evaluateBootstrapRecoveryDiskState,
  installBootstrapRecoveryDomain,
} from './bootstrap-recovery.js';
export type {
  AcquireBootstrapRecoveryAttemptOptions,
  BootstrapRecoveryDiskState,
  InstallBootstrapRecoveryOptions,
} from './bootstrap-recovery.js';
export {
  finalizeBootstrapRecovery,
  verifyBootstrapRecoveryArchive,
} from './bootstrap-recovery-finalize.js';
export type {
  BootstrapRecoveryCompletion,
  FinalizeBootstrapRecoveryOptions,
} from './bootstrap-recovery-finalize.js';
export {
  acquireRecoveryAttempt,
  installRecoveryDomain,
  RecoveryAttemptHandle,
} from './recovery-attempt.js';
export type {
  AcquireRecoveryAttemptOptions,
  InstallRecoveryDomainOptions,
} from './recovery-attempt.js';
export * from './recovery-domain.js';
export {
  finalizeMechanicalEmptyRecovery,
  verifyMechanicalEmptyRecoveryArchive,
} from './recovery-finalize.js';
export type {
  FinalizeMechanicalEmptyRecoveryOptions,
  MechanicalEmptyRecoveryCompletion,
  VerifyMechanicalEmptyRecoveryArchiveOptions,
} from './recovery-finalize.js';
export * from './recovery-records.js';
export { createRecoverySession, RecoverySession } from './recovery-session.js';
export type {
  RecoveryInterruptReason,
  RecoveryInterruptResult,
  RecoverySessionState,
} from './recovery-session.js';
export * from './recovery-source-snapshot.js';

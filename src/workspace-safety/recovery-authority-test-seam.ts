/**
 * TEST-ONLY authority injection seam.
 *
 * Production modules and future CLI activation code must never import this module. It exists so
 * deterministic crash/race fixtures can model dead owners without weakening the callable recovery
 * APIs. The production wrappers obtain process identity and liveness directly from the OS.
 */
export {
  acquireMechanicalRecoveryAttemptControlled as acquireRecoveryAttemptWithAuthority,
  acquireRecoveryAttemptControlled as acquireRecoveryAttemptWithModeAuthority,
  installMechanicalRecoveryDomainControlled as installRecoveryDomainWithAuthority,
  installRecoveryDomainControlled as installRecoveryDomainWithModeAuthority,
  type ControlledAcquireRecoveryAttemptOptions as AcquireRecoveryAttemptWithAuthorityOptions,
  type ControlledInstallRecoveryDomainOptions as InstallRecoveryDomainWithAuthorityOptions,
} from './recovery-attempt.js';
export {
  finalizeMechanicalEmptyRecoveryControlled as finalizeMechanicalEmptyRecoveryWithAuthority,
  type ControlledFinalizeMechanicalEmptyRecoveryOptions as FinalizeMechanicalEmptyRecoveryWithAuthorityOptions,
} from './recovery-finalize.js';
export {
  acquireBootstrapRecoveryAttemptControlled as acquireBootstrapRecoveryAttemptWithAuthority,
  evaluateBootstrapRecoveryDiskStateControlled as evaluateBootstrapRecoveryDiskStateWithAuthority,
  installBootstrapRecoveryDomainControlled as installBootstrapRecoveryDomainWithAuthority,
  type ControlledAcquireBootstrapRecoveryAttemptOptions as AcquireBootstrapRecoveryAttemptWithAuthorityOptions,
  type ControlledInstallBootstrapRecoveryOptions as InstallBootstrapRecoveryWithAuthorityOptions,
} from './bootstrap-recovery.js';
export {
  finalizeBootstrapRecoveryControlled as finalizeBootstrapRecoveryWithAuthority,
  type ControlledFinalizeBootstrapRecoveryOptions as FinalizeBootstrapRecoveryWithAuthorityOptions,
} from './bootstrap-recovery-finalize.js';
export {
  acquireDelegatedFinalizeRecoveryControlled as acquireDelegatedFinalizeRecoveryWithAuthority,
  inspectDelegatedRecoveryEligibilityControlled as inspectDelegatedRecoveryEligibilityWithAuthority,
  installDelegatedFinalizeRecoveryControlled as installDelegatedFinalizeRecoveryWithAuthority,
  type ControlledAcquireDelegatedFinalizeRecoveryOptions as AcquireDelegatedFinalizeRecoveryWithAuthorityOptions,
  type ControlledInstallDelegatedFinalizeRecoveryOptions as InstallDelegatedFinalizeRecoveryWithAuthorityOptions,
} from './delegated-recovery.js';
export {
  finalizeDelegatedRecoveryControlled as finalizeDelegatedRecoveryWithAuthority,
  type ControlledFinalizeDelegatedRecoveryOptions as FinalizeDelegatedRecoveryWithAuthorityOptions,
} from './delegated-recovery-finalize.js';
export {
  acquirePrestartRecoveryControlled as acquirePrestartRecoveryWithAuthority,
  inspectPrestartRecoveryEligibilityControlled as inspectPrestartRecoveryEligibilityWithAuthority,
  installPrestartRecoveryControlled as installPrestartRecoveryWithAuthority,
  type ControlledAcquirePrestartRecoveryOptions as AcquirePrestartRecoveryWithAuthorityOptions,
  type ControlledInstallPrestartRecoveryOptions as InstallPrestartRecoveryWithAuthorityOptions,
  type PrestartRecoveryProbeOptions as PrestartRecoveryWithAuthorityOptions,
} from './prestart-recovery.js';
export {
  finalizePrestartRecoveryControlled as finalizePrestartRecoveryWithAuthority,
  type ControlledFinalizePrestartRecoveryOptions as FinalizePrestartRecoveryWithAuthorityOptions,
} from './prestart-recovery-finalize.js';
export {
  acquireMutationRecoveryAttemptControlled as acquireMutationRecoveryAttemptWithAuthority,
  installMutationRecoveryDomainControlled as installMutationRecoveryDomainWithAuthority,
  resumeMutationRecoveryControlled as resumeMutationRecoveryWithAuthority,
  type ControlledAcquireMutationRecoveryAttemptOptions as AcquireMutationRecoveryAttemptWithAuthorityOptions,
  type ControlledInstallMutationRecoveryOptions as InstallMutationRecoveryWithAuthorityOptions,
  type ControlledResumeMutationRecoveryOptions as ResumeMutationRecoveryWithAuthorityOptions,
} from './mutation-recovery.js';
export {
  acquireSameHostRebootRecoveryControlled as acquireSameHostRebootRecoveryWithAuthority,
  finalizeSameHostRebootRecoveryControlled as finalizeSameHostRebootRecoveryWithAuthority,
  inspectSameHostRebootRecoveryControlled as inspectSameHostRebootRecoveryWithAuthority,
  installSameHostRebootRecoveryControlled as installSameHostRebootRecoveryWithAuthority,
  type ControlledAcquireSameHostRebootRecoveryOptions as AcquireSameHostRebootRecoveryWithAuthorityOptions,
  type ControlledFinalizeSameHostRebootRecoveryOptions as FinalizeSameHostRebootRecoveryWithAuthorityOptions,
  type ControlledInspectSameHostRebootRecoveryOptions as InspectSameHostRebootRecoveryWithAuthorityOptions,
  type ControlledInstallSameHostRebootRecoveryOptions as InstallSameHostRebootRecoveryWithAuthorityOptions,
} from './reboot-recovery.js';
export {
  createRecoverySessionControlled as createRecoverySessionWithAuthority,
  type ControlledRecoverySessionOptions as RecoverySessionWithAuthorityOptions,
} from './recovery-session.js';
export {
  evaluateWorkspaceSafetyDiskControlled as evaluateWorkspaceSafetyDiskWithAuthority,
  type ControlledEvaluateWorkspaceSafetyDiskOptions as EvaluateWorkspaceSafetyDiskWithAuthorityOptions,
} from './disk-evaluator.js';

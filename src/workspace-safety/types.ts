export const WORKSPACE_MARKER_FILE = 'workspace-safety.json';
export const PROTOCOL_ROOT_DIR = 'engine.lock';
export const PROTOCOL_FILE = 'protocol.json';
export const INCIDENTS_DIR = 'incidents';
export const ACTIVE_LEASE_DIR = 'lease';
export const OWNER_FILE = 'owner.json';
export const OPERATION_DIR = 'operation';
export const MUTATION_DIR = 'mutation';
export const RECOVERY_DIR = 'recovery';

export const WORKSPACE_MARKER_SCHEMA_VERSION = 2 as const;
export const PROTOCOL_SCHEMA_VERSION = 1 as const;
export const OWNER_SCHEMA_VERSION = 2 as const;
export const WORKSPACE_PROTOCOL = 'coding-x-workspace-lease-v1' as const;
export const WORKSPACE_SAFETY_VERSION = '0.34.0' as const;

export type WorkspaceSafetyClassification =
  | 'uninitialized-empty'
  | 'ready'
  | 'active'
  | 'recoverable'
  | 'isolated'
  | 'invalid'
  | 'legacy'
  | 'recovering';

export type OwnerCommand =
  'workspace-init' | 'run' | 'repair' | 'report' | 'apply-prd' | 'review-decision';

export type ProcessIdentityKind = 'linux-boot-start' | 'macos-boot-start' | 'windows-filetime';

export interface ProcessIdentity {
  kind: ProcessIdentityKind;
  value: string;
}

export interface WorkspaceMarker {
  schemaVersion: typeof WORKSPACE_MARKER_SCHEMA_VERSION;
  initializedBy: typeof WORKSPACE_SAFETY_VERSION;
  workspaceIdentity: string;
  protocolDigest: string;
  initializedAt: string;
}

export interface ProtocolRecord {
  schemaVersion: typeof PROTOCOL_SCHEMA_VERSION;
  protocol: typeof WORKSPACE_PROTOCOL;
  workspaceIdentity: string;
  createdBy: typeof WORKSPACE_SAFETY_VERSION;
  createdAt: string;
}

export interface OwnerRecord {
  schemaVersion: typeof OWNER_SCHEMA_VERSION;
  ownerId: string;
  pid: number;
  processIdentity: ProcessIdentity;
  bootIdentity: string;
  hostId: string;
  workspaceIdentity: string;
  startedAt: string;
  command: OwnerCommand;
}

export type IdentityVerdict = 'alive' | 'dead' | 'unknown';

export interface IdentityProbe {
  current(): ProcessIdentitySnapshot;
  probe(record: OwnerRecord): IdentityVerdict;
}

export interface ProcessIdentitySnapshot {
  pid: number;
  processIdentity: ProcessIdentity;
  bootIdentity: string;
  hostId: string;
}

export type QuarantineReason =
  'containment-unconfirmed' | 'operation-proof-missing' | 'workspace-integrity-violation';

export type RecoveryMode =
  'mechanical-empty' | 'delegated-finalize' | 'bootstrap-complete' | 'mutation-resume';

export type MutationPhase = 'staged' | 'archiving' | 'applying' | 'committed';

export type ActiveChildState = 'prepared' | 'prepared-bound' | 'armed';

export class WorkspaceSafetyError extends Error {
  constructor(
    readonly code:
      'conflict' | 'invalid' | 'legacy' | 'isolated' | 'lease-lost' | 'closed' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSafetyError';
  }
}

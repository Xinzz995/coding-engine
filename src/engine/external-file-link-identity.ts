export interface ExternalFileStatIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface ExternalFileLinkIdentity {
  readonly resolvedPath: string;
  readonly link: ExternalFileStatIdentity;
  readonly linkTargetDigest: string;
  readonly target: ExternalFileStatIdentity;
  readonly targetDigest: string;
}

function sameExternalFileStatIdentity(
  left: ExternalFileStatIdentity,
  right: ExternalFileStatIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function sameExternalFileLinkIdentity(
  left: ExternalFileLinkIdentity,
  right: ExternalFileLinkIdentity,
): boolean {
  return (
    left.resolvedPath === right.resolvedPath &&
    sameExternalFileStatIdentity(left.link, right.link) &&
    left.linkTargetDigest === right.linkTargetDigest &&
    sameExternalFileStatIdentity(left.target, right.target) &&
    left.targetDigest === right.targetDigest
  );
}

import { describe, expect, it } from 'vitest';
import {
  sameExternalFileLinkIdentity,
  type ExternalFileLinkIdentity,
} from './external-file-link-identity.js';

describe('external file link identity', () => {
  it('requires both the raw link target and target content digests to remain unchanged', () => {
    const stat = {
      dev: 1n,
      ino: 2n,
      uid: 3n,
      mode: 0o100755n,
      size: 9n,
      mtimeNs: 4n,
      ctimeNs: 5n,
    };
    const captured = {
      resolvedPath: '/external/tool',
      link: { ...stat, ino: 6n, size: 14n },
      linkTargetDigest: 'link-target',
      target: stat,
      targetDigest: 'original-content',
    } satisfies ExternalFileLinkIdentity;

    expect(sameExternalFileLinkIdentity(captured, structuredClone(captured))).toBe(true);
    expect(
      sameExternalFileLinkIdentity(captured, {
        ...captured,
        linkTargetDigest: 'changed-link-target',
      }),
    ).toBe(false);
    expect(
      sameExternalFileLinkIdentity(captured, {
        ...captured,
        targetDigest: 'changed-content',
      }),
    ).toBe(false);
  });
});

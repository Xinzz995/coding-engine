import { describe, expect, it } from 'vitest';
import {
  MAX_SAFETY_RECORD_BYTES,
  MAX_SAFETY_STRING_LENGTH,
  parseJsonRecord,
  parseOwnerRecord,
  parseProtocolRecord,
  parseWorkspaceMarker,
  sha256SafetyBytes,
  validateCoreRecordBindings,
} from './schema.js';

const digest = `sha256:${'a'.repeat(64)}`;
const timestamp = '2026-07-30T00:00:00.000Z';

const marker = {
  schemaVersion: 2,
  initializedBy: '0.34.0',
  workspaceIdentity: digest,
  protocolDigest: digest,
  initializedAt: timestamp,
};

const protocol = {
  schemaVersion: 1,
  protocol: 'coding-x-workspace-lease-v1',
  workspaceIdentity: digest,
  createdBy: '0.34.0',
  createdAt: timestamp,
};

const owner = {
  schemaVersion: 2,
  ownerId: '123e4567-e89b-42d3-a456-426614174000',
  pid: 42,
  processIdentity: { kind: 'linux-boot-start', value: '123456' },
  bootIdentity: digest,
  hostId: digest,
  workspaceIdentity: digest,
  startedAt: timestamp,
  command: 'run',
};

describe('workspace safety strict record schema', () => {
  it('accepts the exact v1/v2 marker, protocol and owner records', () => {
    expect(parseWorkspaceMarker(marker)).toEqual(marker);
    expect(parseProtocolRecord(protocol)).toEqual(protocol);
    expect(parseOwnerRecord(owner)).toEqual(owner);
    expect(parseOwnerRecord({ ...owner, command: 'candidate-proof' }).command).toBe(
      'candidate-proof',
    );
  });

  it.each([
    ['unknown top-level field', { ...owner, argv: ['secret'] }],
    [
      'unknown nested field',
      { ...owner, processIdentity: { ...owner.processIdentity, precision: 'exact' } },
    ],
    ['wrong schema', { ...owner, schemaVersion: 1 }],
    ['unknown enum', { ...owner, command: 'force-unlock' }],
    ['uppercase digest', { ...owner, hostId: `sha256:${'A'.repeat(64)}` }],
    ['non-canonical UUID', { ...owner, ownerId: '123E4567-E89B-42D3-A456-426614174000' }],
    [
      'UUID without a supported version',
      { ...owner, ownerId: '123e4567-e89b-02d3-a456-426614174000' },
    ],
    ['UUID without the RFC variant', { ...owner, ownerId: '123e4567-e89b-42d3-7456-426614174000' }],
    ['timestamp without milliseconds', { ...owner, startedAt: '2026-07-30T00:00:00Z' }],
    ['zero pid', { ...owner, pid: 0 }],
    ['pid outside unsigned 32-bit range', { ...owner, pid: 0x1_0000_0000 }],
    [
      'malformed Linux start identity',
      { ...owner, processIdentity: { kind: 'linux-boot-start', value: 'not-a-start-tick' } },
    ],
    [
      'malformed Windows FILETIME identity',
      { ...owner, processIdentity: { kind: 'windows-filetime', value: '-1' } },
    ],
    [
      'malformed macOS start identity',
      { ...owner, processIdentity: { kind: 'macos-boot-start', value: 'yesterday' } },
    ],
  ])('fails closed on %s', (_label, value) => {
    expect(() => parseOwnerRecord(value)).toThrow(/invalid workspace safety record/i);
  });

  it('freezes the general string boundary', () => {
    expect(() =>
      parseOwnerRecord({
        ...owner,
        processIdentity: {
          ...owner.processIdentity,
          value: 'x'.repeat(MAX_SAFETY_STRING_LENGTH + 1),
        },
      }),
    ).toThrow(/invalid workspace safety record/i);
  });

  it('accepts each frozen platform identity encoding', () => {
    expect(parseOwnerRecord(owner).processIdentity.value).toBe('123456');
    expect(
      parseOwnerRecord({
        ...owner,
        processIdentity: { kind: 'windows-filetime', value: '133989600000000000' },
      }).processIdentity.value,
    ).toBe('133989600000000000');
    expect(
      parseOwnerRecord({
        ...owner,
        processIdentity: { kind: 'macos-boot-start', value: 'Thu Jul 30 08:38:45 2026' },
      }).processIdentity.value,
    ).toBe('Thu Jul 30 08:38:45 2026');
  });

  it('rejects duplicate JSON keys before ordinary JSON parsing can erase them', () => {
    const bytes = `{"schemaVersion":2,"schemaVersion":2,"initializedBy":"0.34.0","workspaceIdentity":"${digest}","protocolDigest":"${digest}","initializedAt":"${timestamp}"}`;
    expect(() => parseJsonRecord(bytes, parseWorkspaceMarker)).toThrow(/duplicate/i);
    expect(() => parseJsonRecord('{"ownerId":1,"\\u006fwnerId":2}', (value) => value)).toThrow(
      /duplicate/i,
    );
  });

  it('freezes the full record byte boundary and rejects malformed JSON', () => {
    const parseUnknown = (value: unknown) => value;
    const exact = `"${'x'.repeat(MAX_SAFETY_RECORD_BYTES - 2)}"`;
    expect(parseJsonRecord(exact, parseUnknown)).toHaveLength(MAX_SAFETY_RECORD_BYTES - 2);
    expect(() => parseJsonRecord(`${exact} `, parseUnknown)).toThrow(/too large/i);
    expect(() => parseJsonRecord('{', parseUnknown)).toThrow(/invalid json/i);
    expect(() => parseJsonRecord(Buffer.from([0x22, 0xff, 0x22]), parseUnknown)).toThrow(/utf-8/i);
  });

  it('does not silently coerce values', () => {
    expect(() => parseWorkspaceMarker({ ...marker, schemaVersion: '2' })).toThrow(
      /invalid workspace safety record/i,
    );
    expect(() => parseProtocolRecord({ ...protocol, createdAt: new Date(timestamp) })).toThrow(
      /invalid workspace safety record/i,
    );
    expect(() => parseOwnerRecord({ ...owner, [Symbol('hidden')]: true })).toThrow(
      /unknown field/i,
    );
  });

  it('binds marker, raw protocol bytes, owner and canonical workspace identity', () => {
    const protocolBytes = `${JSON.stringify(protocol)}\n`;
    const boundMarker = {
      ...marker,
      protocolDigest: sha256SafetyBytes(protocolBytes),
    };
    expect(() =>
      validateCoreRecordBindings({
        marker: parseWorkspaceMarker(boundMarker),
        protocol: parseProtocolRecord(protocol),
        owner: parseOwnerRecord(owner),
        protocolBytes,
        canonicalWorkspaceIdentity: digest,
      }),
    ).not.toThrow();

    expect(() =>
      validateCoreRecordBindings({
        marker: parseWorkspaceMarker(boundMarker),
        protocol: parseProtocolRecord(protocol),
        owner: parseOwnerRecord({
          ...owner,
          workspaceIdentity: `sha256:${'b'.repeat(64)}`,
        }),
        protocolBytes,
        canonicalWorkspaceIdentity: digest,
      }),
    ).toThrow(/binding/i);

    expect(() =>
      validateCoreRecordBindings({
        marker: parseWorkspaceMarker(boundMarker),
        protocol: parseProtocolRecord(protocol),
        protocolBytes: `${protocolBytes} `,
        canonicalWorkspaceIdentity: digest,
      }),
    ).toThrow(/binding/i);
  });

  it('rejects a UTF-8 BOM instead of normalizing the canonical bytes', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(marker)),
    ]);
    expect(() => parseJsonRecord(bytes, parseWorkspaceMarker)).toThrow(/bom/i);
  });
});

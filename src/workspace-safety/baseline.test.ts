import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBaselineEntryLimit,
  captureDelegatedBaseline,
  DELEGATION_LIMITS,
  evaluateDelegatedDelta,
  parseDelegatedBaselineBytes,
  workspacePathCollisionKey,
  type DelegationContract,
} from './baseline.js';
import {
  OPERATION_ID,
  OWNER_ID,
  baselineWorkspace as workspace,
  cleanupBaselineWorkspaces,
  genericContract as contract,
} from './__fixtures__/baseline-test-support.js';

afterEach(cleanupBaselineWorkspaces);

describe('captureDelegatedBaseline', () => {
  it('captures sorted business-file digests without storing file content or safety paths', () => {
    const root = workspace();
    mkdirSync(join(root, 'nested'));
    mkdirSync(join(root, 'engine.lock'));
    writeFileSync(join(root, 'nested', 'b.txt'), 'secret-canary');
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'engine.lock', 'owner.json'), 'safety');
    writeFileSync(join(root, 'workspace-safety.json'), 'safety-marker');

    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]));

    expect(baseline.entries.map((entry) => entry.path)).toEqual([
      'a.txt',
      'nested',
      'nested/b.txt',
    ]);
    expect(JSON.stringify(baseline)).not.toContain('secret-canary');
    expect(JSON.stringify(baseline)).not.toContain('owner.json');
    expect(JSON.stringify(baseline)).not.toContain('workspace-safety.json');
    expect(baseline.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('never allows a delegation contract to authorize the workspace safety marker', () => {
    const root = workspace();
    writeFileSync(join(root, 'workspace-safety.json'), 'safety-marker');
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'WORKSPACE-SAFETY.JSON',
            semantics: 'whole-file',
            allow: ['modify'],
          },
        ]),
      ),
    ).toThrow(/安全协议路径/u);
  });

  // Windows reparse points require the native attribute checker and are covered by the mandatory
  // standard-user windows-reparse-point suite. This portable unit uses POSIX symlink creation.
  it.skipIf(process.platform === 'win32')('rejects symlinks instead of following them', () => {
    const root = workspace();
    writeFileSync(join(root, 'target.txt'), 'x');
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'));

    expect(() => captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]))).toThrow(
      /symlink/i,
    );
  });

  it('rejects hard links so an allowed workspace path cannot alias an outside inode', () => {
    const root = workspace();
    const outside = join(workspace(), 'outside.txt');
    writeFileSync(outside, 'outside');
    linkSync(outside, join(root, 'alias.txt'));

    expect(() => captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]))).toThrow(
      /hardlink/i,
    );
  });

  it('fails closed on per-file, total-byte, and directory-depth scan budgets', () => {
    const fileRoot = workspace();
    const oversized = join(fileRoot, 'oversized.bin');
    writeFileSync(oversized, '');
    truncateSync(oversized, 4);
    expect(() =>
      captureDelegatedBaseline(fileRoot, OWNER_ID, OPERATION_ID, contract([]), {
        limits: { fileBytes: 3, totalBytes: 10, depth: 10 },
      }),
    ).toThrow(/单文件预算/i);

    const totalRoot = workspace();
    writeFileSync(join(totalRoot, 'a.bin'), 'aaa');
    writeFileSync(join(totalRoot, 'b.bin'), 'bbb');
    expect(() =>
      captureDelegatedBaseline(totalRoot, OWNER_ID, OPERATION_ID, contract([]), {
        limits: { fileBytes: 4, totalBytes: 5, depth: 10 },
      }),
    ).toThrow(/总字节预算/i);

    const deepRoot = workspace();
    mkdirSync(join(deepRoot, 'one', 'two'), { recursive: true });
    expect(() =>
      captureDelegatedBaseline(deepRoot, OWNER_ID, OPERATION_ID, contract([]), {
        limits: { fileBytes: 4, totalBytes: 5, depth: 1 },
      }),
    ).toThrow(/目录深度/i);
  });

  it('round-trips through JSON without undefined-dependent manifest bytes', () => {
    const root = workspace();
    writeFileSync(join(root, 'plain.txt'), 'plain');
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]));
    const restored = JSON.parse(JSON.stringify(baseline)) as typeof baseline;

    expect(evaluateDelegatedDelta(root, restored)).toEqual({ accepted: true, changes: [] });
    expect(JSON.stringify(baseline)).not.toContain('undefined');

    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'plain.txt',
            semantics: 'whole-file',
            allow: ['modify'],
            mutableJsonPointers: undefined,
          },
        ]),
      ),
    ).toThrow(/mutable|undefined/i);
  });

  it('requires canonical owner and operation UUIDs', () => {
    const root = workspace();
    expect(() => captureDelegatedBaseline(root, 'owner-1', OPERATION_ID, contract([]))).toThrow(
      /ownerId|uuid/i,
    );
    expect(() => captureDelegatedBaseline(root, OWNER_ID, 'operation-1', contract([]))).toThrow(
      /operationId|uuid/i,
    );
  });

  it('parses a valid baseline larger than the generic 64KiB record limit', () => {
    const root = workspace();
    const rules: DelegationContract['rules'] = Array.from({ length: 16 }, (_, index) => {
      const prefix = `${index}-`;
      return {
        path: `${prefix}${'x'.repeat(4020 - Buffer.byteLength(prefix, 'utf8'))}`,
        semantics: 'whole-file',
        allow: ['create'],
      };
    });
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract(rules));
    const serialized = JSON.stringify(baseline);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(64 * 1024);
    expect(parseDelegatedBaselineBytes(serialized)).toEqual(baseline);
    expect(parseDelegatedBaselineBytes(Buffer.from(serialized))).toEqual(baseline);
  });

  it('fails closed when baseline bytes are ambiguous, malformed, or oversized', () => {
    const root = workspace();
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]));
    const serialized = JSON.stringify(baseline);
    const duplicateKey = serialized.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );

    expect(() => parseDelegatedBaselineBytes(duplicateKey)).toThrow(/duplicate|JSON/i);
    expect(() =>
      parseDelegatedBaselineBytes(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(serialized)]),
      ),
    ).toThrow(/BOM/i);
    expect(() => parseDelegatedBaselineBytes(Buffer.from([0xff]))).toThrow(/UTF-8/i);
    expect(() => parseDelegatedBaselineBytes('{"value":"\ud800"}')).toThrow(/surrogate|UTF-8/i);
    expect(() =>
      parseDelegatedBaselineBytes(Buffer.allocUnsafe(DELEGATION_LIMITS.baselineBytes + 1)),
    ).toThrow(/64MiB|limit/i);
  });

  it('freezes delegation contract count and field-length limits', () => {
    const root = workspace();
    const createRule = (index: number): DelegationContract['rules'][number] => ({
      path: `new-${index}.txt`,
      semantics: 'whole-file',
      allow: ['create'],
    });
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract(Array.from({ length: DELEGATION_LIMITS.rules }, (_, index) => createRule(index))),
      ),
    ).not.toThrow();
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract(
          Array.from({ length: DELEGATION_LIMITS.rules + 1 }, (_, index) => createRule(index)),
        ),
      ),
    ).toThrow(/rules|limit/i);

    expect(() =>
      captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, {
        version: 'v'.repeat(DELEGATION_LIMITS.versionBytes),
        semantic: { version: 'read-only-v1' },
        rules: [
          {
            path: 'x'.repeat(DELEGATION_LIMITS.pathBytes),
            semantics: 'whole-file',
            allow: ['create', 'delete', 'modify'],
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, {
        version: 'v'.repeat(DELEGATION_LIMITS.versionBytes + 1),
        semantic: { version: 'read-only-v1' },
        rules: [],
      }),
    ).toThrow(/version/i);
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'x'.repeat(DELEGATION_LIMITS.pathBytes + 1),
            semantics: 'whole-file',
            allow: ['create'],
          },
        ]),
      ),
    ).toThrow(/path|relative/i);
    expect(() => assertBaselineEntryLimit(DELEGATION_LIMITS.entries)).not.toThrow();
    expect(() => assertBaselineEntryLimit(DELEGATION_LIMITS.entries + 1)).toThrow(/entries|limit/i);
  });

  it('bounds JSON pointers and the complete canonical contract', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{}');
    const pointers = Array.from(
      { length: DELEGATION_LIMITS.pointersPerRule },
      (_, index) => `/field-${index}`,
    );
    pointers[pointers.length - 1] = `/${'x'.repeat(DELEGATION_LIMITS.pointerBytes - 1)}`;
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'state.json',
            semantics: 'json-mutable-pointers',
            allow: ['modify'],
            mutableJsonPointers: pointers,
          },
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'state.json',
            semantics: 'json-mutable-pointers',
            allow: ['modify'],
            mutableJsonPointers: [...pointers, '/overflow'],
          },
        ]),
      ),
    ).toThrow(/pointer|limit/i);
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'state.json',
            semantics: 'json-mutable-pointers',
            allow: ['modify'],
            mutableJsonPointers: [`/${'x'.repeat(DELEGATION_LIMITS.pointerBytes)}`],
          },
        ]),
      ),
    ).toThrow(/pointer/i);

    const oversized: DelegationContract['rules'] = Array.from({ length: 20 }, (_, index) => ({
      path: `${index}-${'x'.repeat(3990)}`,
      semantics: 'whole-file',
      allow: ['create'],
    }));
    expect(() =>
      captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract(oversized)),
    ).toThrow(/contract|64|size/i);
  });

  it('rejects unknown rule shapes, duplicate allow values and ambiguous pointers', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{"a":{"b":1}}');
    const invalidRules: unknown[] = [
      { path: 'state.json', semantics: 'mystery', allow: ['modify'] },
      { path: 'state.json', semantics: 'whole-file', allow: ['modify', 'modify'] },
      { path: 'state.json', semantics: 'whole-file', allow: ['modify'], extra: true },
      {
        path: 'state.json',
        semantics: 'json-mutable-pointers',
        allow: ['modify'],
        mutableJsonPointers: ['/a~2b'],
      },
      {
        path: 'state.json',
        semantics: 'json-mutable-pointers',
        allow: ['modify'],
        mutableJsonPointers: ['/a/b', '/a/b'],
      },
      {
        path: 'state.json',
        semantics: 'json-mutable-pointers',
        allow: ['modify'],
        mutableJsonPointers: ['/a', '/a/b'],
      },
    ];
    for (const rule of invalidRules) {
      expect(() =>
        captureDelegatedBaseline(
          root,
          OWNER_ID,
          OPERATION_ID,
          contract([rule as DelegationContract['rules'][number]]),
        ),
      ).toThrow();
    }
  });

  it('rejects invalid target types while allowing whole-file creation', () => {
    const root = workspace();
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'plain.txt'), 'plain');
    writeFileSync(join(root, 'state.json'), '{}');

    for (const rule of [
      { path: 'folder', semantics: 'whole-file', allow: ['modify'] },
      { path: 'missing.log', semantics: 'append-only', allow: ['modify'] },
      {
        path: 'missing.json',
        semantics: 'json-mutable-pointers',
        allow: ['modify'],
        mutableJsonPointers: ['/value'],
      },
      { path: 'missing-dir', semantics: 'add-only-directory', allow: ['create'] },
      { path: 'plain.txt', semantics: 'add-only-directory', allow: ['create'] },
    ] as DelegationContract['rules']) {
      expect(() =>
        captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([rule])),
      ).toThrow(/target|file|directory|exist/i);
    }

    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([{ path: 'created.txt', semantics: 'whole-file', allow: ['create'] }]),
    );
    writeFileSync(join(root, 'created.txt'), 'created');
    expect(evaluateDelegatedDelta(root, baseline).accepted).toBe(true);

    const directoryRoot = workspace();
    const directoryBaseline = captureDelegatedBaseline(
      directoryRoot,
      OWNER_ID,
      OPERATION_ID,
      contract([{ path: 'created.txt', semantics: 'whole-file', allow: ['create'] }]),
    );
    mkdirSync(join(directoryRoot, 'created.txt'));
    const rejected = evaluateDelegatedDelta(directoryRoot, directoryBaseline);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted) {
      expect(rejected.violations).toContain('created.txt:whole-file-shape-changed');
    }
  });

  it('rejects a tree that changes between the two complete scans', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{}');
    expect(() =>
      captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]), {
        afterFirstScan: () => writeFileSync(join(root, 'state.json'), '{"changed":true}'),
      }),
    ).toThrow(/scan|扫描|change/i);
  });

  it('uses NFC plus conservative case folding on macOS and Windows', () => {
    expect(workspacePathCollisionKey('Readme.md', 'darwin')).toBe(
      workspacePathCollisionKey('README.md', 'darwin'),
    );
    expect(workspacePathCollisionKey('Straße.txt', 'win32')).toBe(
      workspacePathCollisionKey('STRASSE.txt', 'win32'),
    );
    expect(workspacePathCollisionKey('ẞ.txt', 'darwin')).toBe(
      workspacePathCollisionKey('SS.txt', 'darwin'),
    );
    expect(workspacePathCollisionKey('cafe\u0301.txt', 'darwin')).toBe(
      workspacePathCollisionKey('caf\u00e9.txt', 'darwin'),
    );
    const folded = workspacePathCollisionKey('ẞ/Engine.Lock', 'win32');
    expect(workspacePathCollisionKey(folded, 'win32')).toBe(folded);
    expect(workspacePathCollisionKey('ENGINE.LOCK', 'win32')).toBe(
      workspacePathCollisionKey('engine.lock', 'win32'),
    );
    expect(workspacePathCollisionKey('Readme.md', 'linux')).not.toBe(
      workspacePathCollisionKey('README.md', 'linux'),
    );
  });
});

describe('evaluateDelegatedDelta', () => {
  it('accepts only declared whole-file changes', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{"value":1}');
    writeFileSync(join(root, 'protected.txt'), 'same');
    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'state.json',
          semantics: 'whole-file',
          allow: ['modify'],
        },
      ]),
    );

    writeFileSync(join(root, 'state.json'), '{"value":2}');
    expect(evaluateDelegatedDelta(root, baseline)).toEqual({
      accepted: true,
      changes: ['state.json'],
    });

    writeFileSync(join(root, 'protected.txt'), 'changed');
    const rejected = evaluateDelegatedDelta(root, baseline);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted)
      expect(rejected.violations).toContain('protected.txt:modify-not-allowed');
  });

  it('accepts append-only bytes but rejects a rewritten prefix', () => {
    const root = workspace();
    writeFileSync(join(root, 'evidence.jsonl'), 'old\n');
    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'evidence.jsonl',
          semantics: 'append-only',
          allow: ['modify'],
        },
      ]),
    );

    writeFileSync(join(root, 'evidence.jsonl'), 'old\nnew\n');
    expect(evaluateDelegatedDelta(root, baseline).accepted).toBe(true);

    writeFileSync(join(root, 'evidence.jsonl'), 'bad\nnew\n');
    const rejected = evaluateDelegatedDelta(root, baseline);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted)
      expect(rejected.violations).toContain('evidence.jsonl:append-prefix-changed');
  });

  it('allows an append-only log to be created on its first write', () => {
    const root = workspace();
    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'evidence.jsonl',
          semantics: 'append-only',
          allow: ['create', 'modify'],
        },
      ]),
    );

    writeFileSync(join(root, 'evidence.jsonl'), 'first evidence\n');
    expect(evaluateDelegatedDelta(root, baseline)).toMatchObject({
      accepted: true,
      changes: ['evidence.jsonl'],
    });
  });

  it('treats create+modify append contracts as append-only once the file already exists', () => {
    const root = workspace();
    const target = join(root, 'evidence.jsonl');
    writeFileSync(target, 'first evidence\n');
    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'evidence.jsonl',
          semantics: 'append-only',
          allow: ['create', 'modify'],
        },
      ]),
    );

    writeFileSync(target, 'first evidence\nsecond evidence\n');
    expect(evaluateDelegatedDelta(root, baseline)).toMatchObject({
      accepted: true,
      changes: ['evidence.jsonl'],
    });

    writeFileSync(target, 'replaced evidence\n');
    const replaced = evaluateDelegatedDelta(root, baseline);
    expect(replaced.accepted).toBe(false);
    if (!replaced.accepted) {
      expect(replaced.violations).toContain('evidence.jsonl:append-prefix-changed');
    }

    unlinkSync(target);
    const deleted = evaluateDelegatedDelta(root, baseline);
    expect(deleted.accepted).toBe(false);
    if (!deleted.accepted) {
      expect(deleted.violations).toContain('evidence.jsonl:delete-not-allowed');
    }
  });

  it('rejects append target replacement between the stable scan and prefix read', () => {
    const root = workspace();
    const target = join(root, 'evidence.jsonl');
    writeFileSync(target, 'old\n');
    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'evidence.jsonl',
          semantics: 'append-only',
          allow: ['modify'],
        },
      ]),
    );
    writeFileSync(target, 'old\nnew\n');

    expect(() =>
      evaluateDelegatedDelta(root, baseline, {
        beforeAppendPrefixRead: () => {
          renameSync(target, join(root, 'original-evidence.jsonl'));
          writeFileSync(target, 'old\nattacker\n');
        },
      }),
    ).toThrow(/append|identity|change|变化/i);
  });

  it('protects every JSON field except explicit mutable pointers', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{"story":{"passes":false,"id":"s1"},"version":1}');
    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'state.json',
          semantics: 'json-mutable-pointers',
          allow: ['modify'],
          mutableJsonPointers: ['/story/passes'],
        },
      ]),
    );

    writeFileSync(join(root, 'state.json'), '{"version":1,"story":{"id":"s1","passes":true}}');
    expect(evaluateDelegatedDelta(root, baseline).accepted).toBe(true);

    writeFileSync(join(root, 'state.json'), '{"version":2,"story":{"id":"s1","passes":true}}');
    const rejected = evaluateDelegatedDelta(root, baseline);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted)
      expect(rejected.violations).toContain('state.json:protected-json-changed');
  });

  it('allows object-leaf addition/deletion but keeps every ancestor protected', () => {
    const addRoot = workspace();
    writeFileSync(join(addRoot, 'state.json'), '{"story":{"id":"s1"}}');
    const addBaseline = captureDelegatedBaseline(
      addRoot,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'state.json',
          semantics: 'json-mutable-pointers',
          allow: ['modify'],
          mutableJsonPointers: ['/story/passes'],
        },
      ]),
    );
    writeFileSync(join(addRoot, 'state.json'), '{"story":{"id":"s1","passes":true}}');
    expect(evaluateDelegatedDelta(addRoot, addBaseline).accepted).toBe(true);

    const deleteRoot = workspace();
    writeFileSync(join(deleteRoot, 'state.json'), '{"story":{"id":"s1","passes":false}}');
    const deleteBaseline = captureDelegatedBaseline(
      deleteRoot,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'state.json',
          semantics: 'json-mutable-pointers',
          allow: ['modify'],
          mutableJsonPointers: ['/story/passes'],
        },
      ]),
    );
    writeFileSync(join(deleteRoot, 'state.json'), '{"story":{"id":"s1"}}');
    expect(evaluateDelegatedDelta(deleteRoot, deleteBaseline).accepted).toBe(true);
    writeFileSync(join(deleteRoot, 'state.json'), '{}');
    const rejected = evaluateDelegatedDelta(deleteRoot, deleteBaseline);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted) {
      expect(rejected.violations).toContain('state.json:protected-json-changed');
    }

    const missingAncestorRoot = workspace();
    writeFileSync(join(missingAncestorRoot, 'state.json'), '{}');
    expect(() =>
      captureDelegatedBaseline(
        missingAncestorRoot,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'state.json',
            semantics: 'json-mutable-pointers',
            allow: ['modify'],
            mutableJsonPointers: ['/story/passes'],
          },
        ]),
      ),
    ).toThrow(/ancestor|pointer|parent/i);
  });

  it('allows an existing array index replacement but rejects deletion or index shift', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{"items":[1,2]}');
    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'state.json',
          semantics: 'json-mutable-pointers',
          allow: ['modify'],
          mutableJsonPointers: ['/items/0'],
        },
      ]),
    );
    writeFileSync(join(root, 'state.json'), '{"items":[9,2]}');
    expect(evaluateDelegatedDelta(root, baseline).accepted).toBe(true);
    writeFileSync(join(root, 'state.json'), '{"items":[2]}');
    const rejected = evaluateDelegatedDelta(root, baseline);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted) {
      expect(rejected.violations).toContain('state.json:protected-json-changed');
    }
  });

  it('rejects duplicate-key JSON instead of projecting the parser last-value view', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{"protected":1,"protected":2}');
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'state.json',
            semantics: 'json-mutable-pointers',
            allow: ['modify'],
            mutableJsonPointers: ['/mutable'],
          },
        ]),
      ),
    ).toThrow(/duplicate|JSON/i);
  });

  it('rejects UTF-8 BOM before JSON decoding can erase it', () => {
    const root = workspace();
    writeFileSync(
      join(root, 'state.json'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"mutable":1}')]),
    );
    expect(() =>
      captureDelegatedBaseline(
        root,
        OWNER_ID,
        OPERATION_ID,
        contract([
          {
            path: 'state.json',
            semantics: 'json-mutable-pointers',
            allow: ['modify'],
            mutableJsonPointers: ['/mutable'],
          },
        ]),
      ),
    ).toThrow(/BOM|JSON/i);
  });

  it('allows new members in an add-only directory but preserves every old member', () => {
    const root = workspace();
    mkdirSync(join(root, 'screenshots'));
    writeFileSync(join(root, 'screenshots', 'old.png'), 'old');
    const baseline = captureDelegatedBaseline(
      root,
      OWNER_ID,
      OPERATION_ID,
      contract([
        {
          path: 'screenshots',
          semantics: 'add-only-directory',
          allow: ['create'],
        },
      ]),
    );

    writeFileSync(join(root, 'screenshots', 'new.png'), 'new');
    expect(evaluateDelegatedDelta(root, baseline).accepted).toBe(true);

    writeFileSync(join(root, 'screenshots', 'old.png'), 'rewritten');
    const rejected = evaluateDelegatedDelta(root, baseline);
    expect(rejected.accepted).toBe(false);
    if (!rejected.accepted)
      expect(rejected.violations).toContain('screenshots/old.png:existing-member-changed');
  });

  it('detects exact unchanged baselines for prestart abort', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{}');
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]));
    expect(evaluateDelegatedDelta(root, baseline, { requireUnchanged: true }).accepted).toBe(true);

    writeFileSync(join(root, 'state.json'), '{"changed":true}');
    const rejected = evaluateDelegatedDelta(root, baseline, { requireUnchanged: true });
    expect(rejected.accepted).toBe(false);
  });

  it('does not persist full file bytes in the baseline artifact', () => {
    const root = workspace();
    writeFileSync(join(root, 'secret.txt'), 'never-persist-this-value');
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]));
    const serialized = JSON.stringify(baseline);
    expect(serialized).not.toContain(readFileSync(join(root, 'secret.txt'), 'utf8'));
  });

  it('strictly validates a recovered baseline before trusting its digest', () => {
    const root = workspace();
    writeFileSync(join(root, 'state.json'), '{}');
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, contract([]));

    expect(() => evaluateDelegatedDelta(root, { ...baseline, ownerId: 'owner-1' })).toThrow(
      /ownerId|uuid/i,
    );
    expect(() =>
      evaluateDelegatedDelta(root, {
        ...baseline,
        unexpected: true,
      } as typeof baseline),
    ).toThrow(/unknown|field/i);
  });
});

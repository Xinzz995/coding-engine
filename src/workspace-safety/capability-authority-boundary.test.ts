import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MutationWriterAuthorityControlled } from './mutation-domain.js';
import { WorkspaceOperationHandleControlled } from './operation.js';

const TEST_SEAMS = new Set([
  'workspace-safety/identity-authority-test-seam.ts',
  'workspace-safety/mutation-authority-test-seam.ts',
  'workspace-safety/operation-authority-test-seam.ts',
  'workspace-safety/recovery-authority-test-seam.ts',
  'workspace-safety/windows-identity-transport-test-seam.ts',
  'workspace-safety/workspace-authority-test-seam.ts',
]);

function productionFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const info = statSync(child);
      if (info.isDirectory()) {
        if (name !== '__fixtures__') visit(child);
      } else if (
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.test-support.ts') &&
        !TEST_SEAMS.has(sourcePath(root, child))
      ) {
        files.push(child);
      }
    }
  };
  visit(root);
  return files.sort();
}

type ControlledModule = 'operation' | 'operation-records' | 'mutation' | 'mutation-domain';

function controlledModule(specifier: string): ControlledModule | undefined {
  for (const name of ['operation', 'operation-records', 'mutation', 'mutation-domain'] as const) {
    if (new RegExp(`(?:^|/)${name}\\.js$`, 'u').test(specifier)) return name;
  }
  return undefined;
}

function sourcePath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

describe('operation and mutation capability boundary', () => {
  it('forbids production code from importing the identity authority test seam', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const offenders = productionFiles(root).filter((path) =>
      /from\s+['"][^'"]*identity-authority-test-seam(?:\.js)?['"]/u.test(
        readFileSync(path, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('forbids production code from importing the Windows identity transport test seam', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const offenders = productionFiles(root).filter((path) =>
      /(?:from\s+|import\s*\(\s*)['"][^'"]*windows-identity-transport-test-seam(?:\.js)?['"]/u.test(
        readFileSync(path, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the injectable Windows identity transport core inside its owning module', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const offenders = productionFiles(root).filter((path) => {
      if (sourcePath(root, path) === 'workspace-safety/windows-identity-transport.ts') {
        return false;
      }
      return /\b(?:readWindowsIdentitySnapshotControlled|WindowsIdentityTransportRuntime)\b/u.test(
        readFileSync(path, 'utf8'),
      );
    });
    expect(offenders).toEqual([]);
  });

  it('forbids production code from importing the operation or mutation test seam', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const offenders = productionFiles(root).filter((path) =>
      /from\s+['"][^'"]*(?:operation|mutation)-authority-test-seam(?:\.js)?['"]/u.test(
        readFileSync(path, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('allows low-level Controlled imports only inside fixed coordinators', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const allowed = new Map<ControlledModule, ReadonlySet<string>>([
      [
        'operation',
        new Set([
          'workspace-safety/coordinator.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      ['operation-records', new Set(['workspace-safety/operation.ts'])],
      [
        'mutation-domain',
        new Set(['workspace-safety/mutation.ts', 'workspace-safety/mutation-recovery.ts']),
      ],
      ['mutation', new Set(['workspace-safety/product-mutations.ts'])],
    ]);
    const offenders: string[] = [];
    for (const path of productionFiles(root)) {
      const filename = sourcePath(root, path);
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gu,
      )) {
        if (!match[1].includes('Controlled')) continue;
        const module = controlledModule(match[2]);
        if (module && !allowed.get(module)?.has(filename)) {
          offenders.push(`${filename}|${match[2]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('forbids namespace, default, re-export, and dynamic access to controlled modules', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const offenders: string[] = [];
    const broadAccess = [
      /import\s+(?:type\s+)?\*\s+as\s+[^\s]+\s+from\s+['"]([^'"]+)['"]/gu,
      /import\s+(?:type\s+)?[A-Za-z_$][\w$]*\s+from\s+['"]([^'"]+)['"]/gu,
      /export\s+\*\s+from\s+['"]([^'"]+)['"]/gu,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    ];
    for (const path of productionFiles(root)) {
      const filename = sourcePath(root, path);
      const source = readFileSync(path, 'utf8');
      for (const pattern of broadAccess) {
        for (const match of source.matchAll(pattern)) {
          if (controlledModule(match[1])) offenders.push(`${filename}|${match[1]}`);
        }
      }
    }
    for (const path of productionFiles(root)) {
      const filename = sourcePath(root, path);
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(
        /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gu,
      )) {
        if (match[1].includes('Controlled') && controlledModule(match[2])) {
          offenders.push(`${filename}|${match[2]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps direct Controlled use inside the operation and mutation coordinator allowlists', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const allowedByName = new Map<string, ReadonlySet<string>>([
      [
        'runWorkspaceOperationControlled',
        new Set(['workspace-safety/coordinator.ts', 'workspace-safety/operation.ts']),
      ],
      [
        'WorkspaceOperationHandleControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'bindSupervisorControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'armContainmentControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'readPreparedBoundBindingControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'readArmedBindingControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'acceptInstalledDrainedReceiptControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'abortPrestartControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'settleArmedControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'installQuarantineControlled',
        new Set([
          'workspace-safety/operation.ts',
          'workspace-safety/posix-supervisor.ts',
          'workspace-safety/windows-supervisor-integration.ts',
        ]),
      ],
      [
        'runWorkspaceMutationControlled',
        new Set(['workspace-safety/mutation.ts', 'workspace-safety/product-mutations.ts']),
      ],
      [
        'createMutationWriterAuthorityControlled',
        new Set([
          'workspace-safety/mutation-domain.ts',
          'workspace-safety/mutation.ts',
          'workspace-safety/mutation-recovery.ts',
        ]),
      ],
      [
        'advanceWorkspaceMutationControlled',
        new Set([
          'workspace-safety/mutation-domain.ts',
          'workspace-safety/mutation.ts',
          'workspace-safety/mutation-recovery.ts',
        ]),
      ],
      [
        'writeMutationInputStagingControlled',
        new Set(['workspace-safety/mutation-domain.ts', 'workspace-safety/mutation.ts']),
      ],
      [
        'installMutationStagingControlled',
        new Set(['workspace-safety/mutation-domain.ts', 'workspace-safety/mutation.ts']),
      ],
      [
        'MutationWriterAuthorityControlled',
        new Set([
          'workspace-safety/mutation-domain.ts',
          'workspace-safety/mutation.ts',
          'workspace-safety/mutation-recovery.ts',
        ]),
      ],
    ]);
    const offenders: string[] = [];
    for (const path of productionFiles(root)) {
      const filename = sourcePath(root, path);
      const source = readFileSync(path, 'utf8');
      for (const [name, allowedFiles] of allowedByName) {
        if (source.includes(name) && !allowedFiles.has(filename)) {
          offenders.push(`${filename}|${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('rejects forged operation handles and mutation writer authorities', () => {
    expect(
      () =>
        new WorkspaceOperationHandleControlled(
          Symbol('forged-operation-authority') as never,
          {} as never,
          Buffer.alloc(0),
          Buffer.alloc(0),
          {} as never,
          Buffer.alloc(0),
          Buffer.alloc(0),
          'sha256:forged',
          {} as never,
          Buffer.alloc(0),
          '/forged',
          () => new Date(0),
          {},
        ),
    ).toThrow(/authority token is invalid/u);
    expect(
      () =>
        new MutationWriterAuthorityControlled(Symbol('forged-mutation-authority') as never, {
          workspace: {} as never,
          verify: async () => undefined,
        }),
    ).toThrow(/authority token is invalid/u);
  });
});

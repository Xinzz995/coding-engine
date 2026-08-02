import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface SourceImport {
  specifier: string;
  kind: 'named' | 'broad';
  names: string[];
  runtime: boolean;
}

function sourcePath(path: string): string {
  return relative(SOURCE_ROOT, path).replaceAll('\\', '/');
}

function productionSources(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test-support.ts')
      ) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

function parsedSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function sourceImportsFromText(path: string, text: string): SourceImport[] {
  const imports: SourceImport[] = [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (
        clause?.name !== undefined ||
        (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings))
      ) {
        imports.push({
          specifier: node.moduleSpecifier.text,
          kind: 'broad',
          names: [],
          runtime: clause?.isTypeOnly !== true,
        });
      } else if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements.filter((element) => !element.isTypeOnly);
        imports.push({
          specifier: node.moduleSpecifier.text,
          kind: 'named',
          names: elements.map((element) => element.propertyName?.text ?? element.name.text),
          runtime: clause.isTypeOnly !== true && elements.length > 0,
        });
      } else {
        imports.push({
          specifier: node.moduleSpecifier.text,
          kind: 'broad',
          names: [],
          runtime: clause?.isTypeOnly !== true,
        });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const elements =
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.filter((element) => !element.isTypeOnly)
            : null;
        imports.push({
          specifier: node.moduleSpecifier.text,
          kind: elements === null ? 'broad' : 'named',
          names: elements?.map((element) => element.propertyName?.text ?? element.name.text) ?? [],
          runtime: node.isTypeOnly !== true && (elements === null || elements.length > 0),
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({
        specifier: node.arguments[0].text,
        kind: 'broad',
        names: [],
        runtime: true,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function sourceImports(path: string): SourceImport[] {
  return sourceImportsFromText(path, readFileSync(path, 'utf8'));
}

function importsModule(path: string, suffix: string): boolean {
  return sourceImports(path).some((entry) => entry.specifier.endsWith(suffix));
}

function callsIdentifier(path: string, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const visitCallee = (callee: ts.Node): void => {
        if (ts.isIdentifier(callee) && callee.text === name) found = true;
        if (!found) ts.forEachChild(callee, visitCallee);
      };
      visitCallee(node.expression);
      if (found) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(path));
  return found;
}

function functionCallsIdentifier(path: string, functionName: string, calleeName: string): boolean {
  let found = false;
  const source = parsedSource(path);
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === calleeName) found = true;
    }
    if (!found) ts.forEachChild(node, visitCalls);
  };
  const visitFunctions = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName && node.body) {
      visitCalls(node.body);
      return;
    }
    ts.forEachChild(node, visitFunctions);
  };
  visitFunctions(source);
  return found;
}

function resolvedLocalModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const sourceSpecifier = specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.ts` : specifier;
  const candidate = join(dirname(importer), sourceSpecifier);
  if (existsSync(candidate)) return sourcePath(candidate);
  const index = join(candidate, 'index.ts');
  return existsSync(index) ? sourcePath(index) : null;
}

interface RuntimeGraphViolation {
  root: string;
  module: string;
  reason: string;
  chain: string[];
}

const LEGACY_WRITERS = new Map<string, ReadonlySet<string>>([
  ['engine/state.ts', new Set(['ensureStateFile'])],
  ['engine/evidence.ts', new Set(['appendEvidence'])],
  ['report/report.ts', new Set(['writeReport'])],
  ['engine/prd-guard.ts', new Set(['createPrdGuard'])],
  ['engine/validation-protocol.ts', new Set(['clearValidationResult'])],
]);

/**
 * Walks the runtime import graph, rather than only checking each root's direct imports. This is
 * intentionally module-level: unsafe no-session implementations live in separate modules, so a
 * formal session root can never reach them without the graph exposing the bypass.
 */
function runtimeGraphViolations(options: {
  roots: readonly string[];
  modules: ReadonlyMap<string, readonly SourceImport[]>;
  resolveLocal(importer: string, specifier: string): string | null;
  childProcessAllowlist?: ReadonlySet<string>;
}): RuntimeGraphViolation[] {
  const violations: RuntimeGraphViolation[] = [];
  const emitted = new Set<string>();
  const childProcessAllowlist = options.childProcessAllowlist ?? new Set<string>();
  const emit = (violation: RuntimeGraphViolation): void => {
    const key = `${violation.root}|${violation.module}|${violation.reason}|${violation.chain.join('>')}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    violations.push(violation);
  };

  for (const root of options.roots) {
    const queue: Array<{ module: string; chain: string[] }> = [{ module: root, chain: [root] }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.module)) continue;
      visited.add(current.module);
      const imports = options.modules.get(current.module) ?? [];
      for (const entry of imports) {
        if (!entry.runtime) continue;
        if (
          (entry.specifier === 'node:child_process' || entry.specifier === 'child_process') &&
          !childProcessAllowlist.has(current.module)
        ) {
          emit({
            root,
            module: current.module,
            reason: entry.specifier,
            chain: [...current.chain, entry.specifier],
          });
          continue;
        }
        if (entry.specifier.endsWith('/process-tree.js')) {
          emit({
            root,
            module: current.module,
            reason: 'legacy-process-tree',
            chain: [...current.chain, entry.specifier],
          });
        }

        const target = options.resolveLocal(current.module, entry.specifier);
        if (target === null) continue;
        if (target.endsWith('.test-support.ts') || target.includes('/__fixtures__/')) {
          emit({
            root,
            module: current.module,
            reason: 'test-support-module',
            chain: [...current.chain, target],
          });
          continue;
        }
        const forbiddenNames = LEGACY_WRITERS.get(target);
        if (forbiddenNames !== undefined) {
          const names = entry.kind === 'broad' ? ['broad-import'] : entry.names;
          for (const name of names) {
            if (name === 'broad-import' || forbiddenNames.has(name)) {
              emit({
                root,
                module: current.module,
                reason: `legacy-workspace-writer:${target}:${name}`,
                chain: [...current.chain, target],
              });
            }
          }
        }
        if (options.modules.has(target)) {
          queue.push({ module: target, chain: [...current.chain, target] });
        }
      }
    }
  }
  return violations;
}

function sourceModuleGraph(): Map<string, readonly SourceImport[]> {
  return new Map(
    productionSources(SOURCE_ROOT).map((path) => [sourcePath(path), sourceImports(path)] as const),
  );
}

function resolveSourceGraphImport(importer: string, specifier: string): string | null {
  return resolvedLocalModule(join(SOURCE_ROOT, importer), specifier);
}

describe('workspace safety activation boundary', () => {
  it('keeps every formal workspace entrypoint attached to its safety capability', () => {
    const requiredImports = new Map<string, readonly string[]>([
      ['cli.ts', ['workspace-safety/bootstrap.js', 'workspace-safety/lease.js']],
      ['engine/loop.ts', ['workspace-safety/lease.js', 'workspace-safety/session.js']],
      ['engine/loop-preflight.ts', ['workspace-safety/session.js']],
      ['engine/agent.ts', ['workspace-safety/coordinator.js']],
      ['engine/gate.ts', ['workspace-safety/coordinator.js']],
      ['engine/state.ts', ['workspace-safety/session.js']],
      ['engine/evidence.ts', ['workspace-safety/session.js']],
      ['engine/prd-guard.ts', ['workspace-safety/session.js']],
      ['engine/validation-protocol.ts', ['workspace-safety/session.js']],
      ['report/report.ts', ['workspace-safety/session.js']],
      [
        'report/current-report.ts',
        ['workspace-safety/session.js', 'review/managed-observation.js'],
      ],
      ['review/decision-command.ts', ['workspace-safety/session.js']],
      ['review/final-review.ts', ['workspace-safety/session.js']],
      ['review/runner.ts', ['workspace-safety/coordinator.js']],
      ['review/state.ts', ['workspace-safety/session.js']],
      ['status/status.ts', ['workspace-safety/status.js']],
      [
        'status/runner-version-observation.ts',
        ['workspace-safety/session.js', 'review/runner-version-observation.js'],
      ],
      ['doctor/doctor.ts', ['workspace-safety/status.js']],
      ['dashboard/server.ts', ['workspace-safety/status.js']],
    ]);
    const missing: string[] = [];
    for (const [filename, specifiers] of requiredImports) {
      const path = join(SOURCE_ROOT, filename);
      for (const specifier of specifiers) {
        if (!importsModule(path, specifier)) missing.push(`${filename}|${specifier}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps all subprocess entrypoints on the managed workspace coordinator', () => {
    const coordinatorEntrypoints = [
      'engine/agent.ts',
      'engine/gate.ts',
      'review/runner.ts',
      'review/managed-observation.ts',
    ] as const;
    const offenders: string[] = [];
    for (const filename of coordinatorEntrypoints) {
      const path = join(SOURCE_ROOT, filename);
      const imports = sourceImports(path);
      if (!importsModule(path, 'workspace-safety/coordinator.js')) {
        offenders.push(`${filename}|missing-managed-coordinator`);
      }
      if (!callsIdentifier(path, 'runManagedWorkspaceProcess')) {
        offenders.push(`${filename}|missing-managed-process-call`);
      }
      for (const entry of imports) {
        if (
          entry.specifier.includes('child_process') ||
          entry.specifier.endsWith('/process-tree.js') ||
          entry.specifier.endsWith('/lock.js')
        ) {
          offenders.push(`${filename}|${entry.specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps formal Review and review-decision on the managed observation boundary', () => {
    const formalEntrypoints = [
      'review/final-review.ts',
      'review/decision-command.ts',
      'report/current-report.ts',
      'status/runner-version-observation.ts',
    ] as const;
    const offenders: string[] = [];
    for (const filename of formalEntrypoints) {
      const path = join(SOURCE_ROOT, filename);
      const source = readFileSync(path, 'utf8');
      const imports = sourceImports(path);
      const requiredBoundary =
        filename === 'status/runner-version-observation.ts'
          ? 'observeCurrentReviewRunnerVersion'
          : 'createManagedReviewObservation';
      if (!source.includes(requiredBoundary)) {
        offenders.push(`${filename}|missing-${requiredBoundary}`);
      }
      if (source.includes('new GhGitHubQualityClient')) {
        offenders.push(`${filename}|default-unmanaged-github-client`);
      }
      for (const entry of imports) {
        if (entry.specifier.includes('child_process')) {
          offenders.push(`${filename}|${entry.specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps formal TDD policy probes and coverage on the managed coordinator', () => {
    const tddGate = join(SOURCE_ROOT, 'engine/tdd-gate.ts');
    const preflight = join(SOURCE_ROOT, 'engine/loop-preflight.ts');
    const loop = join(SOURCE_ROOT, 'engine/loop.ts');
    const productMutations = join(SOURCE_ROOT, 'workspace-safety/product-mutations.ts');
    const offenders: string[] = [];

    if (!importsModule(tddGate, 'workspace-safety/coordinator.js')) {
      offenders.push('engine/tdd-gate.ts|missing-managed-coordinator');
    }
    if (
      !functionCallsIdentifier(tddGate, 'runManagedGitPolicyProbes', 'runManagedWorkspaceProcess')
    ) {
      offenders.push('engine/tdd-gate.ts|managed-git-bypasses-coordinator');
    }
    if (!functionCallsIdentifier(tddGate, 'checkTddPolicyManaged', 'runManagedGitPolicyProbes')) {
      offenders.push('engine/tdd-gate.ts|managed-policy-bypasses-managed-git');
    }
    if (!functionCallsIdentifier(tddGate, 'runTddGate', 'checkTddPolicyManaged')) {
      offenders.push('engine/tdd-gate.ts|runTddGate-uses-unmanaged-policy');
    }
    if (!functionCallsIdentifier(preflight, 'runLoopPreflight', 'checkTddPolicyManaged')) {
      offenders.push('engine/loop-preflight.ts|preflight-uses-unmanaged-policy');
    }
    if (!callsIdentifier(loop, 'runTddGate')) {
      offenders.push('engine/loop.ts|formal-run-missing-managed-tdd-gate');
    }
    if (!functionCallsIdentifier(productMutations, 'verifyApplyEnvironment', 'runTddGate')) {
      offenders.push('workspace-safety/product-mutations.ts|apply-prd-missing-managed-tdd-gate');
    }

    for (const path of productionSources(SOURCE_ROOT)) {
      const filename = sourcePath(path);
      if (filename === 'doctor/doctor.ts') continue;
      for (const entry of sourceImports(path)) {
        if (
          entry.specifier.endsWith('/tdd-gate.js') &&
          (entry.kind === 'broad' || entry.names.includes('checkTddPolicy'))
        ) {
          offenders.push(`${filename}|unmanaged-checkTddPolicy`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps loop and final review away from legacy locks and unmanaged process helpers', () => {
    const orchestrators = [
      'engine/loop.ts',
      'review/final-review.ts',
      'report/current-report.ts',
    ] as const;
    const offenders: string[] = [];
    for (const filename of orchestrators) {
      const path = join(SOURCE_ROOT, filename);
      for (const entry of sourceImports(path)) {
        if (
          entry.specifier.includes('child_process') ||
          entry.specifier.endsWith('/process-tree.js') ||
          entry.specifier.endsWith('/lock.js')
        ) {
          offenders.push(`${filename}|${entry.specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the browser opener outside the active run session', () => {
    const cli = join(SOURCE_ROOT, 'cli.ts');
    const loop = join(SOURCE_ROOT, 'engine/loop.ts');
    const dashboardServer = join(SOURCE_ROOT, 'dashboard/server.ts');

    expect(importsModule(cli, 'dashboard/browser-opener.js')).toBe(true);
    expect(importsModule(loop, 'dashboard/browser-opener.js')).toBe(false);
    expect(importsModule(dashboardServer, 'dashboard/browser-opener.js')).toBe(false);
    expect(
      sourceImports(dashboardServer).some((entry) => entry.specifier.includes('child_process')),
    ).toBe(false);
  });

  it('permanently removes the legacy process-tree helper from production', () => {
    const offenders: string[] = [];
    for (const path of productionSources(SOURCE_ROOT)) {
      for (const entry of sourceImports(path)) {
        if (entry.specifier.endsWith('/process-tree.js')) {
          offenders.push(`${sourcePath(path)}|${entry.specifier}`);
        }
      }
    }

    expect(existsSync(join(SOURCE_ROOT, 'engine/process-tree.ts'))).toBe(false);
    expect(offenders).toEqual([]);
  });

  it('keeps every formal session root transitively away from unmanaged process and writer modules', () => {
    const roots = [
      'engine/loop.ts',
      'engine/loop-preflight.ts',
      'workspace-safety/product-mutations.ts',
      'review/final-review.ts',
      'review/decision-command.ts',
      'report/current-report.ts',
      'status/runner-version-observation.ts',
    ] as const;
    // These are the fixed platform containment/identity transports owned by the coordinator. They
    // are the only production modules in a formal session graph allowed to launch or inspect an OS
    // process directly; application, Review and policy modules never enter this list.
    const fixedPlatformTransports = new Set([
      'workspace-safety/darwin-mount-table-transport.ts',
      'workspace-safety/identity.ts',
      'workspace-safety/posix-containment.ts',
      'workspace-safety/posix-supervisor.ts',
      'workspace-safety/windows-identity-transport.ts',
      'workspace-safety/windows-path-attributes-transport.ts',
      'workspace-safety/windows-supervisor-launch.ts',
    ]);
    const requiredTransportExceptions = new Set(
      runtimeGraphViolations({
        roots,
        modules: sourceModuleGraph(),
        resolveLocal: resolveSourceGraphImport,
      })
        .filter(
          (violation) =>
            violation.reason === 'node:child_process' || violation.reason === 'child_process',
        )
        .map((violation) => violation.module),
    );
    expect(requiredTransportExceptions).toEqual(fixedPlatformTransports);
    const violations = runtimeGraphViolations({
      roots,
      modules: sourceModuleGraph(),
      resolveLocal: resolveSourceGraphImport,
      childProcessAllowlist: fixedPlatformTransports,
    });

    expect(
      violations.map(
        (violation) => `${violation.root}|${violation.reason}|${violation.chain.join(' -> ')}`,
      ),
    ).toEqual([]);
  });

  it('detects an indirect unmanaged preflight counterexample and ignores type-only imports', () => {
    const modules = new Map<string, readonly SourceImport[]>([
      [
        'review/final-review.ts',
        sourceImportsFromText(
          'review/final-review.ts',
          "import { runReviewPreflight } from './preflight.js';",
        ),
      ],
      [
        'review/preflight.ts',
        sourceImportsFromText(
          'review/preflight.ts',
          "export { runUnmanagedReviewPreflight } from './unmanaged-preflight.js';",
        ),
      ],
      [
        'review/unmanaged-preflight.ts',
        sourceImportsFromText(
          'review/unmanaged-preflight.ts',
          "import { execFileSync } from 'node:child_process';",
        ),
      ],
      [
        'review/type-only.ts',
        sourceImportsFromText(
          'review/type-only.ts',
          "import type { ChildProcess } from 'node:child_process';",
        ),
      ],
    ]);
    const resolveLocal = (importer: string, specifier: string): string | null => {
      if (!specifier.startsWith('.')) return null;
      const sourceSpecifier = specifier.endsWith('.js')
        ? `${specifier.slice(0, -3)}.ts`
        : specifier;
      return join(dirname(importer), sourceSpecifier).replaceAll('\\', '/');
    };

    const unsafe = runtimeGraphViolations({
      roots: ['review/final-review.ts'],
      modules,
      resolveLocal,
    });
    expect(unsafe).toHaveLength(1);
    expect(unsafe[0]).toMatchObject({
      root: 'review/final-review.ts',
      module: 'review/unmanaged-preflight.ts',
      reason: 'node:child_process',
    });
    expect(unsafe[0]?.chain).toEqual([
      'review/final-review.ts',
      'review/preflight.ts',
      'review/unmanaged-preflight.ts',
      'node:child_process',
    ]);
    expect(
      runtimeGraphViolations({ roots: ['review/type-only.ts'], modules, resolveLocal }),
    ).toEqual([]);
  });

  it('forbids production control flow from importing legacy synchronous workspace writers', () => {
    const forbiddenByModule = new Map<string, ReadonlySet<string>>([
      ['engine/state.ts', new Set(['ensureStateFile'])],
      ['engine/evidence.ts', new Set(['appendEvidence'])],
      ['report/report.ts', new Set(['writeReport'])],
      ['engine/prd-guard.ts', new Set(['createPrdGuard'])],
      ['engine/validation-protocol.ts', new Set(['clearValidationResult'])],
    ]);
    const moduleOwners = new Set([
      'engine/state.ts',
      'engine/evidence.ts',
      'report/report.ts',
      'engine/prd-guard.ts',
      'engine/validation-protocol.ts',
    ]);
    const offenders: string[] = [];

    for (const path of productionSources(SOURCE_ROOT)) {
      const filename = sourcePath(path);
      if (moduleOwners.has(filename)) continue;
      for (const entry of sourceImports(path)) {
        const target = resolvedLocalModule(path, entry.specifier);
        if (target === null) continue;
        const forbiddenNames = forbiddenByModule.get(target);
        if (forbiddenNames === undefined) continue;
        if (entry.kind === 'broad') {
          offenders.push(`${filename}|${target}|broad-import`);
          continue;
        }
        for (const name of entry.names) {
          if (forbiddenNames.has(name)) offenders.push(`${filename}|${target}|${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

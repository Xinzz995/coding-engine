import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDarkPosixHelperBundle, readPosixHelperBundleFromPaths } from './posix-supervisor.js';

const asset = (name: string): string =>
  fileURLToPath(new URL(`../../assets/workspace-safety/${name}`, import.meta.url));
const supervisorPath = asset('posix-supervisor-helper.mjs');
const corePath = asset('posix-supervisor-core.mjs');
const launcherPath = asset('posix-launcher-helper.mjs');
const workspaceSafetyRoot = dirname(fileURLToPath(import.meta.url));

function productionWorkspaceSafetySources(root: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__' && entry.name !== 'fixtures') {
        paths.push(...productionWorkspaceSafetySources(path));
      }
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      paths.push(path);
    }
  }
  return paths.sort();
}

function writableNegativeGroupSignals(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(/process\.kill\s*\(\s*-\s*[^,]+,\s*([^)]+)\)/gu)]
    .filter((match) => match[1]?.trim() !== '0')
    .map((match) => `${basename(path)}:${match[0].replace(/\s+/gu, ' ')}`);
}

function bundle(parts: readonly [Buffer, Buffer, Buffer]): Buffer {
  return Buffer.concat([
    Buffer.from('coding-x-posix-supervisor-v1\0', 'utf8'),
    parts[0],
    Buffer.from('\0coding-x-posix-supervisor-core-v1\0', 'utf8'),
    parts[1],
    Buffer.from('\0coding-x-posix-launcher-v1\0', 'utf8'),
    parts[2],
  ]);
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe.runIf(process.platform !== 'win32')('fixed POSIX helper assets', () => {
  it('binds every exact module byte in a stable domain-separated order', () => {
    const parts = [
      readFileSync(supervisorPath),
      readFileSync(corePath),
      readFileSync(launcherPath),
    ] as const;
    const actual = readDarkPosixHelperBundle();
    expect(actual).toEqual(bundle(parts));
    const originalDigest = digest(actual);
    for (const index of parts.keys()) {
      const changed = parts.map((entry) => Buffer.from(entry)) as [Buffer, Buffer, Buffer];
      changed[index][0] ^= 1;
      expect(digest(bundle(changed))).not.toBe(originalDigest);
    }
  });

  it('rejects a fixed helper with an external hard-link alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-posix-helper-link-'));
    try {
      const paths = [supervisorPath, corePath, launcherPath].map((path) => {
        const target = join(root, basename(path));
        cpSync(path, target);
        return target;
      }) as [string, string, string];
      linkSync(paths[1], join(root, 'external-core-alias.mjs'));

      expect(() => readPosixHelperBundleFromPaths(paths)).toThrow(/single-link/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('opens fixed helpers before binding their path identity and rejects FIFOs without waiting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-posix-helper-fifo-'));
    const fifo = join(root, 'core.fifo');
    try {
      const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      expect(created.status, created.stderr).toBe(0);

      const assetSource = readFileSync(corePath, 'utf8');
      expect(assetSource).toContain('constants.O_NONBLOCK');
      expect(assetSource.indexOf('descriptor = openSync')).toBeLessThan(
        assetSource.indexOf('const openedPath = lstatSync'),
      );

      const loaderSource = readFileSync(
        join(workspaceSafetyRoot, 'posix-supervisor-assets.ts'),
        'utf8',
      );
      expect(loaderSource).toContain('constants.O_NONBLOCK');
      expect(loaderSource.indexOf('descriptor = openSync')).toBeLessThan(
        loaderSource.indexOf('const openedPath = lstatSync'),
      );

      expect(() => readPosixHelperBundleFromPaths([supervisorPath, fifo, launcherPath])).toThrow(
        /ordinary bounded single-link file/u,
      );

      const core = (await import(pathToFileURL(corePath).href)) as {
        readStableFile(path: string, maximumBytes: number): Buffer;
      };
      expect(() => core.readStableFile(fifo, 1024)).toThrow(/ordinary bounded single-link file/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps each fixed helper below the deep-review size trigger and confines group signalling to the live launcher', () => {
    const supervisor = readFileSync(supervisorPath, 'utf8');
    const core = readFileSync(corePath, 'utf8');
    const launcher = readFileSync(launcherPath, 'utf8');
    for (const source of [supervisor, core, launcher]) {
      expect(source.trimEnd().split('\n').length).toBeLessThan(1000);
    }
    expect(supervisor).not.toContain('process.kill(-');
    expect(supervisor).not.toContain('signalGroup(');
    expect(launcher).toContain('process.kill(-process.pid, signal)');
  });

  it('accepts only the same persisted semantic contract union as the engine', () => {
    const moduleUrl = pathToFileURL(corePath).href;
    const script = `
      import { validateContract } from ${JSON.stringify(moduleUrl)};
      const hash = 'sha256:' + 'a'.repeat(64);
      const head = 'b'.repeat(40);
      const requestId = '11111111-1111-4111-8111-111111111111';
      const valid = [
        { version: 'read-only-v1', semantic: { version: 'read-only-v1' }, rules: [] },
        { version: 'builder-v1', semantic: {
          version: 'builder-state-v1', storyId: 'story-1', acceptanceHash: hash, checkCount: 1
        }, rules: [] },
        { version: 'validator-v1', semantic: {
          version: 'validator-result-v1', requestId, storyId: 'story-1',
          acceptanceHash: hash, checkCount: 1, gitHead: head
        }, rules: [] },
      ];
      for (const contract of valid) validateContract(contract);
      const invalid = [
        { version: 'read-only-v1', rules: [] },
        { version: 'read-only-v1', semantic: { version: 'read-only-v1', extra: true }, rules: [] },
        { version: 'validator-v1', semantic: {
          version: 'validator-result-v1', requestId, storyId: 'story-1',
          acceptanceHash: hash, checkCount: -1, gitHead: head
        }, rules: [] },
      ];
      for (const contract of invalid) {
        let rejected = false;
        try { validateContract(contract); } catch { rejected = true; }
        if (!rejected) throw new Error('invalid semantic contract was accepted');
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('leaves no reusable negative-group signal path in workspace-safety production code', () => {
    const productionSignals = productionWorkspaceSafetySources(workspaceSafetyRoot).flatMap(
      (path) => writableNegativeGroupSignals(path),
    );
    const fixedAssetSignals = [supervisorPath, corePath, launcherPath].flatMap((path) =>
      writableNegativeGroupSignals(path),
    );
    expect(productionSignals).toEqual([]);
    expect(fixedAssetSignals).toEqual([
      'posix-launcher-helper.mjs:process.kill(-process.pid, signal)',
    ]);

    const containmentModule = readFileSync(
      join(workspaceSafetyRoot, 'posix-containment.ts'),
      'utf8',
    );
    expect(containmentModule).not.toMatch(
      /export\s+(?:async\s+)?function\s+(?:spawn|signal|terminate)PosixProcessGroup/gu,
    );
  });

  it('rejects caller-shaped PID/signal fields instead of turning them into a group signal', async () => {
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    if (decoy.pid === undefined) throw new Error('decoy pid is unavailable');
    const decoyPid = decoy.pid;
    const launcher = spawn(process.execPath, [launcherPath], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    });
    try {
      const messages: unknown[] = [];
      launcher.on('message', (message) => messages.push(message));
      launcher.send({
        schemaVersion: 1,
        type: 'CONFIG',
        target: {
          executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: '/',
          environment: [],
        },
      });
      const deadline = Date.now() + 3000;
      while (!messages.some((message) => (message as { type?: string }).type === 'BARRIER_READY')) {
        if (launcher.exitCode !== null || launcher.signalCode !== null || Date.now() >= deadline) {
          throw new Error('launcher did not reach its fixed barrier');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      launcher.send({
        schemaVersion: 1,
        type: 'SIGNAL_GROUP',
        mode: 'KILL',
        pid: decoyPid,
        identity: 'same-second-reuse-decoy',
        signal: 'SIGKILL',
      });
      const [code, signal] = (await once(launcher, 'exit')) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect(code).toBe(2);
      expect(signal).toBeNull();
      expect(() => process.kill(decoyPid, 0)).not.toThrow();
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) {
        launcher.kill('SIGKILL');
        await once(launcher, 'exit');
      }
      if (decoy.exitCode === null && decoy.signalCode === null) {
        process.kill(-decoyPid, 'SIGKILL');
        await once(decoy, 'exit');
      }
    }
  });
});

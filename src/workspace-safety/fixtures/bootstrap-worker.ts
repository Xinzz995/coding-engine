import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-authority-test-seam.js';
import type { ProcessIdentitySnapshot } from '../types.js';

const [, , workspacePath, ownerId, pidText] = process.argv;
if (!workspacePath || !ownerId || !pidText) {
  throw new Error('workspacePath, ownerId and pid are required');
}

const processIdentity: ProcessIdentitySnapshot['processIdentity'] =
  process.platform === 'darwin'
    ? { kind: 'macos-boot-start', value: 'Thu Jul 30 08:38:45 2026' }
    : process.platform === 'win32'
      ? { kind: 'windows-filetime', value: String(100_000 + Number(pidText)) }
      : { kind: 'linux-boot-start', value: String(100_000 + Number(pidText)) };

const identity: ProcessIdentitySnapshot = {
  pid: Number(pidText),
  processIdentity,
  bootIdentity: `sha256:${'a'.repeat(64)}`,
  hostId: `sha256:${'b'.repeat(64)}`,
};

process.stdout.write('READY\n');
process.stdin.setEncoding('utf8');
process.stdin.once('data', () => {
  void runBootstrap();
});

async function runBootstrap(): Promise<void> {
  try {
    const result = await bootstrapWorkspace({ workspacePath, ownerId, identity });
    process.stdout.write(`${JSON.stringify({ status: 'fulfilled', created: result.created })}\n`);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ status: 'rejected', code, message })}\n`);
  }
}

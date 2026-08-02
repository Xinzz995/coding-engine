import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  inlineCommonJsArguments,
  inlineModuleArguments,
  InlineProgramTransportError,
} from './inline-program.js';

function execute(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

describe('inline fixed program transport', () => {
  it('executes a CommonJS program larger than one supervisor argument', () => {
    const program = `${'// fixed source\n'.repeat(500)}process.stdout.write(process.argv[1]);`;
    const result = execute(inlineCommonJsArguments(program, 'payload-中文'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('payload-中文');
    expect(result.stderr).toBe('');
  });

  it('executes an ESM program larger than one supervisor argument', () => {
    const program = `${'// fixed source\n'.repeat(500)}import { createHash } from 'node:crypto'; process.stdout.write(createHash('sha256').update(process.argv[1]).digest('hex'));`;
    const result = execute(inlineModuleArguments(program, 'payload'));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.stderr).toBe('');
  });

  it('rejects a combined command line above the cross-platform reserve', () => {
    expect(() => inlineCommonJsArguments('x'.repeat(20_000), 'payload')).toThrow(
      InlineProgramTransportError,
    );
  });
});

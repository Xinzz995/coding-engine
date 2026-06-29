import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLoop } from './loop.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function setup(prdStories: unknown[]): { workspace: string; instructionsDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'loop-ws-'));
  const instructionsDir = mkdtempSync(join(tmpdir(), 'loop-ins-'));
  cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
  cleanup.push(() => rmSync(instructionsDir, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
    project: 'p', branchName: 'ralph/x', description: 'd', userStories: prdStories,
  }));
  writeFileSync(join(instructionsDir, 'builder.md'), 'build it');
  writeFileSync(join(instructionsDir, 'validator.md'), 'validate it');
  return { workspace, instructionsDir };
}

const story = (over: Record<string, unknown> = {}) => ({
  id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [],
  priority: 1, passes: false, notes: '', retryCount: 0, blocked: false, ...over,
});

describe('runLoop', () => {
  it('returns 0 when all stories are already resolved after one pass', async () => {
    // fake agent: developer pass marks the only story passes=true by rewriting prd.json
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      const p = ${JSON.stringify(join(workspace, 'prd.json'))};
      writeFileSync(p, JSON.stringify({ project:'p', branchName:'ralph/x', description:'d',
        userStories:[{ id:'US-001', title:'t', description:'d', acceptanceCriteria:[],
          priority:1, passes:true, notes:'', retryCount:0, blocked:false }] }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    expect(code).toBe(0);
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('returns 1 when stories never resolve within maxIterations', async () => {
    const { workspace, instructionsDir } = setup([story()]); // never flips to passes
    process.env.CODING_X_CLAUDE_BIN = `node -e process.exit(0)`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    expect(code).toBe(1);
    delete process.env.CODING_X_CLAUDE_BIN;
  });
});

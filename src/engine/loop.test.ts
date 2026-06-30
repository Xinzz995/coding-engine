import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
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

  it('spawns the agent at the project root, not inside the workspace dir', async () => {
    // Regression: runLoop used to pass cwd: cfg.workspace to runAgent, which made
    // the agent resolve `.workspace/prd.json` against `.workspace/` itself
    // (<root>/.workspace/.workspace/prd.json) — engine and agent never shared
    // state, passes:true was never observed, and the loop always hit maxIterations.
    // The engine itself reads prd.json at join(cfg.workspace, 'prd.json') which
    // resolves against the PROCESS cwd (= project root), so the agent must be
    // spawned at process.cwd() too. This fake records its own process.cwd() to a
    // marker file (absolute path) and flips the single story to passes:true so
    // the loop resolves and exits.
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-cwd.mjs');
    const marker = join(workspace, 'agent-cwd.txt');
    const prdPath = join(workspace, 'prd.json');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      const cwd = process.cwd();
      writeFileSync(${JSON.stringify(marker)}, cwd);
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify({ project:'p', branchName:'ralph/x', description:'d',
        userStories:[{ id:'US-001', title:'t', description:'d', acceptanceCriteria:[],
          priority:1, passes:true, notes:'', retryCount:0, blocked:false }] }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const recorded = readFileSync(marker, 'utf8');
      // The agent must run at the engine process's cwd (project root), NOT at the
      // temp workspace dir — otherwise the engine and agent diverge on prd.json.
      expect(recorded).toBe(process.cwd());
      expect(recorded).not.toBe(workspace);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

---
title: "coding-x Plugin + TS Rewrite Implementation Plan"
status: done
updated: 2026-07-06
scope: root
---

# coding-x Plugin + TS Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repackage the Ralph auto-coding harness as a Claude Code plugin and rewrite its Python engine in TypeScript, distributable as `npx coding-x`.

**Architecture:** A single repo that is BOTH an npm package (the TS engine + CLI in `src/` → `dist/`) and a Claude Code plugin (root `.claude-plugin/plugin.json` + generated `skills/`/`commands/`). All AI assets are hand-written once in `assets/` and generated into three tool dirs. Runtime state lives in `.workspace/`.

**Tech Stack:** Node.js (>=18), TypeScript (strict, ESM), tsx (dev), tsup (build), Vitest (test), jsonrepair (JSON repair).

## Global Constraints

- Package/CLI name is exactly `coding-x`; the binary is `coding-x`. "ralph" appears only inside skill/doc prose as a technique name, never as a command.
- Node.js `>=18`; `"type": "module"` (ESM); TS `strict: true`.
- All local imports use explicit `.js` extensions (ESM/NodeNext requirement), even though source files are `.ts`.
- Subprocesses use `child_process.spawn(..., { stdio: 'inherit' })`. Do NOT add `node-pty`.
- `jsonrepair` is a declared dependency — never `pip install` or install at runtime.
- Default timeouts: developer `30*60*1000` ms, validator `60*60*1000` ms, max iterations `50`, dashboard port `7331`.
- Runtime state dir defaults to `.workspace/` (contains `prd.json`, `progress.md`, `screenshots/`, `archive/`). It is gitignored.
- The three generated asset dirs (`skills/`+`commands/`, `.cursor/`, `.agents/`) ARE committed.
- prd.json story shape: `{ id, title, description, acceptanceCriteria: string[], priority: number, passes: boolean, notes: string, retryCount: number, blocked: boolean }`. prd.json root shape: `{ project, branchName, description, userStories: Story[] }`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsup.config.ts`
- Modify: `.gitignore`
- Create: `src/version.test.ts` (throwaway smoke test, deleted in Step 6)

**Interfaces:**
- Consumes: nothing.
- Produces: working `npm install` / `npm test` / `npm run build` toolchain for all later tasks.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "coding-x",
  "version": "0.1.0",
  "description": "Ralph auto-coding harness — Developer/Validator loop engine + Claude Code plugin",
  "type": "module",
  "bin": { "coding-x": "dist/cli.js" },
  "files": ["dist", "assets/instructions", "assets/dashboard"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "sync": "tsx build/sync-assets.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "jsonrepair": "^3.6.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsup": "^8.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "build"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `vitest.config.ts` and `tsup.config.ts`**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
    environment: 'node',
  },
});
```

`tsup.config.ts` (bundles the CLI and copies runtime assets into `dist/`):
```ts
import { defineConfig } from 'tsup';
import { cpSync, mkdirSync } from 'node:fs';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    mkdirSync('dist/instructions', { recursive: true });
    mkdirSync('dist/public', { recursive: true });
    cpSync('assets/instructions', 'dist/instructions', { recursive: true });
    cpSync('assets/dashboard', 'dist/public', { recursive: true });
  },
});
```

- [ ] **Step 4: Append to `.gitignore`**

Add these lines to the existing `.gitignore`:
```
# Node / coding-x
node_modules/
.workspace/
```
(`dist/` is already ignored by the existing file.)

- [ ] **Step 5: Write throwaway smoke test and verify toolchain**

`src/version.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `npm install && npm test`
Expected: install succeeds; 1 test passes.

- [ ] **Step 6: Delete smoke test and commit**

```bash
rm src/version.test.ts
git add package.json tsconfig.json vitest.config.ts tsup.config.ts .gitignore
git commit -m "chore: scaffold coding-x TypeScript project"
```

---

### Task 2: prd.ts — prd.json data layer

**Files:**
- Create: `src/engine/prd.ts`
- Test: `src/engine/prd.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Story { id: string; title: string; description: string; acceptanceCriteria: string[]; priority: number; passes: boolean; notes: string; retryCount: number; blocked: boolean }`
  - `interface Prd { project: string; branchName: string; description: string; userStories: Story[] }`
  - `tryReadPrd(path: string): Prd | null`
  - `getCurrentStoryId(prd: Prd): string | null`
  - `allStoriesResolved(prd: Prd): boolean`

- [ ] **Step 1: Write the failing test**

`src/engine/prd.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryReadPrd, getCurrentStoryId, allStoriesResolved, type Prd } from './prd.js';

function makePrd(stories: Array<Partial<Prd['userStories'][number]>>): Prd {
  return {
    project: 'p', branchName: 'ralph/x', description: 'd',
    userStories: stories.map((s, i) => ({
      id: s.id ?? `US-00${i + 1}`, title: 't', description: 'd',
      acceptanceCriteria: [], priority: s.priority ?? i + 1,
      passes: s.passes ?? false, notes: '', retryCount: 0, blocked: s.blocked ?? false,
    })),
  };
}

describe('getCurrentStoryId', () => {
  it('returns first not-passing, not-blocked story', () => {
    const prd = makePrd([{ passes: true }, { id: 'US-099', passes: false, blocked: false }]);
    expect(getCurrentStoryId(prd)).toBe('US-099');
  });
  it('skips blocked stories', () => {
    const prd = makePrd([{ passes: false, blocked: true }, { id: 'US-077' }]);
    expect(getCurrentStoryId(prd)).toBe('US-077');
  });
  it('returns null when all resolved', () => {
    const prd = makePrd([{ passes: true }, { blocked: true }]);
    expect(getCurrentStoryId(prd)).toBeNull();
  });
});

describe('allStoriesResolved', () => {
  it('true when every story passes or blocked', () => {
    expect(allStoriesResolved(makePrd([{ passes: true }, { blocked: true }]))).toBe(true);
  });
  it('false when one is open', () => {
    expect(allStoriesResolved(makePrd([{ passes: true }, { passes: false }]))).toBe(false);
  });
});

describe('tryReadPrd', () => {
  it('returns null for missing/invalid file', () => {
    expect(tryReadPrd('/no/such/file.json')).toBeNull();
  });
  it('parses a valid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, JSON.stringify(makePrd([{ id: 'US-001' }])));
    expect(tryReadPrd(file)?.userStories[0].id).toBe('US-001');
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/prd.test.ts`
Expected: FAIL — cannot find module `./prd.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/prd.ts`:
```ts
import { readFileSync } from 'node:fs';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  notes: string;
  retryCount: number;
  blocked: boolean;
}

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  userStories: Story[];
}

export function tryReadPrd(path: string): Prd | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Prd;
  } catch {
    return null;
  }
}

export function getCurrentStoryId(prd: Prd): string | null {
  for (const s of prd.userStories) {
    if (!s.passes && !s.blocked) return s.id;
  }
  return null;
}

export function allStoriesResolved(prd: Prd): boolean {
  return prd.userStories.every((s) => s.passes || s.blocked);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/prd.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/engine/prd.ts src/engine/prd.test.ts
git commit -m "feat: add prd.json data layer"
```

---

### Task 3: progress.ts — progress log reader

**Files:**
- Create: `src/engine/progress.ts`
- Test: `src/engine/progress.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `readProgress(path: string): string` (returns `''` if missing)
  - `extractLastStoryId(progressText: string): string | null`

- [ ] **Step 1: Write the failing test**

`src/engine/progress.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readProgress, extractLastStoryId } from './progress.js';

describe('readProgress', () => {
  it('returns empty string for a missing file', () => {
    expect(readProgress('/no/such/progress.md')).toBe('');
  });
});

describe('extractLastStoryId', () => {
  it('returns the story id from the last "## " section', () => {
    const text = [
      '## Codebase Patterns',
      '- foo',
      '## 2026-06-30 10:00 - US-001',
      '- did things',
      '## 2026-06-30 11:00 - US-002',
      '- more things',
    ].join('\n');
    expect(extractLastStoryId(text)).toBe('US-002');
  });
  it('returns null when no story id present', () => {
    expect(extractLastStoryId('## Codebase Patterns\n- foo')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/progress.test.ts`
Expected: FAIL — cannot find module `./progress.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/progress.ts`:
```ts
import { readFileSync } from 'node:fs';

export function readProgress(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

export function extractLastStoryId(progressText: string): string | null {
  let last: string | null = null;
  for (const line of progressText.split('\n')) {
    if (!line.startsWith('## ')) continue;
    const m = line.match(/(US-\d+)/);
    if (m) last = m[1];
  }
  return last;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/progress.ts src/engine/progress.test.ts
git commit -m "feat: add progress.md reader"
```

---

### Task 4: repair.ts — prd.json repair

**Files:**
- Create: `src/engine/repair.ts`
- Test: `src/engine/repair.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `repairJsonString(raw: string): string` (returns 2-space-indented valid JSON; throws if unrepairable)
  - `repairPrdFile(path: string): void` (repairs in place; throws and leaves file untouched on failure)

- [ ] **Step 1: Write the failing test**

`src/engine/repair.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repairJsonString, repairPrdFile } from './repair.js';

describe('repairJsonString', () => {
  it('fixes trailing commas and returns valid JSON', () => {
    const out = repairJsonString('{ "a": 1, "b": [1, 2,], }');
    expect(JSON.parse(out)).toEqual({ a: 1, b: [1, 2] });
  });
  it('preserves non-ASCII characters unescaped', () => {
    const out = repairJsonString('{ "project": "任务应用" }');
    expect(out).toContain('任务应用');
  });
});

describe('repairPrdFile', () => {
  it('rewrites the file in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, '{ "userStories": [], }');
    repairPrdFile(file);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ userStories: [] });
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/repair.test.ts`
Expected: FAIL — cannot find module `./repair.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/repair.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { jsonrepair } from 'jsonrepair';

export function repairJsonString(raw: string): string {
  const repaired = jsonrepair(raw);
  const parsed = JSON.parse(repaired); // second validation pass
  return JSON.stringify(parsed, null, 2);
}

export function repairPrdFile(path: string): void {
  const raw = readFileSync(path, 'utf-8');
  const repaired = repairJsonString(raw); // throws before any write if unrepairable
  writeFileSync(path, repaired, 'utf-8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/repair.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/repair.ts src/engine/repair.test.ts
git commit -m "feat: add prd.json repair via jsonrepair"
```

---

### Task 5: agent.ts — subprocess runner

**Files:**
- Create: `src/engine/agent.ts`
- Create: `src/engine/__fixtures__/fake-agent.mjs` (stub binary for tests)
- Test: `src/engine/agent.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type AgentKind = 'claude' | 'codex'`
  - `resolveBinary(kind: AgentKind): string` (honors `CODING_X_CLAUDE_BIN` / `CODING_X_CODEX_BIN` env overrides)
  - `buildAgentArgs(kind: AgentKind, prompt: string): string[]` (full argv incl. binary)
  - `interface RunResult { timedOut: boolean; exitCode: number | null }`
  - `runAgent(opts: { kind: AgentKind; prompt: string; cwd: string; timeoutMs: number }): Promise<RunResult>`

- [ ] **Step 1: Write the failing test**

`src/engine/__fixtures__/fake-agent.mjs`:
```js
// Stub agent. Behavior controlled by argv:
//   node fake-agent.mjs ok       -> exits 0 immediately
//   node fake-agent.mjs hang     -> never exits (until killed)
const mode = process.argv[2];
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
```

`src/engine/agent.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAgentArgs, resolveBinary, runAgent } from './agent.js';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, '__fixtures__', 'fake-agent.mjs');

describe('buildAgentArgs', () => {
  it('builds claude print command by default', () => {
    expect(buildAgentArgs('claude', 'P')).toEqual([
      'claude', '--print', '--dangerously-skip-permissions', 'P',
    ]);
  });
  it('builds codex exec command', () => {
    expect(buildAgentArgs('codex', 'P')).toEqual([
      'codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', 'P',
    ]);
  });
});

describe('resolveBinary', () => {
  it('honors env override', () => {
    process.env.CODING_X_CLAUDE_BIN = '/tmp/x';
    expect(resolveBinary('claude')).toBe('/tmp/x');
    delete process.env.CODING_X_CLAUDE_BIN;
  });
});

describe('runAgent', () => {
  it('resolves timedOut=false when the process exits in time', async () => {
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} ok`;
    const r = await runAgent({ kind: 'claude', prompt: '', cwd: here, timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('resolves timedOut=true and kills a hanging process', async () => {
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} hang`;
    const r = await runAgent({ kind: 'claude', prompt: '', cwd: here, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    delete process.env.CODING_X_CLAUDE_BIN;
  });
});
```

Note: the env override may contain a binary + args (e.g. `node /path ok`). `resolveBinary` returns the whole string; `runAgent` splits it on spaces and prepends to the built tail so the stub receives its mode arg. See implementation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/agent.test.ts`
Expected: FAIL — cannot find module `./agent.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/agent.ts`:
```ts
import { spawn } from 'node:child_process';

export type AgentKind = 'claude' | 'codex';

export function resolveBinary(kind: AgentKind): string {
  if (kind === 'codex') return process.env.CODING_X_CODEX_BIN ?? 'codex';
  return process.env.CODING_X_CLAUDE_BIN ?? 'claude';
}

export function buildAgentArgs(kind: AgentKind, prompt: string): string[] {
  const bin = resolveBinary(kind);
  if (kind === 'codex') {
    return [bin, 'exec', '--dangerously-bypass-approvals-and-sandbox', prompt];
  }
  return [bin, '--print', '--dangerously-skip-permissions', prompt];
}

export interface RunResult {
  timedOut: boolean;
  exitCode: number | null;
}

export function runAgent(opts: {
  kind: AgentKind;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}): Promise<RunResult> {
  // buildAgentArgs()[0] may itself be "node /path mode" when overridden by an
  // env var in tests; split it so the stub receives its trailing args.
  const argv = buildAgentArgs(opts.kind, opts.prompt);
  const head = argv[0].split(' ');
  const cmd = head[0];
  const args = [...head.slice(1), ...argv.slice(1)];

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit' });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => clearTimeout(killTimer));
      resolve({ timedOut: true, exitCode: null });
    }, opts.timeoutMs);

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, exitCode: code });
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`\n❌ Agent 错误: ${err.message}`);
      resolve({ timedOut: false, exitCode: 1 });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/agent.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/engine/agent.ts src/engine/agent.test.ts src/engine/__fixtures__/fake-agent.mjs
git commit -m "feat: add event-driven subprocess agent runner"
```

---

### Task 6: dashboard/server.ts — monitoring server

**Files:**
- Create: `src/dashboard/server.ts`
- Test: `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: `tryReadPrd` from `../engine/prd.js`, `readProgress` from `../engine/progress.js`.
- Produces:
  - `type Phase = 'idle' | 'developing' | 'validating' | 'done' | 'error'`
  - `setState(patch: { iteration?: number; phase?: Phase; currentStory?: string | null }): void`
  - `buildApiResponse(): ApiResponse` (exported for tests)
  - `start(opts: { workspace: string; maxIterations: number; port?: number; publicDir?: string; openBrowser?: boolean }): { close(): void }`
  - `interface ApiResponse { runtime: { iteration: number; max_iterations: number; phase: Phase; current_story: string | null; elapsed: number }; project: string; branchName: string; stories: unknown[]; logs: string }`

- [ ] **Step 1: Write the failing test**

`src/dashboard/server.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setState, buildApiResponse, start, configureWorkspace } from './server.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({
    project: '任务应用', branchName: 'ralph/x', description: 'd',
    userStories: [{ id: 'US-001', passes: false }],
  }));
  writeFileSync(join(dir, 'progress.md'), '## US-001\n- done');
  return dir;
}

describe('buildApiResponse', () => {
  it('reflects state + workspace files', () => {
    const ws = tempWorkspace();
    configureWorkspace(ws, 50);
    setState({ iteration: 3, phase: 'validating', currentStory: 'US-001' });
    const r = buildApiResponse();
    expect(r.runtime.iteration).toBe(3);
    expect(r.runtime.phase).toBe('validating');
    expect(r.project).toBe('任务应用');
    expect(r.branchName).toBe('ralph/x');
    expect(r.stories.length).toBe(1);
    expect(r.logs).toContain('US-001');
  });
});

describe('start', () => {
  it('serves /api/state as JSON', async () => {
    const ws = tempWorkspace();
    const pub = mkdtempSync(join(tmpdir(), 'pub-'));
    cleanup.push(() => rmSync(pub, { recursive: true, force: true }));
    mkdirSync(pub, { recursive: true });
    writeFileSync(join(pub, 'dashboard.html'), '<html>main</html>');
    writeFileSync(join(pub, 'dashboard-p.html'), '<html>pixel</html>');

    const srv = start({ workspace: ws, maxIterations: 50, port: 0, publicDir: pub, openBrowser: false });
    cleanup.push(() => srv.close());
    const addr = srv.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/state`);
    const body = await res.json();
    expect(body.runtime.max_iterations).toBe(50);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
```

Note: `start` must expose `address()` for the test (return the underlying server). Adjust the produced interface accordingly: `start(...)` returns `{ close(): void; address(): { port: number } }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: FAIL — cannot find module `./server.js`.

- [ ] **Step 3: Write minimal implementation**

`src/dashboard/server.ts`:
```ts
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryReadPrd } from '../engine/prd.js';
import { readProgress } from '../engine/progress.js';

export type Phase = 'idle' | 'developing' | 'validating' | 'done' | 'error';

interface State {
  iteration: number;
  maxIterations: number;
  phase: Phase;
  currentStory: string | null;
  startedAt: number | null;
}

const state: State = {
  iteration: 0, maxIterations: 50, phase: 'idle', currentStory: null, startedAt: null,
};
let workspaceDir = '.workspace';

export function configureWorkspace(workspace: string, maxIterations: number): void {
  workspaceDir = workspace;
  state.maxIterations = maxIterations;
  state.startedAt = Date.now();
}

export function setState(patch: {
  iteration?: number; phase?: Phase; currentStory?: string | null;
}): void {
  if (patch.iteration !== undefined) state.iteration = patch.iteration;
  if (patch.phase !== undefined) state.phase = patch.phase;
  if (patch.currentStory !== undefined) state.currentStory = patch.currentStory;
}

export interface ApiResponse {
  runtime: {
    iteration: number; max_iterations: number; phase: Phase;
    current_story: string | null; elapsed: number;
  };
  project: string;
  branchName: string;
  stories: unknown[];
  logs: string;
}

export function buildApiResponse(): ApiResponse {
  const elapsed = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  const prd = tryReadPrd(join(workspaceDir, 'prd.json'));
  const logs = readProgress(join(workspaceDir, 'progress.md'));
  return {
    runtime: {
      iteration: state.iteration,
      max_iterations: state.maxIterations,
      phase: state.phase,
      current_story: state.currentStory,
      elapsed,
    },
    project: prd?.project ?? '',
    branchName: prd?.branchName ?? '',
    stories: prd?.userStories ?? [],
    logs,
  };
}

function defaultPublicDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'public');
}

export function start(opts: {
  workspace: string;
  maxIterations: number;
  port?: number;
  publicDir?: string;
  openBrowser?: boolean;
}): { close(): void; address(): { port: number } } {
  configureWorkspace(opts.workspace, opts.maxIterations);
  const publicDir = opts.publicDir ?? defaultPublicDir();
  const port = opts.port ?? 7331;

  const serveHtml = (server: Server, res: import('node:http').ServerResponse, file: string) => {
    try {
      const html = readFileSync(join(publicDir, file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/api/state') {
      const body = JSON.stringify(buildApiResponse());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    } else if (path === '/' || path === '/index.html') {
      serveHtml(server, res, 'dashboard.html');
    } else if (path === '/p' || path === '/p.html') {
      serveHtml(server, res, 'dashboard-p.html');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, '127.0.0.1');

  return {
    close: () => server.close(),
    address: () => server.address() as { port: number },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat: add TS dashboard server"
```

---

### Task 7: loop.ts — Developer/Validator orchestration

**Files:**
- Create: `src/engine/loop.ts`
- Test: `src/engine/loop.test.ts`

**Interfaces:**
- Consumes: `runAgent` (`./agent.js`), `tryReadPrd`/`getCurrentStoryId`/`allStoriesResolved` (`./prd.js`), `start`/`setState` (`../dashboard/server.js`).
- Produces:
  - `interface LoopConfig { kind: AgentKind; maxIterations: number; devTimeoutMs: number; valTimeoutMs: number; workspace: string; instructionsDir: string; port?: number; openBrowser?: boolean }`
  - `runLoop(cfg: LoopConfig): Promise<number>` (resolves with exit code: 0 = all resolved, 1 = hit max iterations)

- [ ] **Step 1: Write the failing test**

`src/engine/loop.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: FAIL — cannot find module `./loop.js`.

- [ ] **Step 3: Write minimal implementation**

`src/engine/loop.ts`:
```ts
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { runAgent, type AgentKind } from './agent.js';
import { tryReadPrd, getCurrentStoryId, allStoriesResolved } from './prd.js';
import * as dashboard from '../dashboard/server.js';

export interface LoopConfig {
  kind: AgentKind;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  workspace: string;
  instructionsDir: string;
  port?: number;
  openBrowser?: boolean;
}

function readInstruction(dir: string, file: string): string | null {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

export async function runLoop(cfg: LoopConfig): Promise<number> {
  const prdPath = join(cfg.workspace, 'prd.json');
  const builder = readInstruction(cfg.instructionsDir, 'builder.md');
  const validator = readInstruction(cfg.instructionsDir, 'validator.md');

  const server = dashboard.start({
    workspace: cfg.workspace,
    maxIterations: cfg.maxIterations,
    port: cfg.port,
    openBrowser: cfg.openBrowser ?? true,
  });

  try {
    for (let i = 1; i <= cfg.maxIterations; i++) {
      const before = tryReadPrd(prdPath);
      const currentStory = before ? getCurrentStoryId(before) : null;
      dashboard.setState({ iteration: i, phase: 'developing', currentStory });

      // Developer
      if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else {
        const dev = await runAgent({
          kind: cfg.kind, prompt: builder, cwd: cfg.workspace, timeoutMs: cfg.devTimeoutMs,
        });
        if (dev.timedOut) {
          dashboard.setState({ phase: 'idle' });
          continue; // skip validator, retry next iteration
        }
      }

      // Validator
      dashboard.setState({ phase: 'validating' });
      if (validator) {
        await runAgent({
          kind: cfg.kind, prompt: validator, cwd: cfg.workspace, timeoutMs: cfg.valTimeoutMs,
        });
      }

      // Completion check
      dashboard.setState({ phase: 'idle' });
      const after = tryReadPrd(prdPath);
      if (after && allStoriesResolved(after)) {
        dashboard.setState({ phase: 'done' });
        return 0;
      }
    }
    return 1;
  } finally {
    server.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: add Developer/Validator orchestration loop"
```

---

### Task 8: cli.ts — entry point

**Files:**
- Create: `src/cli.ts`
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: `runLoop` (`./engine/loop.js`), `repairPrdFile` (`./engine/repair.js`).
- Produces:
  - `parseCliArgs(argv: string[]): { command: 'run' | 'repair'; kind: AgentKind; maxIterations: number; devTimeoutMs: number; valTimeoutMs: number; workspace: string; openBrowser: boolean }`
  - `permissionWarning(kind: AgentKind): string`
  - `main(argv: string[]): Promise<number>` (not unit-tested directly; smoke via `parseCliArgs`)

- [ ] **Step 1: Write the failing test**

`src/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseCliArgs, permissionWarning } from './cli.js';

describe('parseCliArgs', () => {
  it('defaults to claude run with standard timeouts', () => {
    const c = parseCliArgs([]);
    expect(c.command).toBe('run');
    expect(c.kind).toBe('claude');
    expect(c.maxIterations).toBe(50);
    expect(c.devTimeoutMs).toBe(30 * 60 * 1000);
    expect(c.valTimeoutMs).toBe(60 * 60 * 1000);
    expect(c.openBrowser).toBe(true);
  });
  it('parses codex positional and flag overrides', () => {
    const c = parseCliArgs(['codex', '--max-iter', '3', '--dev-timeout', '10', '--no-open']);
    expect(c.kind).toBe('codex');
    expect(c.maxIterations).toBe(3);
    expect(c.devTimeoutMs).toBe(10 * 60 * 1000);
    expect(c.openBrowser).toBe(false);
  });
  it('recognizes the repair subcommand', () => {
    expect(parseCliArgs(['repair']).command).toBe('repair');
  });
});

describe('permissionWarning', () => {
  it('mentions skip-permissions for claude', () => {
    expect(permissionWarning('claude')).toMatch(/--dangerously-skip-permissions/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli.test.ts`
Expected: FAIL — cannot find module `./cli.js`.

- [ ] **Step 3: Write minimal implementation**

`src/cli.ts`:
```ts
import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoop } from './engine/loop.js';
import { repairPrdFile } from './engine/repair.js';
import type { AgentKind } from './engine/agent.js';

export interface CliConfig {
  command: 'run' | 'repair';
  kind: AgentKind;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  workspace: string;
  openBrowser: boolean;
}

export function parseCliArgs(argv: string[]): CliConfig {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'max-iter': { type: 'string' },
      'dev-timeout': { type: 'string' },
      'val-timeout': { type: 'string' },
      workspace: { type: 'string' },
      'no-open': { type: 'boolean' },
    },
  });

  const first = positionals[0];
  const command: 'run' | 'repair' = first === 'repair' ? 'repair' : 'run';
  const kind: AgentKind = first === 'codex' ? 'codex' : 'claude';
  const min = (s: string | undefined, d: number) => (s ? Number(s) : d) * 60 * 1000;

  return {
    command,
    kind,
    maxIterations: values['max-iter'] ? Number(values['max-iter']) : 50,
    devTimeoutMs: min(values['dev-timeout'], 30),
    valTimeoutMs: min(values['val-timeout'], 60),
    workspace: values.workspace ?? '.workspace',
    openBrowser: !values['no-open'],
  };
}

export function permissionWarning(kind: AgentKind): string {
  const flag = kind === 'codex'
    ? '--dangerously-bypass-approvals-and-sandbox'
    : '--dangerously-skip-permissions';
  return [
    '',
    '⚠️  coding-x 将以【跳过权限】模式自动运行 AI agent：',
    `   使用 ${kind} ${flag}`,
    '   它会在无人确认的情况下读写文件、执行命令、提交代码。',
    '   请确认当前目录是你信任的项目工作区。',
    '',
  ].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const cfg = parseCliArgs(argv);

  if (cfg.command === 'repair') {
    repairPrdFile(join(cfg.workspace, 'prd.json'));
    console.log('✅ prd.json 已修复');
    return 0;
  }

  console.warn(permissionWarning(cfg.kind));

  const instructionsDir = join(dirname(fileURLToPath(import.meta.url)), 'instructions');
  return runLoop({
    kind: cfg.kind,
    maxIterations: cfg.maxIterations,
    devTimeoutMs: cfg.devTimeoutMs,
    valTimeoutMs: cfg.valTimeoutMs,
    workspace: cfg.workspace,
    instructionsDir,
    openBrowser: cfg.openBrowser,
  });
}

// Entry: run when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: add coding-x CLI entry with arg parsing and permission warning"
```

---

### Task 9: Migrate AI assets into `assets/` (single source)

**Files:**
- Create: `assets/instructions/builder.md` (from `scripts/ralph/CLAUDE.md`, stop-marker section removed)
- Create: `assets/instructions/validator.md` (from `scripts/ralph/VALIDATOR.md`)
- Create: `assets/skills/prd/SKILL.md`, `assets/skills/ralph/SKILL.md`, `assets/skills/agent-browser/SKILL.md` (from `.claude/skills/...`)
- Create: `assets/commands/prime.md`, `assets/commands/plan-feature.md`, `assets/commands/create-rules.md` (from `.claude/commands/...`)
- Create: `assets/dashboard/dashboard.html`, `assets/dashboard/dashboard-p.html` (from `scripts/ralph/...`)
- Delete (after copy): `scripts/ralph/` Python files and old `.cursor/`, `.agents/`, `.claude/` source copies are handled in Task 10/11; in THIS task only populate `assets/`.

**Interfaces:**
- Consumes: existing repo files.
- Produces: the canonical `assets/` tree consumed by Task 10's generator and Task 1's tsup asset copy.

- [ ] **Step 1: Copy instruction + skill + command + dashboard sources into `assets/`**

```bash
mkdir -p assets/instructions assets/skills assets/commands assets/dashboard
cp scripts/ralph/CLAUDE.md assets/instructions/builder.md
cp scripts/ralph/VALIDATOR.md assets/instructions/validator.md
cp -R .claude/skills/prd assets/skills/prd
cp -R .claude/skills/ralph assets/skills/ralph
cp -R ".claude/skills/agent-browser-skill" assets/skills/agent-browser
cp .claude/commands/prime.md assets/commands/prime.md
cp .claude/commands/plan-feature.md assets/commands/plan-feature.md
cp .claude/commands/create-rules.md assets/commands/create-rules.md
cp scripts/ralph/dashboard.html assets/dashboard/dashboard.html
cp scripts/ralph/dashboard-p.html assets/dashboard/dashboard-p.html
```

- [ ] **Step 2: Remove the dead stop-marker section from `builder.md`**

In `assets/instructions/builder.md`, delete the entire `## 停止条件` section — every line from the `## 停止条件` heading up to (but not including) the next `## 重要提示` heading. This removes the `<promise>COMPLETE</promise>` instructions (the engine never reads stdout; completion is determined solely by `prd.json` via `allStoriesResolved`).

Verify the marker is gone:
Run: `grep -c "promise" assets/instructions/builder.md`
Expected: `0`

- [ ] **Step 3: Update file/path references inside `builder.md` and `validator.md`**

Replace stale paths so the instructions match the new layout:
- `scripts/ralph/progress.txt` → `.workspace/progress.md` (and any `progress.txt` → `progress.md`)
- `scripts/ralph/prd.json` → `.workspace/prd.json`
- references to "在 scripts/ralph 下" → "在 .workspace/ 下"

Run: `grep -rn "progress.txt\|scripts/ralph" assets/instructions/`
Expected: no matches.

- [ ] **Step 4: Update the `ralph` skill's repair instruction**

In `assets/skills/ralph/SKILL.md`, replace the Python repair step (the `python3 .claude/skills/ralph/scripts/repair_prd_json.py` block and surrounding "JSON 自动修复" instructions) with the new engine command:
```
写入 prd.json 后运行：`npx coding-x repair`（引擎会用 jsonrepair 修复并二次校验）。
```
Also update the save path note from `scripts/ralph/prd.json` to `.workspace/prd.json`. Delete the now-obsolete `assets/skills/ralph/scripts/` directory if it was copied:
```bash
rm -rf assets/skills/ralph/scripts
```

- [ ] **Step 5: Commit**

```bash
git add assets
git commit -m "refactor: establish assets/ as single source for AI assets; drop dead stop-marker"
```

---

### Task 10: build/sync-assets.ts — multi-tool generator

**Files:**
- Create: `build/sync-assets.ts`
- Test: `build/sync-assets.test.ts`

**Interfaces:**
- Consumes: the `assets/` tree from Task 9.
- Produces:
  - `syncAssets(opts: { sourceDir: string; targets: TargetSpec[] }): void`
  - `interface TargetSpec { dir: string; skillsSubdir: string; commandsSubdir: string }`
  - Generates root `skills/`+`commands/` (Claude) and `.cursor/`, `.agents/` copies.

- [ ] **Step 1: Write the failing test**

`build/sync-assets.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncAssets } from './sync-assets.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function fixtureSource(): string {
  const src = mkdtempSync(join(tmpdir(), 'src-'));
  cleanup.push(() => rmSync(src, { recursive: true, force: true }));
  mkdirSync(join(src, 'skills', 'prd'), { recursive: true });
  mkdirSync(join(src, 'commands'), { recursive: true });
  writeFileSync(join(src, 'skills', 'prd', 'SKILL.md'), '---\nname: prd\n---\nbody');
  writeFileSync(join(src, 'commands', 'prime.md'), '# prime');
  return src;
}

describe('syncAssets', () => {
  it('generates skills and commands into each target', () => {
    const src = fixtureSource();
    const out = mkdtempSync(join(tmpdir(), 'out-'));
    cleanup.push(() => rmSync(out, { recursive: true, force: true }));
    const target = { dir: out, skillsSubdir: 'skills', commandsSubdir: 'commands' };

    syncAssets({ sourceDir: src, targets: [target] });

    expect(existsSync(join(out, 'skills', 'prd', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(out, 'commands', 'prime.md'), 'utf-8')).toBe('# prime');
  });

  it('is idempotent (second run yields identical output)', () => {
    const src = fixtureSource();
    const out = mkdtempSync(join(tmpdir(), 'out2-'));
    cleanup.push(() => rmSync(out, { recursive: true, force: true }));
    const target = { dir: out, skillsSubdir: 'skills', commandsSubdir: 'commands' };
    syncAssets({ sourceDir: src, targets: [target] });
    const first = readFileSync(join(out, 'skills', 'prd', 'SKILL.md'), 'utf-8');
    syncAssets({ sourceDir: src, targets: [target] });
    const second = readFileSync(join(out, 'skills', 'prd', 'SKILL.md'), 'utf-8');
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run build/sync-assets.test.ts`
Expected: FAIL — cannot find module `./sync-assets.js`.

- [ ] **Step 3: Write minimal implementation**

`build/sync-assets.ts`:
```ts
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TargetSpec {
  dir: string;
  skillsSubdir: string;
  commandsSubdir: string;
}

export function syncAssets(opts: { sourceDir: string; targets: TargetSpec[] }): void {
  const skillsSrc = join(opts.sourceDir, 'skills');
  const commandsSrc = join(opts.sourceDir, 'commands');

  for (const t of opts.targets) {
    const skillsOut = join(t.dir, t.skillsSubdir);
    const commandsOut = join(t.dir, t.commandsSubdir);
    rmSync(skillsOut, { recursive: true, force: true });
    rmSync(commandsOut, { recursive: true, force: true });
    mkdirSync(t.dir, { recursive: true });
    if (existsSync(skillsSrc)) cpSync(skillsSrc, skillsOut, { recursive: true });
    if (existsSync(commandsSrc)) cpSync(commandsSrc, commandsOut, { recursive: true });
  }
}

// CLI usage: `tsx build/sync-assets.ts` generates the three committed tool dirs
// from the repo's assets/ source.
if (process.argv[1]?.endsWith('sync-assets.ts')) {
  const root = process.cwd();
  syncAssets({
    sourceDir: join(root, 'assets'),
    targets: [
      { dir: root, skillsSubdir: 'skills', commandsSubdir: 'commands' },          // Claude (plugin root)
      { dir: join(root, '.cursor'), skillsSubdir: 'skills', commandsSubdir: 'commands' },
      { dir: join(root, '.agents'), skillsSubdir: 'skills', commandsSubdir: 'commands' },
    ],
  });
  console.log('✅ 已从 assets/ 生成 skills/ commands/ .cursor/ .agents/');
}
```

Note on frontmatter: the three tools currently use the same SKILL.md frontmatter, so a plain copy is correct today. If a tool later needs different frontmatter, extend `TargetSpec` with a transform hook — do NOT add one now (YAGNI).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run build/sync-assets.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Regenerate the committed tool dirs and replace the old ones**

```bash
rm -rf .cursor .agents skills commands
npx tsx build/sync-assets.ts
```
Run: `ls skills .cursor/skills .agents/skills`
Expected: each contains `prd/ ralph/ agent-browser/`.

- [ ] **Step 6: Commit**

```bash
git add build/sync-assets.ts build/sync-assets.test.ts skills commands .cursor .agents
git commit -m "feat: generate skills/commands for claude/cursor/agents from assets/"
```

---

### Task 11: Plugin manifest, cleanup, build verification, docs

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Delete: `scripts/ralph/` (Python engine, now replaced)
- Delete: old `.claude/AGENTS-template.md` duplication left under `.claude/` if now redundant (keep `.claude/settings.local.json`)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: an installable plugin manifest + a clean repo + verified `npm run build` output.

- [ ] **Step 1: Create the plugin manifest**

`.claude-plugin/plugin.json`:
```json
{
  "name": "coding-x",
  "version": "0.1.0",
  "description": "Ralph auto-coding workflow: prd/ralph/agent-browser skills + prime/plan-feature/create-rules commands. Run the engine via `npx coding-x`.",
  "author": "Xinzz",
  "commands": "./commands",
  "skills": "./skills"
}
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "coding-x-marketplace",
  "owner": "Xinzz",
  "plugins": [
    { "name": "coding-x", "source": ".", "description": "Ralph auto-coding workflow + TS engine" }
  ]
}
```

- [ ] **Step 2: Remove the obsolete Python engine**

```bash
git rm -r scripts/ralph
```
(The engine is now `src/` → `dist/`; the dashboard HTML lives in `assets/dashboard/`.)

Run: `grep -rn "ralph.py\|dashboard.py\|repair_prd_json.py" . --include=*.md --include=*.json | grep -v docs/superpowers`
Expected: no matches in active assets (only historical references in committed specs/plans under docs/ are acceptable).

- [ ] **Step 3: Update README**

`README.md`:
```markdown
# coding-x

Ralph 自动化 Coding 工作流：一个把 Developer→Validator 循环固化成确定性程序的 harness。
既是 Claude Code 插件（skills/commands），又是 TypeScript 引擎（`npx coding-x`）。

## 用法

1. 安装插件后，用 `/prime` `/plan-feature`，配合 `prd` / `ralph` skill 生成 `.workspace/prd.json`。
2. 终端运行引擎：

   ```bash
   npx coding-x            # 使用 claude
   npx coding-x codex      # 使用 codex
   npx coding-x --max-iter 20 --dev-timeout 20 --no-open
   npx coding-x repair     # 仅修复 .workspace/prd.json
   ```

3. 打开 http://localhost:7331 （像素视图 http://localhost:7331/p ）查看实时进度。

## 开发

- `npm run dev` — 直接用 tsx 运行 CLI
- `npm test` — Vitest
- `npm run sync` — 从 `assets/` 重新生成 `skills/ commands/ .cursor/ .agents/`
- `npm run build` — tsup 打包到 `dist/`

技法来源：Ralph 自主循环 + Anthropic harness 设计。详见 `docs/superpowers/specs/`。
```

- [ ] **Step 4: Verify the full build and bin wiring**

Run: `npm run build`
Expected: `dist/cli.js` exists with shebang; `dist/instructions/builder.md`, `dist/instructions/validator.md`, `dist/public/dashboard.html`, `dist/public/dashboard-p.html` all copied.

Run: `node dist/cli.js --help` is not implemented; instead verify repair path on a sample:
```bash
mkdir -p /tmp/cx && echo '{ "userStories": [], }' > /tmp/cx/prd.json
node dist/cli.js repair --workspace /tmp/cx && cat /tmp/cx/prd.json
```
Expected: prints `✅ prd.json 已修复`; file becomes valid `{ "userStories": [] }`.

- [ ] **Step 5: Run full suite + typecheck one final time**

Run: `npm test && npm run typecheck`
Expected: all tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin README.md
git rm -r --cached scripts/ralph 2>/dev/null || true
git commit -m "feat: add Claude Code plugin manifest; remove Python engine; update docs"
```

---

## Self-Review Notes

- **Spec coverage:** §2 naming → Tasks 9/11 (renames, builder.md, .workspace); §3 structure → Tasks 1/9/10/11; §4 runtime → Task 1 (Node/tsup/jsonrepair), Task 5 (stdio:'inherit'); §5 modules → Tasks 2–7; §6 UX → Tasks 8/11 (CLI + README); §7 defects ①→Task 9 Step 2, ②→Task 4, ③→Task 5 (event-driven), ④→Task 8 (flags), ⑤→Task 8 (permissionWarning); §8 tests → every module task has tests; single-source generation → Task 10.
- **Type consistency:** `Story`/`Prd` shapes are consistent across prd.ts, loop.ts, dashboard. `runAgent`/`RunResult`, `LoopConfig`, `CliConfig`, `TargetSpec` names match between producing and consuming tasks.
- **Note:** `extractLastStoryId` (Task 3) is not consumed by the engine loop (the Validator agent locates the story via its prompt); it is retained as a tested utility for potential dashboard enrichment and matches the approved test strategy. If unused after Task 11, it may be dropped during execution.

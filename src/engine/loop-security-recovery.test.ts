import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUARANTINE_FILE } from '../workspace-safety/quarantine.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from '../workspace-safety/types.js';
import { readEvidence } from './evidence.js';
import { runLoop } from './loop.js';
import { setup, story, strictConfig } from './loop-test-support.js';

interface PrdViolationScenario {
  readonly name: string;
  readonly prdExtra?: Record<string, unknown>;
  readonly source: (input: { readonly prdPath: string; readonly statePath: string }) => string;
}

const scenarios: readonly PrdViolationScenario[] = [
  {
    name: 'builder 删除 qualityChecks 时在门禁前隔离，不能把检查架空',
    source: ({ prdPath }) => `
      import { readFileSync, writeFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf8'));
      delete prd.qualityChecks;
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(0);
    `,
  },
  {
    name: 'builder 改弱验收标准并同时翻绿时隔离，不会启动 Validator',
    source: ({ prdPath, statePath }) => `
      import { readFileSync, writeFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf8'));
      prd.userStories[0].acceptanceCriteria = ['被改弱的标准'];
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
      state['US-001'].passes = true;
      writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
      process.exit(0);
    `,
  },
  {
    name: 'builder 删除 PRD story 时隔离，不能欺骗完成判定',
    source: ({ prdPath }) => `
      import { readFileSync, writeFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf8'));
      prd.userStories = [];
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(0);
    `,
  },
  {
    name: 'builder 用目录替换 PRD 时隔离且不写报告，取代旧式快照报告路径',
    source: ({ prdPath }) => `
      import { mkdirSync, unlinkSync } from 'node:fs';
      unlinkSync(${JSON.stringify(prdPath)});
      mkdirSync(${JSON.stringify(prdPath)});
      process.exit(0);
    `,
  },
  {
    name: 'builder 翻绿后再用目录替换 PRD 时隔离，不保留普通轮次结论',
    source: ({ prdPath, statePath }) => `
      import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
      state['US-001'].passes = true;
      writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
      unlinkSync(${JSON.stringify(prdPath)});
      mkdirSync(${JSON.stringify(prdPath)});
      process.exit(0);
    `,
  },
  {
    name: '终轮 builder 异常退出且篡改 PRD 时仍隔离并保留现场',
    source: ({ prdPath }) => `
      import { readFileSync, writeFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf8'));
      prd.project = 'evil-final-round';
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(1);
    `,
  },
  {
    name: '终轮 no-op 且篡改 PRD 时仍隔离并保留现场',
    source: ({ prdPath }) => `
      import { readFileSync, writeFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf8'));
      prd.project = 'evil-final-noop';
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(0);
    `,
  },
  ...(process.platform === 'win32'
    ? []
    : [
        {
          name: 'builder 用 FIFO 替换 PRD 时立即失败关闭而不等待写端',
          source: ({ prdPath }: { readonly prdPath: string }) => `
            import { unlinkSync } from 'node:fs';
            import { spawnSync } from 'node:child_process';
            unlinkSync(${JSON.stringify(prdPath)});
            const made = spawnSync('mkfifo', [${JSON.stringify(prdPath)}]);
            process.exit(made.status === 0 ? 0 : 7);
          `,
        },
        {
          name: 'builder 用 FIFO 替换 state 时立即失败关闭而不等待写端',
          source: ({ statePath }: { readonly statePath: string }) => `
            import { unlinkSync } from 'node:fs';
            import { spawnSync } from 'node:child_process';
            unlinkSync(${JSON.stringify(statePath)});
            const made = spawnSync('mkfifo', [${JSON.stringify(statePath)}]);
            process.exit(made.status === 0 ? 0 : 7);
          `,
        },
      ]),
];

describe('runLoop PRD delegation boundary', () => {
  it.each(scenarios)(
    '$name',
    async ({ prdExtra, source }) => {
      const { workspace, instructionsDir } = setup(
        [story({ acceptanceCriteria: ['原始验收标准'] })],
        prdExtra,
      );
      const fake = join(workspace, 'fake-prd-violation.mjs');
      writeFileSync(
        fake,
        source({
          prdPath: join(workspace, 'prd.json'),
          statePath: join(workspace, 'state.json'),
        }),
      );
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errors.push(args.join(' '));

      try {
        expect(
          await runLoop({
            ...strictConfig(workspace, instructionsDir),
            maxIterations: 1,
          }),
        ).toBe(2);

        const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
        expect(existsSync(join(operation, QUARANTINE_FILE))).toBe(true);
        expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
        expect(existsSync(join(workspace, 'report.html'))).toBe(false);
        expect(errors.some((line) => line.includes('workspace 安全执行失败'))).toBe(true);
        expect(readEvidence(workspace).records.some((record) => record.type === 'iteration')).toBe(
          false,
        );
      } finally {
        console.error = originalError;
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    20_000,
  );
});

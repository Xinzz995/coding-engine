import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { delegationScope } from '../workspace-safety/operation-records.js';
import { renderInstruction } from './loop.js';
import { read } from './loop-test-support.js';

describe('renderInstruction', () => {
  it('substitutes every {{WORKSPACE}} occurrence with the given path', () => {
    const out = renderInstruction(
      'a {{WORKSPACE}}/prd.json b {{WORKSPACE}}/progress.md',
      '/abs/state',
    );
    expect(out).toBe('a /abs/state/prd.json b /abs/state/progress.md');
  });

  it('leaves text without the placeholder unchanged', () => {
    expect(renderInstruction('no placeholder here', '.workspace')).toBe('no placeholder here');
  });

  it('substitutes {{MAX_RETRIES}} with the engine constant', () => {
    const out = renderInstruction('如果 retryCount 已经达到 {{MAX_RETRIES}}：', '.workspace');
    expect(out).toBe('如果 retryCount 已经达到 5：');
  });

  it('injects the TDD skill reference only when TDD is enabled', () => {
    expect(renderInstruction('x{{TDD_WORKFLOW}}y', '.workspace', false)).toBe('xy');
    const enabled = renderInstruction('x{{TDD_WORKFLOW}}y', '.workspace', true);
    expect(enabled).toContain('`tdd` skill');
    expect(enabled).toContain('acceptanceCriteria');
  });
});

describe('renderInstruction arbitration placeholder', () => {
  it('renders {{ARBITRATION_PREFIXES}} as a 、-joined label list', () => {
    const out = renderInstruction('保全 {{ARBITRATION_PREFIXES}} 行', '.workspace');
    expect(out).toBe('保全 [需求冲突]、[需要人工核实] 行');
  });
});

describe('instruction assets arbitration contract', () => {
  it('builder.md references the arbitration placeholder; Validator verdict state is engine-owned', () => {
    expect(read('builder.md')).toContain('{{ARBITRATION_PREFIXES}}');
    expect(read('validator.md')).not.toContain('{{ARBITRATION_PREFIXES}}');
    expect(read('validator.md')).toContain('最终状态由引擎裁决和写入');
  });

  it('builder uses guarded prd while Validator uses the engine-bound AC snapshot', () => {
    expect(read('builder.md')).toContain('prd.tampered-');
    expect(read('builder.md')).toContain('快照保护');
    expect(read('validator.md')).toContain('request.acceptanceCriteria');
    expect(read('validator.md')).toContain('唯一验收标准');
  });
});

describe('instruction assets evidence contract', () => {
  it('builder.md and validator.md carry the screenshot-claim registration template', () => {
    for (const f of ['builder.md', 'validator.md']) {
      const content = read(f);
      expect(content).toContain('evidence.jsonl');
      expect(content).toContain('screenshot-claim');
      expect(content).toContain('从 1 数起'); // acIndex 1-based 明示
      expect(content).toContain('登记失败不阻塞'); // 弱依赖声明
    }
    expect(read('builder.md')).toContain('"source":"builder"');
    expect(read('validator.md')).toContain('"source":"validator"');
  });
});

describe('instruction assets engine-owned state contract', () => {
  it('builder preserves engine fields and Validator must not write any verdict state', () => {
    const builder = read('builder.md');
    expect(builder).toContain('`validated`');
    expect(builder).toContain('`escalated`');
    expect(builder).toContain('引擎独占字段');
    expect(builder).toContain('原样保留');
    expect(read('builder.md')).toContain('待 Validator 复核的候选结果');
    const validator = read('validator.md');
    expect(validator).toContain('不得修改 `{{WORKSPACE}}/state.json`');
    expect(validator).toContain('`validated`');
    expect(validator).toContain('`escalated`');
    expect(validator).toContain('全部由引擎根据 result 写入');
  });
});

describe('instruction assets structured validation contract', () => {
  it('binds Validator to the injected request and exact v1 result schema', () => {
    const content = read('validator.md');
    expect(content).toContain('ENGINE-BOUND VALIDATION REQUEST');
    expect(content).toContain('不得从 `{{WORKSPACE}}/progress.md`');
    expect(content).toContain('"acceptanceHash"');
    expect(content).toContain('"gitHead"');
    expect(content).toContain('"checks"');
    expect(content).toContain('字段必须恰好匹配');
    expect(content).toContain('source=validator');
  });
});

describe('instruction assets workspace commit isolation contract', () => {
  it('builder commits story files before updating runtime state and never stages the workspace', () => {
    const content = read('builder.md');
    expect(content).toContain('只 stage/commit 本 story 的实现、测试与必要文档');
    expect(content).toContain('禁止 stage 或 commit `{{WORKSPACE}}`');
    expect(content).toContain('不要使用 `git add .` 或 `git add -A`');
    expect(content).toContain('`git diff --cached --name-only`');
    expect(content).toContain('提交成功后再更新');
  });

  it('reserves the workspace for engine-governed state instead of general temporary artifacts', () => {
    const content = read('builder.md');
    expect(content).toContain('不是通用临时目录');
    expect(content).toContain('不得在其中创建、修改或删除任何其他路径');
    expect(content).toContain('系统临时目录或项目已声明的生成产物目录');
    expect(content).toContain('并在返回前清理');

    const listedPaths = content
      .match(/除按下文规则写入 (?<paths>.+?) 外，不得/u)
      ?.groups?.paths.matchAll(/`(?<path>[^`]+)`/gu);
    expect(listedPaths).toBeDefined();
    const promptPaths = [...(listedPaths ?? [])].map(({ groups }) =>
      groups!.path.replace(/\/$/u, ''),
    );
    const contractPaths = delegationScope(
      'builder',
      'builder-v1',
      'US-001',
      undefined,
      `sha256:${'a'.repeat(64)}`,
      1,
      undefined,
    ).contract.rules.map(({ path }) => path);
    expect(promptPaths.sort()).toEqual(contractPaths.sort());
  });
});

describe('instruction assets Validator artifact isolation contract', () => {
  it('requires cache-free validation and a clean checkout before a passed claim', () => {
    const content = read('validator.md');
    expect(content).toContain('不是通用临时目录');
    expect(content).toContain('禁止缓存或把临时内容重定向到系统临时目录');
    expect(content).toContain('测试缓存、语言运行时字节码、覆盖率数据、静态检查缓存');
    expect(content).toContain('系统临时目录或质量契约已声明的生成产物目录');
    expect(content).toContain('被 Git 忽略也不构成保留理由');
    expect(content).toContain('`git status --short --untracked-files=all --ignored=matching`');
    expect(content).toContain('不得写入 `verdict="passed"`');
    expect(content).toContain('不得为获得干净状态而删除或还原项目原有的跟踪文件');
  });

  it('prescribes a status probe that reveals ignored Validator caches', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-validator-artifacts-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      writeFileSync(join(root, '.gitignore'), '__pycache__/\n.pytest_cache/\n');
      mkdirSync(join(root, '__pycache__'));
      writeFileSync(join(root, '__pycache__/module.pyc'), 'cache');
      mkdirSync(join(root, '.pytest_cache'));
      writeFileSync(join(root, '.pytest_cache/state'), 'cache');

      const ordinary = execFileSync('git', ['status', '--short', '--untracked-files=all'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(ordinary).not.toContain('__pycache__');
      expect(ordinary).not.toContain('.pytest_cache');

      const complete = execFileSync(
        'git',
        ['status', '--short', '--untracked-files=all', '--ignored=matching'],
        { cwd: root, encoding: 'utf8' },
      );
      expect(complete).toContain('!! __pycache__/');
      expect(complete).toContain('!! .pytest_cache/');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

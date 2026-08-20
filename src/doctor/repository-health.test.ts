import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from './doctor.js';
import { checkDeliveryGate } from './delivery.js';
import { readQualityContract } from '../quality/contract.js';

const ROOT = process.cwd();
const ISOLATED_WORKSPACE = '.workspace/repository-health-check';

function yamlBlock(source: string, header: string, indent: number): string {
  const lines = source.split(/\r?\n/u);
  const prefix = `${' '.repeat(indent)}${header}:`;
  const start = lines.indexOf(prefix);
  if (start < 0) return '';

  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const currentIndent = line.length - line.trimStart().length;
    if (line.trim() && currentIndent <= indent) break;
    block.push(line);
  }
  return block.join('\n');
}

function yamlList(source: string, header: string, indent: number): string[] {
  return yamlBlock(source, header, indent)
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^-\s+(.+)$/u)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => value.replace(/^(['"])(.*)\1$/u, '$2'));
}

function yamlNamedListEntries(
  source: string,
  header: string,
  indent: number,
): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  const entryIndent = indent + 2;
  const block = yamlBlock(source, header, indent);
  const chunks = block.split(new RegExp(`(?=^ {${entryIndent}}- dependency-name:)`, 'mu'));

  for (const chunk of chunks) {
    const match = chunk.match(/^\s*- dependency-name:\s*(['"]?)([^'"\s]+)\1\s*$/mu);
    if (!match) continue;
    entries.set(match[2], yamlList(chunk, 'update-types', entryIndent + 2));
  }
  return entries;
}

describe('coding-engine repository mechanical health', () => {
  it('checks the real documentation without asking the candidate to become the formal referee', () => {
    const report = runDoctor(ROOT, {
      requireQualityContract: false,
      local: true,
      workspace: ISOLATED_WORKSPACE,
      modelConfigPath: join(ROOT, ISOLATED_WORKSPACE, 'missing-model-config.json'),
    });

    expect(report.docsFound).toBe(true);
    expect([
      ...(report.frontmatter?.issues ?? []),
      ...(report.freshness?.issues ?? []),
      ...(report.agentsIndex?.issues ?? []),
      ...(report.links?.issues ?? []),
    ]).toEqual([]);
  });

  it('validates the real contract and generated files without comparing runtime versions', () => {
    const contract = readQualityContract(ROOT);
    expect(contract.status).toBe('ready');
    if (contract.status !== 'ready') return;

    const delivery = checkDeliveryGate({
      root: ROOT,
      workspace: ISOLATED_WORKSPACE,
      contract: contract.contract,
      local: true,
    });
    expect(delivery).toMatchObject({
      status: 'local-ready',
      remoteChecked: false,
      issues: [],
    });
  });

  it('keeps protected action pins aligned and dependency majors out of routine groups', () => {
    const qualityGate = readFileSync(
      join(ROOT, '.github/workflows/quality-gate.yml'),
      'utf8',
    ).replaceAll('\r\n', '\n');
    expect(qualityGate).toContain('on:\n  pull_request:');
    expect(qualityGate).not.toContain('\n  push:');
    expect(qualityGate).toContain("schedule:\n    - cron: '23 4 * * 1'");
    expect(qualityGate).toContain('workflow_dispatch:');

    const codeql = readFileSync(join(ROOT, '.github/workflows/codeql.yml'), 'utf8').replaceAll(
      '\r\n',
      '\n',
    );
    const codeqlPins = [...codeql.matchAll(
      /uses: github\/codeql-action\/(init|analyze)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)/gu,
    )].map((match) => ({ action: match[1], sha: match[2], version: match[3] }));
    expect(codeqlPins.map(({ action }) => action)).toEqual(['init', 'analyze']);
    expect(new Set(codeqlPins.map(({ sha }) => sha)).size).toBe(1);
    expect(new Set(codeqlPins.map(({ version }) => version)).size).toBe(1);
    expect(codeql).toContain("pull_request:\n    branches: [main]\n  schedule:");
    expect(codeql).toContain(
      "push:\n    branches: [main]\n    paths-ignore:\n      - '**/*.md'\n      - 'docs/**'",
    );
    expect(codeql).not.toContain("\n    paths:");
    expect(codeql).toContain("schedule:\n    - cron: '37 3 * * 1'");
    expect(codeql).toContain('workflow_dispatch:');

    const dependabot = readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8');
    for (const group of ['production-dependencies', 'development-dependencies', 'actions']) {
      expect(yamlList(yamlBlock(dependabot, group, 6), 'update-types', 8)).toEqual([
        'minor',
        'patch',
      ]);
    }
    const ignoredMajorUpdates = yamlNamedListEntries(dependabot, 'ignore', 4);
    expect(ignoredMajorUpdates.get('typescript')).toEqual(['version-update:semver-major']);
    expect(ignoredMajorUpdates.get('@types/node')).toEqual(['version-update:semver-major']);
  });

  it('keeps the esbuild security override, lockfile, and install permission aligned', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      overrides?: { esbuild?: unknown; tsup?: { esbuild?: unknown } };
      allowScripts?: Record<string, unknown>;
    };
    const override = manifest.overrides?.tsup?.esbuild;
    expect(override).toBe('0.28.1');
    expect(manifest.overrides?.esbuild).toBeUndefined();
    if (override !== '0.28.1') return;

    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };
    const lockedVersions = new Set(
      Object.entries(lock.packages ?? {})
        .filter(([path]) => path.endsWith('node_modules/esbuild'))
        .map(([, entry]) => entry.version),
    );
    expect([...lockedVersions]).toEqual([override]);

    const allowedEsbuildScripts = Object.keys(manifest.allowScripts ?? {}).filter((entry) =>
      entry.startsWith('esbuild@'),
    );
    expect(allowedEsbuildScripts).toEqual([`esbuild@${override}`]);
    expect(manifest.allowScripts?.[`esbuild@${override}`]).toBe(true);
  });
});

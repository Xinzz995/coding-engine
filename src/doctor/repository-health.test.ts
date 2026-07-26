import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runDoctor } from './doctor.js';
import { checkDeliveryGate } from './delivery.js';
import { readQualityContract } from '../quality/contract.js';

const ROOT = process.cwd();
const ISOLATED_WORKSPACE = '.workspace/repository-health-check';

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
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function asset(name: string): string {
  return readFileSync(join(process.cwd(), 'assets', 'quality', 'github', name), 'utf8');
}

describe('managed GitHub workflow trust boundaries', () => {
  it('executes PR code without persisted credentials, model access or check-write permission', () => {
    const workflow = asset('coding-x-project-checks.yml');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('path: _coding_x_base');
    expect(workflow).toContain('path: _coding_x_head');
    expect(workflow).toContain('ref: refs/pull/${{ inputs.pull-request-number }}/head');
    expect(workflow).toContain('repository: ${{ github.repository }}');
    expect(workflow.match(/fetch-depth: 0/g)?.length).toBe(2);
    expect(workflow).toContain('--contract-file "$GITHUB_WORKSPACE/_coding_x_base/.coding-x/quality.json"');
    expect(workflow).not.toContain('models: read');
    expect(workflow).not.toContain('checks: write');
    expect(workflow).not.toContain('secrets: inherit');
    expect(workflow).not.toContain('GITHUB_TOKEN:');
  });

  it('keeps AI review on the trusted base and only reads PR data through the API', () => {
    const workflow = asset('coding-x-review.yml');
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('group: coding-x-quality-${{ github.event.pull_request.number }}');
    expect(workflow.match(/ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/g)?.length)
      .toBeGreaterThanOrEqual(4);
    expect(workflow).not.toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(workflow).not.toContain('secrets: inherit');
    expect(workflow).toContain('models: read');
    expect(workflow).toContain('checks: write');
    expect(workflow).toContain('--axis spec');
    expect(workflow).toContain('--axis standards');
    expect(workflow).toContain('--axis deep');
    expect(workflow.match(/group: coding-x-model-\$\{\{ github\.repository_id \}\}/g)?.length)
      .toBe(3);
    expect(workflow.match(/queue: max/g)?.length).toBe(3);
    expect(workflow).toMatch(
      /standards-review:\r?\n\s+if: always\(\).*\r?\n\s+needs: \[spec-review\]/,
    );
    expect(workflow).toMatch(
      /deep-review:\r?\n\s+if: always\(\).*\r?\n\s+needs: \[standards-review\]/,
    );
    expect(workflow.match(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/g)?.length).toBe(4);
    expect(workflow.match(/CODING_X_MODEL_TOKEN: \$\{\{ secrets\.CODING_X_MODEL_TOKEN \}\}/g)?.length)
      .toBe(3);
  });

  it('installs every invocation at an isolated prefix and pins the exact version', () => {
    for (const name of [
      'coding-x-review.yml',
      'coding-x-doctor.yml',
      'coding-x-project-checks.yml',
    ]) {
      const workflow = asset(name);
      expect(workflow).toContain('--prefix "$RUNNER_TEMP"');
      expect(workflow).not.toMatch(/^\s*npx\s/m);
      expect(workflow).not.toMatch(/coding-x@(?:latest|\^|~|\*)/);
    }
    for (const name of ['coding-x-review.yml', 'coding-x-doctor.yml']) {
      expect(asset(name)).toContain('--package="coding-x@{{CODING_X_VERSION}}"');
    }
    const projectChecks = asset('coding-x-project-checks.yml');
    expect(projectChecks).toContain('--package="coding-x@${CODING_X_VERSION}"');
    expect(projectChecks).toContain('coding-x-version:');
    expect(asset('coding-x-review.yml')).toContain('coding-x-version: "{{CODING_X_VERSION}}"');
  });

  it('pins third-party actions to immutable commits', () => {
    for (const name of [
      'coding-x-review.yml',
      'coding-x-project-checks.yml',
      'coding-x-doctor.yml',
    ]) {
      const workflow = asset(name);
      expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node)@v\d+/);
      for (const reference of workflow.matchAll(/uses:\s+actions\/(?:checkout|setup-node)@([0-9a-f]+)/g)) {
        expect(reference[1]).toHaveLength(40);
      }
    }
  });

  it('uses an explicit administration credential for scheduled ruleset readback', () => {
    const workflow = asset('coding-x-doctor.yml');
    expect(workflow).toContain('secrets.CODING_X_ADMIN_TOKEN || github.token');
    expect(workflow).toContain('quality doctor');
    expect(workflow).toContain('--remote');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function rootFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('coding-engine delivery controls', () => {
  it('runs the primary delivery suite and an explicit cross-platform compatibility matrix', () => {
    const workflow = rootFile('.github/workflows/test.yml');
    for (const command of [
      'npm ci',
      'npm run lint',
      'npm run typecheck',
      'npm test',
      'npm run build',
      'node dist/cli.js --help',
      'node dist/cli.js doctor',
      'git diff --check',
      'npm audit --audit-level=high',
    ]) {
      expect(workflow).toContain(command);
    }
    for (const name of [
      'ci / primary',
      'ci / node-18-linux',
      'ci / node-22-macos',
      'ci / node-22-windows',
    ]) {
      expect(workflow).toContain(`name: ${name}`);
    }
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('runs-on: macos-latest');
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node)@v\d+/);
  });

  it('publishes only an exact main-derived version with corresponding PR delivery checks', () => {
    const workflow = rootFile('.github/workflows/publish.yml');
    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(workflow).toContain('/commits/${GITHUB_SHA}/pulls?per_page=100');
    expect(workflow).toContain('pr?.merge_commit_sha === process.env.GITHUB_SHA');
    expect(workflow).toContain('/commits/${DELIVERY_HEAD}/check-runs?per_page=100');
    expect(workflow).toContain('contract.github.requiredChecks');
    expect(workflow).toContain('npm publish --provenance --access public');
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node)@v\d+/);
  });

  it('keeps dependency updates enabled for npm and GitHub Actions', () => {
    const dependabot = rootFile('.github/dependabot.yml');
    expect(dependabot).toMatch(/package-ecosystem:\s+["']?npm["']?/);
    expect(dependabot).toMatch(/package-ecosystem:\s+["']?github-actions["']?/);
    expect(dependabot.match(/interval:\s+["']?weekly["']?/g)?.length).toBe(2);
  });

  it('pins the review stack versions used by the Node 18-compatible release', () => {
    const pkg = JSON.parse(rootFile('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies.jsonrepair).toBe('3.14.1');
    expect(pkg.devDependencies.vitest).toBe('3.2.6');
    expect(pkg.devDependencies.vite).toBe('6.4.3');
    expect(pkg.devDependencies.eslint).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

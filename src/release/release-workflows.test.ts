import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function workflow(name: string): string {
  return readFileSync(resolve('.github/workflows', name), 'utf8');
}

describe('release candidate workflow boundaries', () => {
  it('builds and preserves a candidate without any npm publishing identity', () => {
    const source = workflow('build-candidate.yml');

    expect(source).toContain('npm run typecheck');
    expect(source).toContain('npm test');
    expect(source).toContain('record-pack');
    expect(source).toContain('--candidate-workflow-run-id');
    expect(source).toContain('npm-candidate-${{ inputs.version }}');
    expect(source).not.toContain('id-token: write');
    expect(source).not.toContain('environment: npm-staging');
    expect(source).not.toContain('npm stage publish');
  });

  it('stages only a selected successful candidate from the current main commit', () => {
    const source = workflow('stage-candidate.yml');

    expect(source).toContain('candidate_run_id:');
    expect(source).toContain('.github/workflows/build-candidate.yml');
    expect(source).toContain('.head_sha == $sha');
    expect(source).toContain('.conclusion == "success"');
    expect(source).toContain('git/ref/heads/main');
    expect(source).toContain('if [ "$CURRENT_MAIN_COMMIT" != "$REMOTE_MAIN_COMMIT" ]');
    expect(source).toContain('run-id: ${{ inputs.candidate_run_id }}');
    expect(source).toContain('--candidate-workflow-run-id');
    expect(source).toContain('--stage-workflow-run-id');
    expect(source).toContain('environment: npm-staging');
    expect(source).toContain('id-token: write');
    expect(source).toContain('npm stage publish');
    expect(source).not.toContain('npm ci');
    expect(source).not.toContain('npm test');
    expect(source).not.toContain('npm run build');
  });

  it('releases from the original candidate run selected by the immutable stage evidence', () => {
    const source = workflow('publish.yml');

    expect(source).toContain('.candidateWorkflowRunId');
    expect(source).toContain('.github/workflows/build-candidate.yml');
    expect(source).toContain('run-id: ${{ steps.candidate.outputs.candidate_run_id }}');
    expect(source).toContain('--stage-workflow-run-id "$STAGE_RUN_ID"');
    expect(source.indexOf('Download the stage identity artifact')).toBeLessThan(
      source.indexOf('Download the original pre-stage candidate artifact'),
    );
  });
});

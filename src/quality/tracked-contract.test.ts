import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStoryValidationGitAuthorityOutput } from './tracked-contract.js';

const DEFAULT_BRANCH_HEAD = 'a'.repeat(40);
const HEADER = `CODING_X_DEFAULT_BRANCH=${DEFAULT_BRANCH_HEAD}\n`;

describe('parseStoryValidationGitAuthorityOutput', () => {
  it('separates the exact default-branch commit from unchanged tracked contract bytes', () => {
    const contract = readFileSync(resolve('.coding-x/quality.json'));

    const result = parseStoryValidationGitAuthorityOutput(
      Buffer.concat([Buffer.from(HEADER, 'ascii'), contract]),
    );

    expect(result).toMatchObject({
      defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
      trackedContract: {
        status: 'ready',
        sourceFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
  });

  it.each([
    ['missing delimiter', Buffer.from(`CODING_X_DEFAULT_BRANCH=${DEFAULT_BRANCH_HEAD}`)],
    ['wrong marker', Buffer.from(`DEFAULT_BRANCH=${DEFAULT_BRANCH_HEAD}\n{}`)],
    ['abbreviated commit', Buffer.from('CODING_X_DEFAULT_BRANCH=abc123\n{}')],
  ])('fails closed for a %s envelope', (_name, output) => {
    expect(parseStoryValidationGitAuthorityOutput(output)).toMatchObject({
      defaultBranchGitHead: null,
      trackedContract: {
        status: 'io-error',
        error: expect.stringContaining('未返回可验证'),
      },
    });
  });

  it('keeps an oversized tracked contract unavailable after accepting the commit framing', () => {
    const output = Buffer.concat([
      Buffer.from(HEADER, 'ascii'),
      Buffer.alloc(1024 * 1024 + 1, 0x20),
    ]);

    expect(parseStoryValidationGitAuthorityOutput(output)).toMatchObject({
      defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
      trackedContract: {
        status: 'io-error',
        error: expect.stringContaining('超过 1048576 字节'),
      },
    });
  });
});

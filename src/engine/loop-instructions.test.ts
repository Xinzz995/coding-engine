import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const readFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({ readFileSync }));

import { readLoopInstruction } from './loop-instructions.js';

describe('readLoopInstruction', () => {
  beforeEach(() => {
    readFileSync.mockReset();
  });

  it('returns the instruction text from the requested path', () => {
    readFileSync.mockReturnValue('instruction');
    expect(readLoopInstruction('/instructions', 'builder.md')).toBe('instruction');
    expect(readFileSync).toHaveBeenCalledWith(join('/instructions', 'builder.md'), 'utf-8');
  });

  it('treats only a missing instruction file as an absent optional input', () => {
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect(readLoopInstruction('/instructions', 'validator.md')).toBeNull();
  });

  it('surfaces permission and other IO failures instead of hiding them as missing files', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    readFileSync.mockImplementation(() => {
      throw denied;
    });
    expect(() => readLoopInstruction('/instructions', 'builder.md')).toThrow(denied);
  });
});

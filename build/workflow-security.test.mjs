import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function workflowFiles() {
  const directory = join(process.cwd(), '.github', 'workflows');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }));
}

describe('GitHub workflow trust boundary', () => {
  it('pins every external action to a full commit', () => {
    const unpinned = [];
    for (const { name, text } of workflowFiles()) {
      for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
        const action = match[1];
        if (action.startsWith('./')) continue;
        const separator = action.lastIndexOf('@');
        const ref = separator < 0 ? '' : action.slice(separator + 1);
        if (!/^[0-9a-f]{40}$/.test(ref)) unpinned.push(`${name}: ${action}`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it('contains no hosted AI review command, model credential, or model sharding job', () => {
    const combined = workflowFiles()
      .map(({ name, text }) => `# ${name}\n${text}`)
      .join('\n');
    expect(combined).not.toMatch(
      /OPENAI(?:_API)?_KEY|ANTHROPIC(?:_API)?_KEY|CURSOR(?:_API)?_KEY|MODEL_API_KEY/i,
    );
    expect(combined).not.toMatch(/^\s*(?:name|uses):.*ai[-_ ]?review/im);
    expect(combined).not.toMatch(/^\s*uses:.*(?:openai|anthropic|cursor)/im);
    expect(combined).not.toMatch(/^\s*run:\s*.*\b(?:codex|claude|cursor)\b/im);
    expect(combined).not.toMatch(/model[-_ ]?shard|review[-_ ]?shard/i);
  });
});

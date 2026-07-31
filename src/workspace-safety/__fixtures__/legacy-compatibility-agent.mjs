import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CODING_X_LEGACY_COMPAT_CONTROL;
if (!root) process.exit(90);
const countPath = join(root, 'agent-count');
appendFileSync(countPath, 'invoked\n');
let first = false;
try {
  writeFileSync(join(root, 'agent-first'), 'claimed', { flag: 'wx' });
  first = true;
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}
if (first) {
  writeFileSync(join(root, 'agent-started'), 'ready');
  while (!existsSync(join(root, 'agent-continue'))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
process.exit(1);

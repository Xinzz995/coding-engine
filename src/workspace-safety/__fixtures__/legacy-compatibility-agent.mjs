import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CODING_X_LEGACY_COMPAT_CONTROL;
if (!root) process.exit(90);
const countPath = join(root, 'agent-count');
const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
writeFileSync(countPath, String(count));
if (count === 1) {
  writeFileSync(join(root, 'agent-started'), 'ready');
  while (!existsSync(join(root, 'agent-continue'))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
process.exit(1);

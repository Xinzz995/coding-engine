import { createInterface } from 'node:readline';

const mode = process.env.CODING_X_FAKE_DISCOVERY_MODE ?? 'ok';
const args = process.argv.slice(2);

if (!args.includes('app-server')) {
  process.exit(mode === 'auth-error' ? 1 : 0);
}

if (mode === 'app-exit') process.exit(7);
if (mode === 'hang') await new Promise(() => {});

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === 'initialize') {
    if (mode === 'noise') process.stdout.write('not-json noise\n');
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'fake' } })}\n`);
    continue;
  }
  if (message.method !== 'model/list') continue;
  if (mode === 'rpc-error') {
    process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -1, message: 'token=SECRET base=https://secret.invalid' } })}\n`);
    continue;
  }
  if (mode === 'empty') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`);
    continue;
  }
  const cursor = message.params?.cursor;
  const result = cursor
    ? { data: [{ id: 'model-b', displayName: 'Model B', isDefault: false }], nextCursor: null }
    : {
        data: [
          { id: 'model-a', displayName: 'Model A', isDefault: true },
          { id: 'model-a', displayName: 'Duplicate', isDefault: false },
          { id: '', displayName: 'Invalid' },
        ],
        nextCursor: 'page-2',
      };
  process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
}

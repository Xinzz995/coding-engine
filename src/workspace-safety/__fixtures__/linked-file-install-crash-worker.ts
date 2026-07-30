import { installFileNoReplace } from '../filesystem.js';

const [source, target] = process.argv.slice(2);
if (!source || !target || typeof process.send !== 'function') process.exit(2);

await installFileNoReplace(source, target, {
  afterLink: async () => {
    process.send?.({ schemaVersion: 1, type: 'LINKED' });
    await new Promise<never>(() => {
      setInterval(() => undefined, 1000);
    });
  },
});

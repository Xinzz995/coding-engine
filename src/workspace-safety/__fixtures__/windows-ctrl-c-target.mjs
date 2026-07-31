import { writeFileSync } from 'node:fs';

const [targetSawCtrl, targetReady] = process.argv.slice(2);
if (!targetSawCtrl || !targetReady) {
  throw new Error('Ctrl+C target arguments are incomplete');
}

process.on('SIGINT', () => writeFileSync(targetSawCtrl, 'saw-ctrl'));
writeFileSync(targetReady, 'ready');
setInterval(() => {}, 1000);

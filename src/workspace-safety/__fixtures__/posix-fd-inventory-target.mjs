import { fstatSync, readdirSync, writeFileSync } from 'node:fs';

const inventoryPath = process.argv[2];
if (!inventoryPath || process.platform === 'win32') process.exit(2);

function descriptorType(info) {
  if (info.isSocket()) return 'socket';
  if (info.isFIFO()) return 'fifo';
  if (info.isCharacterDevice()) return 'character';
  if (info.isBlockDevice()) return 'block';
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  return 'other';
}

function openDescriptors() {
  const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  const descriptors = [];
  const numbers = readdirSync(directory)
    .filter((entry) => /^(?:0|[1-9][0-9]*)$/u.test(entry))
    .map(Number)
    .sort((left, right) => left - right);
  for (const descriptor of numbers) {
    try {
      descriptors.push({ descriptor, type: descriptorType(fstatSync(descriptor)) });
    } catch (error) {
      if (error?.code !== 'EBADF') throw error;
      // readdir itself can briefly appear in /proc/self/fd or /dev/fd, then close.
    }
  }
  return { directory, descriptors };
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const inventory = openDescriptors();
writeFileSync(
  inventoryPath,
  `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    processConnected: process.connected === true,
    processChannelFd: process.channel?.fd ?? null,
    nodeChannelFd: process.env.NODE_CHANNEL_FD ?? null,
    descriptorSource: inventory.directory,
    descriptors: inventory.descriptors,
  })}\n`,
  { flag: 'wx', mode: 0o600 },
);
setInterval(() => undefined, 1000);

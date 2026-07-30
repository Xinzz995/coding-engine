import { readFixedPosixHelperBundle } from './posix-supervisor-assets.js';
import { readDarkWindowsHelperBundle } from './windows-supervisor-integration.js';

/** Read the packaged helper for the current platform; callers cannot substitute helper bytes. */
export function readFixedPlatformHelperBundle(): Buffer {
  return process.platform === 'win32'
    ? readDarkWindowsHelperBundle()
    : readFixedPosixHelperBundle();
}

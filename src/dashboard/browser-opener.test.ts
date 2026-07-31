import { describe, expect, it } from 'vitest';
import { browserOpenCommand } from './browser-opener.js';

describe('browserOpenCommand', () => {
  it('maps macOS to open', () => {
    expect(browserOpenCommand('darwin', 'http://x')).toEqual({ cmd: 'open', args: ['http://x'] });
  });

  it('maps Windows to cmd start', () => {
    expect(browserOpenCommand('win32', 'http://x')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'http://x'],
    });
  });

  it('maps Linux to xdg-open', () => {
    expect(browserOpenCommand('linux', 'http://x')).toEqual({
      cmd: 'xdg-open',
      args: ['http://x'],
    });
  });
});

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installCommandSignals } from './command-signals.js';

describe('installCommandSignals', () => {
  it('turns the first POSIX signal into one cooperative termination request', () => {
    const source = new EventEmitter();
    const hardExit = vi.fn();
    const signals = installCommandSignals({ source, platform: 'linux', hardExit });
    expect(source.listenerCount('SIGINT')).toBe(1);
    expect(source.listenerCount('SIGTERM')).toBe(1);

    source.emit('SIGTERM');
    expect(signals.termination.signal.aborted).toBe(true);
    expect(signals.requestedSignal).toBe('SIGTERM');
    expect(signals.exitCode).toBe(143);
    expect(hardExit).not.toHaveBeenCalled();

    signals.dispose();
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);
  });

  it('keeps Windows to the supported Ctrl+C path and hard-exits on a second signal', () => {
    const source = new EventEmitter();
    const hardExit = vi.fn();
    const signals = installCommandSignals({ source, platform: 'win32', hardExit });
    expect(source.listenerCount('SIGINT')).toBe(1);
    expect(source.listenerCount('SIGTERM')).toBe(0);

    source.emit('SIGINT');
    source.emit('SIGINT');
    expect(signals.exitCode).toBe(130);
    expect(hardExit).toHaveBeenCalledWith('SIGINT');
    signals.dispose();
  });
});

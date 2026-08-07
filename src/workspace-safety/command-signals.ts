import type { SupervisorTerminationReason } from './supervisor-protocol.js';

type SupportedCommandSignal = 'SIGINT' | 'SIGTERM';

interface SignalSource {
  on(event: SupportedCommandSignal, listener: () => void): unknown;
  removeListener(event: SupportedCommandSignal, listener: () => void): unknown;
}

export interface CommandSignalController {
  readonly termination: {
    readonly signal: AbortSignal;
    readonly reason: Exclude<SupervisorTerminationReason, 'timeout' | 'output-failure'>;
  };
  readonly requestedSignal: SupportedCommandSignal | null;
  readonly exitCode: 130 | 143 | null;
  dispose(): void;
}

export interface InstallCommandSignalOptions {
  readonly source?: SignalSource;
  readonly platform?: NodeJS.Platform;
  /** Test seam. Production re-raises the second signal with the OS default action. */
  readonly hardExit?: (signal: SupportedCommandSignal) => void;
}

/**
 * The first interrupt asks the active coordinator to terminate and prove containment empty.
 * A second interrupt is intentionally hard: operators retain an escape hatch, while recovery
 * records remain the only route back to a writable workspace after an unsafe interruption.
 */
export function installCommandSignals(
  options: InstallCommandSignalOptions = {},
): CommandSignalController {
  const source = options.source ?? process;
  const platform = options.platform ?? process.platform;
  const controller = new AbortController();
  let requestedSignal: SupportedCommandSignal | null = null;
  let disposed = false;
  const listeners = new Map<SupportedCommandSignal, () => void>();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) source.removeListener(signal, listener);
    listeners.clear();
  };
  const hardExit =
    options.hardExit ??
    ((signal: SupportedCommandSignal) => {
      dispose();
      process.kill(process.pid, signal);
    });
  const install = (signal: SupportedCommandSignal): void => {
    const listener = () => {
      if (requestedSignal !== null) {
        hardExit(signal);
        return;
      }
      requestedSignal = signal;
      controller.abort();
    };
    listeners.set(signal, listener);
    source.on(signal, listener);
  };
  install('SIGINT');
  if (platform !== 'win32') install('SIGTERM');

  return {
    termination: {
      signal: controller.signal,
      reason: 'user-interrupt',
    },
    get requestedSignal() {
      return requestedSignal;
    },
    get exitCode() {
      if (requestedSignal === 'SIGINT') return 130;
      if (requestedSignal === 'SIGTERM') return 143;
      return null;
    },
    dispose,
  };
}

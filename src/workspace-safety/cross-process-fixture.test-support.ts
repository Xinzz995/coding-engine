import type { ChildProcess } from 'node:child_process';
const ORDINARY_WINDOWS_TEST_REGISTER = new URL(
  './__fixtures__/ordinary-windows-test-register.mjs',
  import.meta.url,
).href;

export interface TypeScriptFixtureLaunchOptions {
  readonly platform?: NodeJS.Platform;
  /** Keep the complete native Windows inspector path when the fixture starts the real supervisor. */
  readonly windowsIdentity?: 'deterministic' | 'production';
}

export function typeScriptFixtureExecArgv(options: TypeScriptFixtureLaunchOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const useDeterministicWindowsTransport =
    platform === 'win32' && options.windowsIdentity !== 'production';
  return [
    '--import',
    'tsx',
    ...(useDeterministicWindowsTransport ? ['--import', ORDINARY_WINDOWS_TEST_REGISTER] : []),
  ];
}

export function typeScriptFixtureNodeArgs(
  workerPath: string,
  args: readonly string[],
  options: TypeScriptFixtureLaunchOptions = {},
): string[] {
  return [...typeScriptFixtureExecArgv(options), workerPath, ...args];
}

export interface CrossProcessFixtureTracker {
  readonly track: <T extends ChildProcess>(child: T) => T;
  readonly settle: () => Promise<void>;
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`test fixture process ${String(child.pid)} did not exit`)),
      timeoutMs,
    );
    function cleanup(): void {
      clearTimeout(timer);
      child.off('close', onClose);
    }
    function finish(error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function onClose(): void {
      finish();
    }
    child.once('close', onClose);
  });
}

export function createCrossProcessFixtureTracker(): CrossProcessFixtureTracker {
  const children = new Set<ChildProcess>();
  return {
    track: <T extends ChildProcess>(child: T): T => {
      children.add(child);
      const retainUntilClose = (): void => {
        // A ChildProcess error is not an exit signal. The caller still receives the same event,
        // while this listener prevents an otherwise-unhandled spawn or kill error from aborting
        // the test process before afterEach can settle the fixture.
      };
      const forget = (): void => {
        child.off('error', retainUntilClose);
        children.delete(child);
      };
      // An IPC or termination error does not prove that the OS process exited. Keep the child
      // tracked until close so afterEach can still terminate and await it.
      child.on('error', retainUntilClose);
      child.once('close', forget);
      return child;
    },
    settle: async (): Promise<void> => {
      const active = [...children];
      const closes = active.map((child) => waitForClose(child, 5_000));
      const errors: Error[] = [];
      for (const child of active) {
        if (typeof child.pid === 'number' && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
      const results = await Promise.allSettled(closes);
      children.clear();
      errors.push(
        ...results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) =>
            result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          ),
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, 'cross-process test fixture cleanup failed');
      }
    },
  };
}

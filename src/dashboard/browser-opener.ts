import { spawn } from 'node:child_process';

/** Standalone dashboard only: map a URL to the platform's default-browser command. */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Best-effort user-interface convenience for `coding-x dashboard`.
 * Formal run never imports this module because it holds an active workspace session.
 */
export function openBrowserBestEffort(url: string): void {
  try {
    const { cmd, args } = browserOpenCommand(process.platform, url);
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* A missing desktop opener is non-fatal for the standalone dashboard. */
    });
    child.unref();
  } catch {
    // Browser launch failures never stop the standalone dashboard.
  }
}

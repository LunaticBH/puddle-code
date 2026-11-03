import { spawn } from 'node:child_process';

/**
 * Best-effort browser launch — hand-rolled to keep the dependency count at
 * zero. Failure is non-fatal by contract: callers always print the URL too.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const command =
    platform === 'darwin'
      ? { bin: 'open', args: [url] }
      : platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '', url] }
        : { bin: 'xdg-open', args: [url] };
  try {
    const child = spawn(command.bin, command.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

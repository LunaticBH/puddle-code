import { spawn } from 'node:child_process';
import { system32Path } from '@puddle/shared/node/platform';

/**
 * Best-effort browser launch — hand-rolled to keep the dependency count at
 * zero. Failure is non-fatal by contract: callers always print the URL too.
 * Windows hands the URL to the shell's protocol handler directly, never
 * through cmd.exe, which would parse `&`, `^` and `|` inside it.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const command =
    platform === 'darwin'
      ? { bin: 'open', args: [url] }
      : platform === 'win32'
        ? { bin: system32Path('rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] }
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

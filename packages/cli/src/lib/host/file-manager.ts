import { execFile, spawn } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { dirname, isAbsolute, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { CockpitFileManager } from '@puddle/shared';

const execute = promisify(execFile);

export interface LocalFileManager {
  name: NonNullable<CockpitFileManager['name']>;
  reveal(path: string, authorised: () => boolean): Promise<void>;
}

/** Local OS integration shared by the browser cockpit and desktop shell. */
export function localFileManager(
  platform: NodeJS.Platform = process.platform,
): LocalFileManager | undefined {
  const name =
    platform === 'darwin'
      ? 'Finder'
      : platform === 'win32'
        ? 'File Explorer'
        : platform === 'linux'
          ? 'File Manager'
          : null;
  if (!name) return;
  return {
    name,
    async reveal(path, authorised) {
      if (
        !(platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)) ||
        path.includes('\0')
      )
        throw new Error('Expected an absolute local path.');
      // Keep the selected path (including symlinks) instead of revealing its target.
      const entry = await lstat(path);
      const directory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await stat(path).then(
            (target) => target.isDirectory(),
            () => false,
          )));
      const run = async (command: string, args: string[], detached = false) => {
        if (!authorised()) throw new Error('Browser authorisation expired.');
        if (detached) {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(command, args, { stdio: 'ignore', detached: true });
            child.once('error', reject);
            child.once('spawn', () => {
              child.unref();
              resolve();
            });
          });
          return;
        }
        await execute(command, args, { timeout: 10_000, maxBuffer: 16_384, windowsHide: true });
      };
      if (platform === 'darwin') {
        // Explicitly choose Finder for directories, including application bundles.
        await run('/usr/bin/open', directory ? ['-a', 'Finder', '--', path] : ['-R', '--', path]);
      } else if (platform === 'win32') {
        // Explorer may become the long-lived desktop process; never wait for or kill it.
        await run('explorer.exe', directory ? [path] : ['/select,', path], true);
      } else {
        try {
          await run('gdbus', [
            'call',
            '--session',
            '--dest',
            'org.freedesktop.FileManager1',
            '--object-path',
            '/org/freedesktop/FileManager1',
            '--method',
            `org.freedesktop.FileManager1.${directory ? 'ShowFolders' : 'ShowItems'}`,
            JSON.stringify([pathToFileURL(path).href]),
            '',
          ]);
        } catch {
          // Minimal desktops may lack FileManager1; still open the containing folder.
          await run('xdg-open', [directory ? path : dirname(path)], true);
        }
      }
    },
  };
}

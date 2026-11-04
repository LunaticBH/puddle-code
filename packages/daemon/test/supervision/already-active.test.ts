import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ipcPath, listenPrivate } from '@puddle/shared/node';
import { DAEMON_ALREADY_ACTIVE_EXIT } from '@puddle/shared/node/platform';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/**
 * A second daemon of a home exits before it opens anything. On Windows it
 * says so with its own status, which the supervisor never restarts; POSIX
 * keeps its unhandled-rejection exit (`pnpm build` first).
 */
it.runIf(existsSync(entry))(
  'exits with the already-active status on Windows when the home’s control pipe is served',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-already-active-'));
    const sockets = new Set<Socket>();
    const holder = await listenPrivate(ipcPath(home, 'host'), (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
    });
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PUDDLE_HOME: home };
      for (const key of Object.keys(env)) {
        if (/^CLAUDE(CODE|_CODE_)/i.test(key)) delete env[key];
      }
      // It never reaches its HTTP port: the control pipe comes first.
      const child = spawn(process.execPath, [entry], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(stderr).toMatch(/already active/);
      expect(code).toBe(process.platform === 'win32' ? DAEMON_ALREADY_ACTIVE_EXIT : 1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  },
  60_000,
);

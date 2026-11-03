import { createServer, type Server } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../helpers/authorised-daemon.js';
import { resolvePaths } from '../../src/paths.js';
import { readRuntime } from '../../src/runtime-file.js';

/** Grab a port and hold it, so the daemon must bind somewhere else. */
function occupy(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        port,
        release: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

describe('daemon port binding', () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  it('falls back to a free port when the configured port is busy, and records it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-runtime-'));
    const squatter = await occupy();
    try {
      daemon = await startDaemon({ home, adapters: [], port: squatter.port });
      // Did not crash; bound somewhere other than the busy port.
      expect(daemon.port).not.toBe(squatter.port);
      expect(daemon.port).toBeGreaterThan(0);
      // The live port is recorded for clients to discover.
      const runtime = readRuntime(resolvePaths(home));
      expect(runtime).toEqual({ port: daemon.port, pid: process.pid });
      // And it is actually listening there (not ECONNREFUSED on the old port).
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/version`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await squatter.release();
    }
  });

  it('binds the preferred port when it is free, and clears the record on shutdown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-runtime-'));
    const free = await occupy();
    const preferred = free.port;
    await free.release(); // now free — the daemon should take it

    daemon = await startDaemon({ home, adapters: [], port: preferred });
    expect(daemon.port).toBe(preferred);
    expect(readRuntime(resolvePaths(home))).toEqual({ port: preferred, pid: process.pid });

    await daemon.stop();
    daemon = undefined;
    // Clean shutdown removes the record — its presence means "believed up".
    expect(readRuntime(resolvePaths(home))).toBeNull();
  });
});

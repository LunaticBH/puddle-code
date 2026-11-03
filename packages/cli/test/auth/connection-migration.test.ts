import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';

const install = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('installation failed');
  }),
);
vi.mock('../../src/lib/installation/bootstrap.js', () => ({
  installDaemon: install,
  installedVersion: async () => '0.1.13',
}));
import { ensureDaemon } from '../../src/lib/connection/cockpit.js';
import { LocalTransport } from '../../src/lib/transport/local.js';
import { ensureToken } from '../../../daemon/src/security/token.js';
import { ensureHome, resolvePaths } from '../../../daemon/src/paths.js';

let server: Server | undefined;
let major = 17;
let home: string;
const master = 'c'.repeat(64);
const savedHome = process.env.PUDDLE_HOME;
beforeEach(async () => {
  major = 17;
  install.mockClear();
  home = mkdtempSync(join(tmpdir(), 'puddle-migration-'));
  // Released installations predate the private authority directory requirement.
  chmodSync(home, 0o755);
  process.env.PUDDLE_HOME = home;
  writeFileSync(join(home, 'token'), master + '\n', { mode: 0o600 });
  server = createServer((req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${master}`);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/version' ? { version: '0.1.13', protocol: { major, minor: 3 } } : [],
      ),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  writeFileSync(
    join(home, 'runtime.json'),
    JSON.stringify({ port: (server.address() as { port: number }).port }),
  );
});
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (savedHome === undefined) delete process.env.PUDDLE_HOME;
  else process.env.PUDDLE_HOME = savedHome;
});
it('honours --no-upgrade before replacing a legacy host', async () => {
  await expect(ensureDaemon(new LocalTransport(), { noUpgrade: true })).rejects.toMatchObject({
    code: 'upgrade_failed',
  });
  expect(install).not.toHaveBeenCalled();
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(master);
});
it('reports newer protocols without attempting an install', async () => {
  major = PROTOCOL_VERSION.major + 1;
  await expect(ensureDaemon(new LocalTransport(), {})).rejects.toMatchObject({
    code: 'cli_outdated',
  });
  expect(install).not.toHaveBeenCalled();
});
it('keeps local recovery authority when an upgrade fails', async () => {
  await expect(
    ensureDaemon(new LocalTransport(), { confirmDaemonUpgrade: async () => true }),
  ).rejects.toThrow('installation failed');
  expect(install).toHaveBeenCalledOnce();
  expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(master);
});
it('atomically retires the old distributed master exactly once', () => {
  const paths = resolvePaths(home);
  ensureHome(paths);
  const migrated = ensureToken(paths);
  expect(migrated).not.toBe(master);
  expect(JSON.parse(readFileSync(paths.tokenFile, 'utf8'))).toEqual({
    migration: 18,
    master: migrated,
  });
  expect(ensureToken(paths)).toBe(migrated);
});

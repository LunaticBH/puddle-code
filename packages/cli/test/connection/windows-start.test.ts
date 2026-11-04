import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { ipcPath, ipcProof, listenPrivate } from '@puddle/shared/node';

const install = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => {
    throw new Error('installation reached');
  }),
);
vi.mock('../../src/lib/installation/bootstrap.js', () => ({
  installDaemon: install,
  installedVersion: async () => '0.3.14',
}));
import { acquireAuthority } from '../../src/lib/auth/connection-authority.js';
import { ensureDaemon } from '../../src/lib/connection/cockpit.js';
import { LocalTransport } from '../../src/lib/transport/local.js';
import { CliError } from '../../src/lib/types.js';
import { pinnedDaemonVersion } from '../../src/lib/version.js';

/**
 * The local Windows start path (docs/windows.md, decision 6), driven through
 * an injected win32 transport so it also runs on POSIX, where ipcPath gives
 * a socket instead of a pipe.
 */
const savedHome = process.env.PUDDLE_HOME;
let home: string;
let server: Server | undefined;
beforeEach(() => {
  install.mockClear();
  home = mkdtempSync(join(tmpdir(), 'puddle-windows-start-'));
  process.env.PUDDLE_HOME = home;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (savedHome === undefined) delete process.env.PUDDLE_HOME;
  else process.env.PUDDLE_HOME = savedHome;
});

/** Serve the home's control pipe, answering each request with `reply(challenge)`. */
async function serve(reply: (challenge: string | undefined) => object) {
  server = await listenPrivate(ipcPath(home, 'host'), (socket: Socket) => {
    socket.on('error', () => {});
    socket.on('data', (request: Buffer) => {
      const { challenge } = JSON.parse(request.toString()) as { challenge?: string };
      socket.end(JSON.stringify(reply(challenge)) + '\n');
    });
  });
}
const proven = (challenge: string | undefined) =>
  challenge === undefined ? {} : { proof: ipcProof(home, 'host', challenge) };

it('starts the installed daemon when none holds the control pipe, leaving one started meanwhile alone', async () => {
  const transport = new LocalTransport({ platform: 'win32' });
  await expect(ensureDaemon(transport, {})).rejects.toThrow('installation reached');
  expect(install).toHaveBeenCalledOnce();
  // After a reboot the installed `current` starts, not this launcher's own release.
  expect(install.mock.calls[0]![1]).toMatchObject({ replaceRunning: false, version: '0.3.14' });
});

it('installs this launcher’s release when the installed one cannot start', async () => {
  install.mockImplementationOnce(async () => {
    throw new CliError('not_installed', 'download failed (HTTP 404)');
  });
  const transport = new LocalTransport({ platform: 'win32' });
  await expect(ensureDaemon(transport, {})).rejects.toThrow('installation reached');
  expect(install).toHaveBeenCalledTimes(2);
  expect(install.mock.calls[1]![1]).toMatchObject({ replaceRunning: false });
  expect(install.mock.calls[1]![1]).not.toHaveProperty('version');
});

it('installs this launcher’s release when the installed one is broken and the machine is offline', async () => {
  // The installed tree fails its smoke test, so the installer fetches it
  // again; offline, Node's fetch rejects instead of answering with a status.
  install.mockImplementationOnce(async (_transport, opts) => {
    const { installWindowsDaemon } = await import('../../src/lib/installation/windows-install.js');
    await installWindowsDaemon({
      ...(opts as { version: string; replaceRunning: boolean }),
      home,
      fetchFn: async () => {
        throw new TypeError('fetch failed');
      },
    });
    throw new Error('the offline installation succeeded');
  });
  const savedRepo = process.env.PUDDLE_REPO;
  process.env.PUDDLE_REPO = 'acme/puddle';
  try {
    const transport = new LocalTransport({ platform: 'win32' });
    await expect(ensureDaemon(transport, {})).rejects.toThrow('installation reached');
  } finally {
    if (savedRepo === undefined) delete process.env.PUDDLE_REPO;
    else process.env.PUDDLE_REPO = savedRepo;
  }
  expect(install).toHaveBeenCalledTimes(2);
  expect(install.mock.calls[0]![1]).toMatchObject({ version: '0.3.14' });
  expect(install.mock.calls[1]![1]).not.toHaveProperty('version');
});

it('hands an installed daemon with another protocol to the handshake, on this launcher’s release', async () => {
  install.mockImplementationOnce(async () => {
    throw new CliError('protocol_mismatch', 'Host protocol 24 does not match client protocol 25');
  });
  const transport = new LocalTransport({ platform: 'win32' });
  await expect(ensureDaemon(transport, {})).rejects.toThrow('installation reached');
  expect(install).toHaveBeenCalledTimes(2);
  expect(install.mock.calls[1]![1]).toMatchObject({ version: pinnedDaemonVersion() });
});

it('installs exactly the archive a caller names', async () => {
  const transport = new LocalTransport({ platform: 'win32' });
  await expect(ensureDaemon(transport, { tarball: 'C:\\dl\\x.zip' })).rejects.toThrow(
    'installation reached',
  );
  expect(install).toHaveBeenCalledOnce();
  expect(install.mock.calls[0]![1]).not.toHaveProperty('version');
});

it('waits for a daemon that holds the pipe but is not ready, and never replaces it', async () => {
  // A starting daemon answers every request with `unavailable`, and its proof.
  await serve((challenge) => ({ t: 'error', code: 'unavailable', ...proven(challenge) }));
  const transport = new LocalTransport({ platform: 'win32' });
  await expect(ensureDaemon(transport, { startTimeoutMs: 1500 })).rejects.toMatchObject({
    code: 'daemon_unreachable',
  });
  expect(install).not.toHaveBeenCalled();
});

it('neither believes nor waits for a pipe server that cannot prove it reads the home', async () => {
  // Another account's process on a name it listed while the daemon was running.
  await serve(() => ({
    t: 'authority',
    generation: randomUUID(),
    token: `cn_${'a'.repeat(64)}`,
    validForMs: 45_000,
    port: 1,
    version: { version: '9.9.9', protocol: PROTOCOL_VERSION },
  }));
  const transport = new LocalTransport({ platform: 'win32' });
  await expect(acquireAuthority(transport)).rejects.toThrow('not served by this home’s daemon');
  // The installer renames the home's pipes before it starts the real daemon.
  await expect(ensureDaemon(transport, { startTimeoutMs: 1500 })).rejects.toThrow(
    'installation reached',
  );
});

it('refuses shell commands on this machine on Windows', async () => {
  await expect(new LocalTransport({ platform: 'win32' }).exec('true')).rejects.toMatchObject({
    code: 'unsupported_platform',
  });
});

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../daemon/test/helpers/authorised-daemon.js';
import { acquireAuthority } from '../src/lib/auth/connection-authority.js';
import { inspectHost } from '../src/lib/auth/control-channel.js';
import { findFreePort, waitForTcp } from '../src/lib/transport/net.js';
import { SshTransport, shellQuote } from '../src/lib/transport/ssh.js';
import { openTunnel } from '../src/lib/transport/tunnel.js';
import { DaemonClient } from '../src/lib/connection/daemon-client.js';

const temporary = mkdtempSync(join(tmpdir(), 'puddle-loopback-ssh-'));
const hostHome = join(temporary, 'host');
const clientHome = join(temporary, 'client');
let daemon: RunningDaemon | undefined;
let sshd: ChildProcess;
let wrapper: string;
let output = '';
let legacy: Server | undefined;
const previousHome = process.env.PUDDLE_HOME;

beforeAll(async () => {
  mkdirSync(hostHome, { mode: 0o700 });
  mkdirSync(clientHome, { mode: 0o700 });
  process.env.PUDDLE_HOME = clientHome;
  const key = join(temporary, 'client-key');
  const hostKey = join(temporary, 'host-key');
  for (const file of [key, hostKey])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
  const port = await findFreePort();
  const serverConfig = join(temporary, 'sshd_config');
  writeFileSync(
    serverConfig,
    `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${temporary}/sshd.pid\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAcceptEnv PUDDLE_HOME\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(temporary, 'known_hosts'),
    `[127.0.0.1]:${port} ${readFileSync(hostKey + '.pub', 'utf8')}`,
    { mode: 0o600 },
  );
  const config = join(temporary, 'ssh_config');
  writeFileSync(
    config,
    `Host fixture\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile ${key}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile ${temporary}/known_hosts\n SetEnv PUDDLE_HOME=${hostHome}\n`,
    { mode: 0o600 },
  );
  wrapper = join(temporary, 'ssh');
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/ssh -F ${shellQuote(config)} "$@"\n`, {
    mode: 0o700,
  });
  sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', serverConfig], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  sshd.stderr!.on('data', (chunk) => (output += String(chunk)));
  if (!(await waitForTcp(port, 5000))) throw new Error('Loopback sshd failed: ' + output);
  daemon = await startDaemon({ home: hostHome, port: 0, adapters: [], version: 'ssh-fixture' });
  mkdirSync(join(hostHome, 'bin/current/bin'), { recursive: true });
  symlinkSync(process.execPath, join(hostHome, 'bin/current/bin/node'));
});
afterAll(async () => {
  legacy?.closeAllConnections();
  await new Promise<void>((resolve) => (legacy ? legacy.close(() => resolve()) : resolve()));
  await daemon?.stop();
  sshd?.kill('SIGTERM');
  if (previousHome === undefined) delete process.env.PUDDLE_HOME;
  else process.env.PUDDLE_HOME = previousHome;
});

describe.each(['darwin', 'win32'] as const)('real OpenSSH with platform=%s', (platform) => {
  it('keeps independent leases over shared and dedicated SSH connections', async () => {
    const transport = new SshTransport('fixture', { sshBinary: wrapper, platform });
    await transport.open();
    const first = await acquireAuthority(transport);
    const second = await acquireAuthority(transport);
    const tunnel = await openTunnel(transport, daemon!.port, { sshBinary: wrapper });
    try {
      const a = new DaemonClient(tunnel.localPort, first);
      const b = new DaemonClient(tunnel.localPort, second);
      expect((await a.version()).version).toBe('ssh-fixture');
      const stolen = first.credential();
      first.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        (
          await fetch(`http://127.0.0.1:${daemon!.port}/api/version`, {
            headers: { authorization: `Bearer ${stolen}` },
          })
        ).status,
      ).toBe(401);
      expect((await b.version()).version).toBe('ssh-fixture');
      expect(output).not.toContain(second.credential());
    } finally {
      first.close();
      second.close();
      await tunnel.close();
      transport.dispose();
    }
  });
});

it('inspects legacy credentials only inside the remote helper', async () => {
  await daemon!.stop();
  // Prevent the afterAll cleanup from closing the same database a second time.
  daemon = undefined;
  const master = 'd'.repeat(64);
  legacy = createServer((req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${master}`);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/version' ? { version: '0.1.13', protocol: { major: 17, minor: 3 } } : [],
      ),
    );
  });
  const port = await new Promise<number>((resolve) =>
    legacy!.listen(0, '127.0.0.1', () => resolve((legacy!.address() as { port: number }).port)),
  );
  writeFileSync(join(hostHome, 'token'), master + '\n', { mode: 0o600 });
  writeFileSync(join(hostHome, 'runtime.json'), JSON.stringify({ port }));
  const transport = new SshTransport('fixture', { sshBinary: wrapper });
  const result = await inspectHost(transport);
  expect(result).toMatchObject({
    t: 'inspection',
    liveSessions: 0,
    version: { protocol: { major: 17 } },
  });
  expect(JSON.stringify(result)).not.toContain(master);
  expect(output).not.toContain(master);
});

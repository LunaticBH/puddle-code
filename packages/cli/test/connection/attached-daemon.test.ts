import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachedDaemon } from '../../src/lib/connection/attached-daemon.js';
import { findFreePort } from '../../src/lib/transport/net.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';

const FAKE_SSH = join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'fake-ssh.mjs');

// The fake ssh runs the remote POSIX host's sh commands on this machine, and
// SSH hosts are POSIX by definition (Windows hosts are refused, see
// windows-host.test.ts), so this cannot run on a Windows test machine.
describe.skipIf(process.platform === 'win32')('SSH-attached daemon', () => {
  const clientHome = mkdtempSync(join(tmpdir(), 'puddle-attached-client-'));
  const hostHome = mkdtempSync(join(tmpdir(), 'puddle-attached-host-'));
  const puddleHome = join(hostHome, '.puddle');
  let attached: AttachedDaemon;

  beforeAll(async () => {
    chmodSync(FAKE_SSH, 0o755);
    process.env.PUDDLE_HOME = join(clientHome, '.puddle');
    process.env.FAKE_SSH_HOME = hostHome;
    const port = await findFreePort();
    mkdirSync(puddleHome, { recursive: true, mode: 0o700 });
    mkdirSync(join(puddleHome, 'bin', 'versions', 'test'), { recursive: true });
    mkdirSync(join(puddleHome, 'logs'), { recursive: true });
    writeFileSync(join(puddleHome, 'saved-note'), 'durable-state');
    writeFileSync(join(puddleHome, 'config.json'), `${JSON.stringify({ port })}\n`);

    const serverFile = join(hostHome, 'fake-puddled.mjs');
    writeFileSync(
      serverFile,
      `import { startDaemon } from ${JSON.stringify(fileURLToPath(new URL('../../../daemon/dist/daemon.js', import.meta.url)))};
const args = process.argv.slice(2);
const at = args.indexOf('--port');
const daemon = await startDaemon({home: process.env.PUDDLE_HOME, ...(at === -1 ? {} : {port:Number(args[at+1])}), adapters:[], version:'test'});
let stopping = false;
const stop = () => { if (stopping) return; stopping=true; void daemon.stop().then(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGHUP', stop);
`,
    );
    const launcher = join(puddleHome, 'bin', 'versions', 'test', 'puddled');
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${serverFile}" "$@"\n`);
    chmodSync(launcher, 0o755);
    mkdirSync(join(puddleHome, 'bin', 'versions', 'test', 'bin'));
    symlinkSync(process.execPath, join(puddleHome, 'bin', 'versions', 'test', 'bin', 'node'));
    symlinkSync('versions/test', join(puddleHome, 'bin', 'current'));

    const ssh = new SshTransport('alice@devbox', {
      platform: 'darwin',
      sshBinary: FAKE_SSH,
    });
    attached = new AttachedDaemon(ssh);
  });

  afterAll(async () => {
    await attached?.stop();
    delete process.env.PUDDLE_HOME;
    delete process.env.FAKE_SSH_HOME;
  });

  // A full workspace run can briefly starve the fake SSH subprocesses on CI.
  it('restarts with the cockpit while leaving host data intact', async () => {
    const endpoint = await attached.start();
    expect(endpoint.daemonLifetime).toBe('cockpit');
    expect(existsSync(join(puddleHome, 'runtime.json'))).toBe(true);
    expect(existsSync(join(puddleHome, 'puddled.pid'))).toBe(true);
    expect(readFileSync(join(puddleHome, 'saved-note'), 'utf8')).toBe('durable-state');

    endpoint.authority.close();
    await endpoint.lease?.stop();
    expect(existsSync(join(puddleHome, 'runtime.json'))).toBe(false);
    expect(existsSync(join(puddleHome, 'puddled.pid'))).toBe(false);
    expect(readFileSync(join(puddleHome, 'saved-note'), 'utf8')).toBe('durable-state');

    await endpoint.lease?.ensureRunning();
    expect(existsSync(join(puddleHome, 'runtime.json'))).toBe(true);
    expect(readFileSync(join(puddleHome, 'saved-note'), 'utf8')).toBe('durable-state');
  }, 60_000);
});

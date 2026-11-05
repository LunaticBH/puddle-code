import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFakeExecutable } from '../../daemon/test/helpers/fake-executable.js';
import { connectRemote } from '../src/lib/connection/connect.js';
import type { RunningCockpit } from '../src/lib/connection/cockpit.js';
import { removeDaemon } from '../src/lib/installation/remove-daemon.js';
import { showLogs } from '../src/lib/logs.js';
import { SshTransport } from '../src/lib/transport/ssh.js';
import { psQuote } from '../src/lib/transport/windows-remote.js';

/**
 * A real Windows OpenSSH server (docs/windows.md), only when one is named:
 *
 *   PUDDLE_TEST_WINDOWS_SSH=user@host           the account to log on as
 *   PUDDLE_TEST_WINDOWS_SSH_KEY=<file>          its private key (key auth only)
 *   PUDDLE_TEST_WINDOWS_SSH_TARBALL=<zip>       puddled-v<V>-win32-<arch>.zip
 *
 * Everything happens in a home of its own on the host,
 * `%USERPROFILE%\.puddle-test-<random>`, which every connection names
 * through the CLI's test seam (SshTransport's windowsHome), so the
 * account's own `.puddle` is never touched. The test removes that home with
 * `remove --purge` (which also unregisters its scheduled task), then
 * unregisters any task still naming it and deletes what is left, whether
 * or not the test passed.
 */
const target = process.env.PUDDLE_TEST_WINDOWS_SSH;
const key = process.env.PUDDLE_TEST_WINDOWS_SSH_KEY;
const tarball = process.env.PUDDLE_TEST_WINDOWS_SSH_TARBALL;
const configured = !!target && !!key && !!tarball;

describe.runIf(configured)('a real Windows OpenSSH host', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'puddle-windows-ssh-'));
  const previousHome = process.env.PUDDLE_HOME;
  let ssh: string;
  let home: string;
  let cockpit: RunningCockpit | undefined;
  const transport = (opts: { remotePlatform?: 'win32' } = {}) =>
    new SshTransport(target!, { sshBinary: ssh, batchMode: true, windowsHome: home, ...opts });

  beforeAll(async () => {
    process.env.PUDDLE_HOME = join(temporary, 'client');
    if (!existsSync(tarball!))
      throw new Error(`PUDDLE_TEST_WINDOWS_SSH_TARBALL: ${tarball} is missing`);
    // The system ssh with the test key, prompting for nothing.
    const extra = [
      '-i',
      key!,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${join(temporary, 'known_hosts')}`,
    ];
    ssh = writeFakeExecutable(
      join(temporary, 'bin'),
      'ssh',
      `import { spawn } from 'node:child_process';
const child = spawn('ssh', [...${JSON.stringify(extra)}, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 255));
`,
    );
    // Recognise the host and choose a home beside the account's own.
    const probeOnly = new SshTransport(target!, { sshBinary: ssh, batchMode: true });
    await probeOnly.open();
    expect(probeOnly.remotePlatform).toBe('win32');
    const probe = await probeOnly.windowsProbe();
    home = win32.join(win32.dirname(probe.home), `.puddle-test-${randomBytes(6).toString('hex')}`);
  }, 120_000);

  afterAll(async () => {
    await cockpit?.stop().catch(() => undefined);
    try {
      if (home !== undefined) {
        await removeDaemon(transport({ remotePlatform: 'win32' }), { purge: true }).catch(
          () => undefined,
        );
        // Whatever the removal left: the home's task and its files.
        await transport({ remotePlatform: 'win32' }).execWindows(
          String.raw`$home_ = ${psQuote(home)}
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { @($_.Actions | ForEach-Object { $_.Arguments }) -join ' ' -like ('*' + $home_ + '*') } | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $home_ -Recurse -Force -ErrorAction SilentlyContinue`,
          { timeoutMs: 120_000 },
        );
      }
    } finally {
      if (previousHome === undefined) delete process.env.PUDDLE_HOME;
      else process.env.PUDDLE_HOME = previousHome;
    }
  }, 300_000);

  it('launches a cockpit on it, reads its logs, and removes it with its home', async () => {
    const assets = mkdtempSync(join(temporary, 'assets-'));
    writeFileSync(join(assets, 'index.html'), '<!doctype html><title>puddle</title>');
    cockpit = await connectRemote({
      host: target!,
      assetsDir: assets,
      tarball: tarball!,
      noUpgrade: true,
      sshBinary: ssh,
      sshBatchMode: true,
      sshWindowsHome: home,
    });
    const invite = new URLSearchParams(new URL(cockpit.createInvitation()).hash.slice(1)).get(
      'invite',
    );
    const bootstrap = await fetch(`${cockpit.origin}/cockpit/bootstrap`, {
      method: 'POST',
      headers: { origin: cockpit.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ invitation: invite }),
    });
    const { credential } = (await bootstrap.json()) as { credential: string };
    const hostInfo = (await (
      await fetch(`${cockpit.origin}/api/host`, {
        headers: { origin: cockpit.origin, authorization: `Bearer ${credential}` },
      })
    ).json()) as { platform?: string };
    expect(hostInfo.platform).toBe('win32');
    expect(tarball).toContain(`puddled-v${cockpit.daemon.version}-win32-`);

    let logs = '';
    await showLogs(transport({ remotePlatform: 'win32' }), { write: (text) => (logs += text) });
    expect(logs).toContain('puddled');

    await cockpit.stop();
    cockpit = undefined;
    await removeDaemon(transport({ remotePlatform: 'win32' }), { purge: true });
    const left = await transport({ remotePlatform: 'win32' }).execWindows(
      `if (Test-Path -LiteralPath ${psQuote(home)}) { $global:PuddleExit = 1 }`,
      { timeoutMs: 60_000 },
    );
    expect(left.code).toBe(0);
  }, 900_000);
});

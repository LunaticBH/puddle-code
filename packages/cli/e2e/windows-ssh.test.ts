import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, onTestFailed } from 'vitest';
import { killProcessTree, listWindowsProcesses } from '@puddle/shared/node/platform';
import { controlPipePresent, stopWindowsDaemon } from '../src/lib/installation/windows-daemon.js';
import { windowsRemoteCommand } from '../src/lib/transport/windows-remote.js';
import { fakeWindowsSshBinary } from '../test/helpers/fake-ssh.js';
import { root, stop, until } from './helpers.js';

/**
 * `puddle launch user@winhost --tarball <zip>` end to end through the fake
 * Windows OpenSSH server (test/helpers/fake-windows-ssh.mjs), whose "host"
 * is this machine's cmd.exe, PowerShell or Git Bash with a temporary
 * profile and Windows' default PATH, against the daemon zip `pnpm
 * build:tarball` built: detection, bootstrap, the supervisor's start, the
 * control channel, the tunnel, the API, logs, kill and remove --purge. Task
 * Scheduler is never asked: the host helper's PUDDLE_TEST_WINDOWS_SUPERVISION
 * seam holds for a home in the host's temporary directory, so each host's
 * home lies there. The supervisor starts through WMI, in that home only, or
 * the daemon stays attached to the cockpit.
 */

const release = join(root, 'dist-release');
const zip = existsSync(release)
  ? readdirSync(release)
      .filter((name) => /^puddled-v[^-]+-win32-[a-z0-9]+\.zip$/.test(name))
      .map((name) => join(release, name))[0]
  : undefined;
const cli = resolve(root, 'packages/cli/dist/index.js');
const helper = resolve(root, 'packages/cli/dist/windows-host.mjs');
const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');

// CI builds the zip first; there, a missing zip must fail rather than skip.
it.runIf(process.platform === 'win32' && process.env.CI !== undefined)(
  'has a Windows daemon zip and host helper to test with',
  () => {
    expect(zip).toBeDefined();
    expect(existsSync(helper)).toBe(true);
  },
);

describe.runIf(process.platform === 'win32' && zip !== undefined && existsSync(helper))(
  'SSH to a Windows host, through a fake Windows OpenSSH server',
  () => {
    const base = mkdtempSync(join(tmpdir(), 'puddle-winssh-e2e-'));
    const bin = join(base, 'bin');
    fakeWindowsSshBinary(bin);
    const running: ChildProcess[] = [];
    const homes: string[] = [];

    afterAll(async () => {
      for (const child of running) await stop(child).catch(() => undefined);
      // Nothing may outlive the test: every process under its temporary tree goes.
      for (const home of homes) await stopWindowsDaemon(home).catch(() => undefined);
      const marker = base.toLowerCase();
      const leftovers = (await listWindowsProcesses()).filter((p) =>
        p.commandLine?.toLowerCase().includes(marker),
      );
      for (const p of leftovers) await killProcessTree(p.pid, { platform: 'win32' });
      // Best effort: the release zip each host received is large.
      try {
        rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // A file Defender still scans; the OS's temporary clean-up takes it.
      }
    }, 120_000);

    /** One client home and one Windows "host" profile, its home in its temporary directory. */
    function setup(shell: 'cmd' | 'powershell' | 'bash', supervision: 'wmi' | 'session') {
      const profile = mkdtempSync(join(base, 'host-'));
      const home = join(profile, 'AppData', 'Local', 'Temp', 'puddle-test-home');
      homes.push(home);
      const client = join(mkdtempSync(join(base, 'client-')), '.puddle');
      const log = join(base, `${profile.split(/[\\/]/).pop()}.ssh.log`);
      const env: NodeJS.ProcessEnv = {
        // The client's own PATH, Git's Unix tools and all: the host never sees it.
        PATH: `${bin};${process.env.PATH}`,
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec,
        PATHEXT: process.env.PATHEXT,
        ProgramFiles: process.env.ProgramFiles,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA,
        PUDDLE_HOME: client,
        FAKE_WINDOWS_SSH_HOME: profile,
        FAKE_WINDOWS_SSH_PUDDLE_HOME: home,
        FAKE_WINDOWS_SSH_SHELL: shell,
        FAKE_WINDOWS_SSH_BASH: gitBash,
        FAKE_WINDOWS_SSH_LOG: log,
        PUDDLE_TEST_WINDOWS_SUPERVISION: supervision,
      };
      const outputs: Array<{ args: string[]; output: () => string }> = [];
      // What the client and the host said, for a failure's report.
      onTestFailed(() => {
        for (const { args, output } of outputs) {
          console.error(`--- puddle ${args.join(' ')}\n${output()}`);
        }
        const logs = join(home, 'logs');
        for (const name of existsSync(logs) ? readdirSync(logs) : []) {
          if (!name.endsWith('.log')) continue;
          console.error(`--- ${name}\n${readFileSync(join(logs, name), 'utf8').slice(-4000)}`);
        }
      });
      const puddle = (...args: string[]) => {
        const child = spawn(process.execPath, [cli, ...args], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        running.push(child);
        let output = '';
        child.stdout!.on('data', (c) => (output += String(c)));
        child.stderr!.on('data', (c) => (output += String(c)));
        outputs.push({ args, output: () => output });
        const exited = new Promise<number | null>((done) => child.once('exit', done));
        return { child, output: () => output, exited };
      };
      const sent = () =>
        readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as { command?: string; forward?: string; scp?: boolean });
      return { home, puddle, sent };
    }

    async function launch(host: ReturnType<typeof setup>) {
      const cockpit = host.puddle(
        'launch',
        'alice@winhost',
        '--foreground',
        '--no-browser',
        '--no-upgrade',
        '--tarball',
        zip!,
      );
      const ready = await until(
        () =>
          /Puddle cockpit at (http:\/\/localhost:\d+)[\s\S]*#invite=(iv_[a-f0-9]{64})/.exec(
            cockpit.output(),
          ),
        (match) => match !== null || cockpit.child.exitCode !== null,
        180_000,
      );
      if (!ready) throw new Error(`the cockpit did not start:\n${cockpit.output()}`);
      const [, origin, invitation] = ready;
      const response = await fetch(`${origin}/cockpit/bootstrap`, {
        method: 'POST',
        headers: { origin: origin!, 'content-type': 'application/json' },
        body: JSON.stringify({ invitation }),
      });
      expect(response.status).toBe(200);
      const { credential } = (await response.json()) as { credential: string };
      const api = (path: string) =>
        fetch(`${origin}${path}`, {
          headers: { origin: origin!, authorization: `Bearer ${credential}` },
        });
      return { cockpit, api };
    }

    /** Kill the cockpit, leaving its WMI-started daemon running, then remove it all. */
    async function killAndPurge(
      host: ReturnType<typeof setup>,
      cockpit: { exited: Promise<unknown> },
    ) {
      const kill = host.puddle('kill', 'alice@winhost');
      expect(await kill.exited, kill.output()).toBe(0);
      await cockpit.exited;
      // WMI started the supervisor outside the session: the daemon outlives the cockpit.
      expect(await controlPipePresent(host.home)).toBe(true);

      const remove = host.puddle('remove', 'daemon', 'alice@winhost', '--yes', '--purge');
      expect(await remove.exited, remove.output()).toBe(0);
      expect(remove.output()).toContain('%USERPROFILE%\\.puddle deleted');
      expect(existsSync(host.home)).toBe(false);
      const marker = host.home.toLowerCase();
      expect(
        (await listWindowsProcesses()).filter((p) => p.commandLine?.toLowerCase().includes(marker)),
      ).toEqual([]);
    }

    it('bootstraps, supervises through WMI, serves, logs, keeps running after kill, and purges', async () => {
      const host = setup('cmd', 'wmi');
      const { cockpit, api } = await launch(host);

      // Detection: POSIX `true` first, then a single PowerShell probe; afterwards
      // the host receives PowerShell operations and the tunnel only.
      const sent = host.sent();
      expect(sent[0]!.command).toBe('true');
      expect(sent[1]!.command).toBe(windowsRemoteCommand());
      expect(
        sent.every(
          (s, i) => i === 0 || s.forward !== undefined || s.command === windowsRemoteCommand(),
        ),
      ).toBe(true);
      expect(sent.some((s) => /^\d+:127\.0\.0\.1:\d+$/.test(s.forward ?? ''))).toBe(true);
      expect(cockpit.output()).toContain('(supervisor: detached)');

      const version = (await (await api('/api/version')).json()) as { version: string };
      expect(zip).toContain(`puddled-v${version.version}-win32-`);
      const hostInfo = (await (await api('/api/host')).json()) as { platform?: string };
      expect(hostInfo.platform).toBe('win32');

      const logs = host.puddle('logs', 'alice@winhost');
      expect(await logs.exited, logs.output()).toBe(0);
      expect(logs.output()).toContain('puddled.out.log');

      await killAndPurge(host, cockpit);
    }, 300_000);

    it('keeps the daemon attached to the cockpit where nothing can start it outside the session', async () => {
      const host = setup('powershell', 'session');
      const { cockpit, api } = await launch(host);
      expect(cockpit.output()).toContain('keeping it attached to this cockpit');
      expect((await api('/api/version')).status).toBe(200);

      const kill = host.puddle('kill', 'alice@winhost');
      expect(await kill.exited, kill.output()).toBe(0);
      await cockpit.exited;
      // The lease stopped its own daemon cleanly before closing its channel.
      const marker = join(host.home, 'bin').toLowerCase();
      await until(
        async () =>
          (await listWindowsProcesses()).filter((p) =>
            p.commandLine?.toLowerCase().includes(marker),
          ),
        (left) => left.length === 0,
        30_000,
      );
      expect(existsSync(join(host.home, 'runtime.json'))).toBe(false);
    }, 300_000);

    // OpenSSH's DefaultShell set to Git Bash: POSIX `true` passes, so the host
    // gives itself away only when a POSIX command reaches Windows' own tools.
    it.runIf(existsSync(gitBash))(
      'recognises a host whose default shell is Git Bash and drives it through PowerShell',
      async () => {
        const host = setup('bash', 'wmi');
        const { cockpit, api } = await launch(host);

        const sent = host.sent();
        expect(sent[0]!.command).toBe('true');
        const first = sent.findIndex((s) => s.command === windowsRemoteCommand());
        expect(first).toBeGreaterThan(1);
        // Once recognised, never another POSIX command.
        expect(
          sent
            .slice(first)
            .every((s) => s.forward !== undefined || s.command === windowsRemoteCommand()),
        ).toBe(true);
        expect(cockpit.output()).toContain('(supervisor: detached)');
        const hostInfo = (await (await api('/api/host')).json()) as { platform?: string };
        expect(hostInfo.platform).toBe('win32');

        await killAndPurge(host, cockpit);
      },
      300_000,
    );
  },
);

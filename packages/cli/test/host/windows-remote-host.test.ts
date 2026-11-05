import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RemoteWindowsHost } from '../../src/lib/host/windows-remote-host.js';
import { errorMessage, helperError } from '../../src/lib/host/windows-host-protocol.js';
import { CliError } from '../../src/lib/types.js';
import type { SshTransport, WindowsExecOptions } from '../../src/lib/transport/ssh.js';
import {
  HELPER_MISSING_EXIT,
  NO_RUNTIME_EXIT,
  type WindowsProbe,
} from '../../src/lib/transport/windows-remote.js';

/**
 * The client of a Windows SSH host (host/windows-remote-host.ts) against a
 * scripted transport: which script each operation sends, and how the
 * helper's JSON lines come back as results, logs and CliErrors.
 */

interface Sent {
  script: string;
  payload: unknown;
}

function fakeSsh(
  answer: (script: string) => {
    code: number;
    lines?: object[];
    stdout?: string;
    stderr?: string;
    incomplete?: true;
  },
  probe: Partial<WindowsProbe> = {},
) {
  const sent: Sent[] = [];
  const probes = { count: 0 };
  const ssh = {
    label: 'alice@winbox',
    remotePlatform: 'win32',
    windowsProbe: async () => {
      probes.count++;
      return {
        home: 'C:\\Users\\alice\\.puddle',
        current: null,
        node: null,
        arch: 'x64',
        build: 26200,
        elevated: false,
        temp: 'C:\\Users\\alice\\AppData\\Local\\Temp\\',
        ...probe,
      };
    },
    async execWindows(script: string, opts: WindowsExecOptions = {}) {
      let payload: unknown = opts.payload;
      if (payload instanceof Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) chunks.push(chunk as Buffer);
        payload = Buffer.concat(chunks);
      }
      sent.push({ script, payload });
      if (script.includes('Receive-PuddlePayload $tmp')) {
        return { code: 0, stdout: '{"path":"C:\\\\T\\\\windows-host-1.mjs"}\r\n', stderr: '' };
      }
      const reply = answer(script);
      const stdout =
        reply.stdout ?? (reply.lines ?? []).map((l) => JSON.stringify(l) + '\n').join('');
      opts.onStdout?.(stdout);
      return {
        code: reply.code,
        stdout,
        stderr: reply.stderr ?? '',
        ...(reply.incomplete ? { incomplete: true } : {}),
      };
    },
  };
  return { ssh: ssh as unknown as SshTransport, sent, probes };
}

const opOf = (script: string) => /@\(\$helper, '([a-z-]+)'/.exec(script)?.[1];
const requestOf = (script: string, op: string) =>
  JSON.parse(
    Buffer.from(new RegExp(`'${op}', '([A-Za-z0-9+/=]+)'`).exec(script)![1]!, 'base64').toString(),
  ) as unknown;

describe('a Windows SSH host’s client', () => {
  it('stages the helper once per transport and restages one that %TEMP% clean-up removed', async () => {
    let missing = true;
    const { ssh, sent } = fakeSsh((script) => {
      if (opOf(script) === 'pipe' && missing) {
        missing = false;
        return { code: HELPER_MISSING_EXIT };
      }
      return { code: 0, lines: [{ t: 'result', value: 'daemon' }] };
    });
    const host = new RemoteWindowsHost(ssh);
    expect(await host.run('pipe', {})).toBe('daemon');
    expect(await host.run('pipe', {})).toBe('daemon');
    const stages = sent.filter((s) => s.script.includes('Receive-PuddlePayload $tmp'));
    expect(stages).toHaveLength(2);
    // The helper travels as the stage's payload, by its own digest.
    expect(Buffer.isBuffer(stages[0]!.payload)).toBe(true);
    expect(stages[0]!.script).toContain(
      createHash('sha256')
        .update(stages[0]!.payload as Buffer)
        .digest('hex')
        .toUpperCase(),
    );
  });

  it('relays log lines and output, and raises the helper’s own CliError', async () => {
    const { ssh } = fakeSsh(() => ({
      code: 1,
      lines: [
        { t: 'out', text: 'line one\n' },
        { t: 'log', level: 'warn', message: 'careful' },
        { t: 'error', code: 'unknown_session', message: 'no log at x', hint: 'puddle status' },
      ],
    }));
    const written: string[] = [];
    const warned: string[] = [];
    const host = new RemoteWindowsHost(ssh);
    await expect(
      host.run(
        'logs',
        {},
        { onOut: (t) => written.push(t), logger: { info() {}, warn: (m) => warned.push(m) } },
      ),
    ).rejects.toMatchObject({ code: 'unknown_session', hint: 'puddle status' });
    expect(written).toEqual(['line one\n']);
    expect(warned).toEqual(['careful']);
  });

  it('reports a helper that answered nothing with its status', async () => {
    const { ssh } = fakeSsh(() => ({ code: 5, stdout: 'garbage' }));
    await expect(new RemoteWindowsHost(ssh).run('sweep', {})).rejects.toMatchObject({
      code: 'not_installed',
      message: 'the sweep operation failed on alice@winbox (exit 5)',
    });
    const empty = fakeSsh(() => ({ code: NO_RUNTIME_EXIT }));
    await expect(new RemoteWindowsHost(empty.ssh).run('sweep', {})).rejects.toMatchObject({
      code: 'not_installed',
      message: 'no Puddle runtime is installed on alice@winbox',
    });
  });

  it('reports a connection that ended mid-operation as unreachable, never as not installed', async () => {
    // ssh's own 255, or a timeout's kill: no trailer, so nothing the helper said.
    for (const code of [255, -1]) {
      const { ssh } = fakeSsh(() => ({
        code,
        stderr: 'Connection to winbox closed by remote host.',
        incomplete: true,
      }));
      await expect(
        new RemoteWindowsHost(ssh).run('install', { version: '1.2.3' }),
      ).rejects.toMatchObject({
        code: 'ssh_unreachable',
        message: `the SSH connection to alice@winbox ended during the install operation (exit ${code})`,
        hint: 'Connection to winbox closed by remote host.',
      });
    }
  });

  it('keeps a failure the host did not foresee a plain error, as on a local host', async () => {
    const { ssh } = fakeSsh(() => ({
      code: 1,
      lines: [{ t: 'error', code: 'unexpected', message: 'EBUSY: resource busy or locked' }],
    }));
    const failure = await new RemoteWindowsHost(ssh)
      .run('install', {})
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CliError);
    expect((failure as Error).message).toBe('EBUSY: resource busy or locked');
    // What the helper sends for such a failure, and what the client makes of it.
    const sent = errorMessage(new Error('EBUSY: resource busy or locked'));
    expect(helperError(sent)).not.toBeInstanceOf(CliError);
    expect(helperError(errorMessage(new CliError('not_installed', 'no tree')))).toMatchObject({
      code: 'not_installed',
    });
  });

  it('reads the installed version from the probe, refusing another architecture’s tree', async () => {
    const current = 'C:\\Users\\alice\\.puddle\\bin\\versions\\0.3.14\\';
    expect(
      await new RemoteWindowsHost(
        fakeSsh(() => ({ code: 0 }), { current, node: 'x64' }).ssh,
      ).installedVersion(),
    ).toBe('0.3.14');
    expect(
      await new RemoteWindowsHost(
        fakeSsh(() => ({ code: 0 }), { current, node: 'x64', arch: 'arm64' }).ssh,
      ).installedVersion(),
    ).toBeNull();
  });

  it('still finds a tree of another architecture, for removal, upgrades and sweeps', async () => {
    const current = 'C:\\Users\\alice\\.puddle\\bin\\versions\\0.3.14\\';
    expect(
      await new RemoteWindowsHost(
        fakeSsh(() => ({ code: 0 }), { current, node: 'x64', arch: 'arm64' }).ssh,
      ).presentVersion(),
    ).toBe('0.3.14');
    expect(await new RemoteWindowsHost(fakeSsh(() => ({ code: 0 })).ssh).presentVersion()).toBe(
      null,
    );
  });

  it('asks the pipe of a tree of another architecture, whose daemon still runs', async () => {
    const { ssh, sent } = fakeSsh(() => ({ code: 0, lines: [{ t: 'result', value: 'daemon' }] }), {
      current: 'C:\\h\\bin\\versions\\0.3.14',
      node: 'x64',
      arch: 'arm64',
    });
    expect(await new RemoteWindowsHost(ssh).pipePresent()).toBe(true);
    expect(sent.some((s) => opOf(s.script) === 'pipe')).toBe(true);
    // No runtime at all: nothing can hold the pipe, and no helper runs.
    const empty = fakeSsh(() => ({ code: 0 }));
    expect(await new RemoteWindowsHost(empty.ssh).pipePresent()).toBe(false);
    expect(empty.sent).toEqual([]);
  });

  it('sweeps a tree of another architecture too', async () => {
    const { ssh, sent } = fakeSsh(
      () => ({ code: 0, lines: [{ t: 'result', value: ['C:\\h\\worktrees\\r\\w'] }] }),
      { current: 'C:\\h\\bin\\versions\\0.3.14', node: 'x64', arch: 'arm64' },
    );
    expect(await new RemoteWindowsHost(ssh).sweep()).toEqual(['C:\\h\\worktrees\\r\\w']);
    expect(sent.some((s) => opOf(s.script) === 'sweep')).toBe(true);
  });

  it('stops an attached lease’s daemon by its pid only', async () => {
    const { ssh, sent } = fakeSsh(() => ({
      code: 0,
      lines: [{ t: 'result', value: 'stopped' }],
    }));
    expect(await new RemoteWindowsHost(ssh).stopDaemon(4242)).toBe('stopped');
    const stop = sent.find((s) => opOf(s.script) === 'stop-daemon')!;
    expect(requestOf(stop.script, 'stop-daemon')).toEqual({ pid: 4242 });
  });

  it('answers a remote access status poll with one helper run and no probe', async () => {
    const { ssh, sent, probes } = fakeSsh(() => ({
      code: 0,
      lines: [{ t: 'result', value: { installed: true, version: '0.3.14' } }],
    }));
    expect(await new RemoteWindowsHost(ssh).connectorInstalled()).toEqual({
      installed: true,
      version: '0.3.14',
    });
    expect(probes.count).toBe(0);
    expect(sent.filter((s) => opOf(s.script) !== undefined)).toHaveLength(1);
    // A home with no runtime has no connector.
    const empty = fakeSsh(() => ({ code: NO_RUNTIME_EXIT }));
    expect(await new RemoteWindowsHost(empty.ssh).connectorInstalled()).toEqual({
      installed: false,
      version: null,
    });
  });

  it('installs with a copy of the installed runtime, naming the release and its repository', async () => {
    const saved = process.env.PUDDLE_REPO;
    process.env.PUDDLE_REPO = 'acme/puddle';
    try {
      const { ssh, sent } = fakeSsh(() => ({ code: 0, lines: [{ t: 'result', value: {} }] }), {
        current: 'C:\\h\\bin\\versions\\0.3.13',
        node: 'x64',
      });
      await new RemoteWindowsHost(ssh).install({ version: '0.3.14', replaceRunning: false });
      const install = sent.find((s) => opOf(s.script) === 'install')!;
      expect(install.script).toContain("if ('copy' -eq 'copy')");
      expect(requestOf(install.script, 'install')).toEqual({
        version: '0.3.14',
        replaceRunning: false,
        slug: 'acme/puddle',
      });
    } finally {
      if (saved === undefined) delete process.env.PUDDLE_REPO;
      else process.env.PUDDLE_REPO = saved;
    }
  });

  it('warns of an elevated daemon only when WMI started it from an elevated session', async () => {
    const warnings = async (started: string, elevated: boolean) => {
      const { ssh } = fakeSsh(() => ({ code: 0, lines: [{ t: 'result', value: { started } }] }), {
        current: 'C:\\h\\bin\\versions\\0.3.13',
        node: 'x64',
        elevated,
      });
      const warned: string[] = [];
      await new RemoteWindowsHost(ssh).install({
        version: '0.3.14',
        logger: { info() {}, warn: (m) => warned.push(m) },
      });
      return warned;
    };
    expect((await warnings('process', true)).join('\n')).toContain('runs elevated');
    // The logon task runs without elevation, and one already running was not started here.
    expect(await warnings('task', true)).toEqual([]);
    expect(await warnings('running', true)).toEqual([]);
    expect(await warnings('process', false)).toEqual([]);
  });

  it('bootstraps a host with no runtime of its architecture by download', async () => {
    const saved = process.env.PUDDLE_REPO;
    process.env.PUDDLE_REPO = 'acme/puddle';
    try {
      const { ssh, sent } = fakeSsh(() => ({ code: 0, lines: [{ t: 'result' }] }), {
        current: 'C:\\h\\bin\\versions\\0.3.14',
        node: 'x64',
        arch: 'arm64',
      });
      await new RemoteWindowsHost(ssh).install({ version: '0.3.14' });
      const boot = sent.at(-1)!;
      expect(boot.script).toContain("Join-Path $system 'curl.exe'");
      expect(boot.script).toContain('https://github.com/acme/puddle/releases/download/v0.3.14/');
      expect(boot.payload).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PUDDLE_REPO;
      else process.env.PUDDLE_REPO = saved;
    }
  });

  it('streams a local archive after the script, checked against its .sha256', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-remote-zip-'));
    const zip = join(dir, 'puddled-v1.2.3-win32-x64.zip');
    writeFileSync(zip, 'archive bytes');
    const digest = createHash('sha256').update('archive bytes').digest('hex');
    writeFileSync(`${zip}.sha256`, `${digest}  puddled-v1.2.3-win32-x64.zip\n`);
    const { ssh, sent } = fakeSsh(() => ({ code: 0, lines: [{ t: 'result' }] }));
    await new RemoteWindowsHost(ssh).install({ tarball: zip });
    const boot = sent.at(-1)!;
    expect(String(boot.payload)).toBe('archive bytes');
    expect(boot.script).toContain(`Receive-PuddlePayload (Join-Path $work $name) 13`);
    expect(boot.script).toContain(digest.toUpperCase());
    // An authentic sum is written beside the archive for the installer to check again.
    expect(boot.script).toContain(`${digest}  puddled-v1.2.3-win32-x64.zip`);

    writeFileSync(`${zip}.sha256`, `${'0'.repeat(64)}  puddled-v1.2.3-win32-x64.zip\n`);
    await expect(new RemoteWindowsHost(ssh).install({ tarball: zip })).rejects.toThrow(
      'checksum mismatch',
    );
    await expect(
      new RemoteWindowsHost(ssh).install({ tarball: join(dir, 'puddled.zip') }),
    ).rejects.toMatchObject({ code: 'not_installed' });
  });
});

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RemoteWindowsHost } from '../../src/lib/host/windows-remote-host.js';
import type { SshTransport, WindowsExecOptions } from '../../src/lib/transport/ssh.js';
import { HELPER_MISSING_EXIT, type WindowsProbe } from '../../src/lib/transport/windows-remote.js';

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
  answer: (script: string) => { code: number; lines?: object[]; stdout?: string },
  probe: Partial<WindowsProbe> = {},
) {
  const sent: Sent[] = [];
  const ssh = {
    label: 'alice@winbox',
    remotePlatform: 'win32',
    windowsProbe: async () => ({
      home: 'C:\\Users\\alice\\.puddle',
      current: null,
      node: null,
      arch: 'x64',
      build: 26200,
      elevated: false,
      temp: 'C:\\Users\\alice\\AppData\\Local\\Temp\\',
      ...probe,
    }),
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
      return { code: reply.code, stdout, stderr: '' };
    },
  };
  return { ssh: ssh as unknown as SshTransport, sent };
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
    await expect(new RemoteWindowsHost(ssh).run('stop', {})).rejects.toMatchObject({
      code: 'not_installed',
      message: 'the stop operation failed on alice@winbox (exit 5)',
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

  it('installs with a copy of the installed runtime, naming the release and its repository', async () => {
    const saved = process.env.PUDDLE_REPO;
    process.env.PUDDLE_REPO = 'acme/puddle';
    try {
      const { ssh, sent } = fakeSsh(() => ({ code: 0, lines: [{ t: 'result' }] }), {
        current: 'C:\\h\\bin\\versions\\0.3.13',
        node: 'x64',
        elevated: true,
      });
      const warned: string[] = [];
      await new RemoteWindowsHost(ssh).install({
        version: '0.3.14',
        replaceRunning: false,
        logger: { info() {}, warn: (m) => warned.push(m) },
      });
      const install = sent.find((s) => opOf(s.script) === 'install')!;
      expect(install.script).toContain("if ('copy' -eq 'copy')");
      const request = /'install', '([A-Za-z0-9+/=]+)'/.exec(install.script)![1]!;
      expect(JSON.parse(Buffer.from(request, 'base64').toString())).toEqual({
        version: '0.3.14',
        replaceRunning: false,
        slug: 'acme/puddle',
      });
      expect(warned.join('\n')).toContain('elevated');
    } finally {
      if (saved === undefined) delete process.env.PUDDLE_REPO;
      else process.env.PUDDLE_REPO = saved;
    }
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

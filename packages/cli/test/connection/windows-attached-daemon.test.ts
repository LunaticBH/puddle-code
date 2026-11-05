import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningSshCommand, SshTransport } from '../../src/lib/transport/ssh.js';

/**
 * The SSH-attached lease of a Windows host (connection/windows-attached-daemon.ts)
 * against a scripted host helper: the daemon the helper starts may end
 * before it answers, and the lease must fail the start then, not after its
 * minute-long wait.
 */

interface Attached {
  command: RunningSshCommand;
  pid: Promise<number>;
  exited: Promise<number | null>;
}
const host = vi.hoisted(() => ({
  /** What the next `attached` call answers. */
  next: [] as Array<() => Attached>,
  /** Each call's `restage`. */
  restaged: [] as boolean[],
  attached: async (_port?: number, opts: { restage?: boolean } = {}): Promise<Attached> => {
    host.restaged.push(opts.restage === true);
    const answer = host.next.shift();
    if (!answer) throw new Error('no attached answer scripted');
    return answer();
  },
  stopDaemon: async () => 'stopped',
}));
vi.mock('../../src/lib/host/windows-remote-host.js', async (actual) => ({
  HelperMissingError: (await actual<typeof import('../../src/lib/host/windows-remote-host.js')>())
    .HelperMissingError,
  remoteWindowsHost: () => host,
  elevatedWarning: () => 'elevated',
}));
// No daemon ever answers: only the channel's end can settle the start.
vi.mock('../../src/lib/connection/cockpit.js', () => ({
  waitForStartedDaemon: (_ssh: unknown, _ms: number, signal?: AbortSignal) =>
    new Promise((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    ),
}));

import { WindowsAttachedDaemon } from '../../src/lib/connection/windows-attached-daemon.js';
import { HelperMissingError } from '../../src/lib/host/windows-remote-host.js';

const ssh = {
  label: 'alice@winbox',
  windowsProbe: async () => ({ elevated: false }),
  readFile: async () => null,
} as unknown as SshTransport;

/** A daemon that starts as `pid`, then exits with `status` as its channel closes. */
function startsThenExits(status: number | null): Attached {
  let close: () => void = () => {};
  const ended = new Promise<void>((resolve) => (close = resolve));
  const result = ended.then(() => ({ code: 0, stdout: '', stderr: '' }));
  setTimeout(close, 20);
  return {
    command: { result, terminate: () => close() },
    pid: Promise.resolve(4242),
    exited: result.then(() => status),
  };
}

/** A start the helper never made: its staged copy was gone. */
function helperGone(): Attached {
  const pid = Promise.reject(new HelperMissingError('alice@winbox'));
  pid.catch(() => {});
  const result = Promise.resolve({ code: 3, stdout: '', stderr: '' });
  return { command: { result, terminate: () => {} }, pid, exited: result.then(() => null) };
}

beforeEach(() => {
  host.next.length = 0;
  host.restaged.length = 0;
});

describe('the attached lease of a Windows SSH host', () => {
  it('fails at once when its daemon exits after starting', async () => {
    host.next.push(() => startsThenExits(1));
    await expect(new WindowsAttachedDaemon(ssh).start()).rejects.toMatchObject({
      code: 'daemon_start_timeout',
      message: 'puddled exited while starting on alice@winbox (status 1)',
      hint: 'inspect it with: puddle logs alice@winbox',
    });
  }, 5000);

  it('stages the helper again once when it was gone, as after days of a reconnecting cockpit', async () => {
    host.next.push(helperGone, () => startsThenExits(1));
    await expect(new WindowsAttachedDaemon(ssh).start()).rejects.toMatchObject({
      message: 'puddled exited while starting on alice@winbox (status 1)',
    });
    expect(host.restaged).toEqual([false, true]);
    // Only once: a helper that cannot be staged fails the start.
    host.restaged.length = 0;
    host.next.push(helperGone, helperGone);
    await expect(new WindowsAttachedDaemon(ssh).start()).rejects.toBeInstanceOf(HelperMissingError);
    expect(host.restaged).toEqual([false, true]);
  }, 5000);

  it('names the daemon that won the start when this one stood down beside it', async () => {
    host.next.push(() => startsThenExits(75));
    await expect(new WindowsAttachedDaemon(ssh).start()).rejects.toMatchObject({
      message: 'another puddled process won the startup race on alice@winbox',
    });
  }, 5000);
});

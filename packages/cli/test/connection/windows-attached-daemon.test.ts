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
  attached: async (_port?: number): Promise<Attached> => {
    const answer = host.next.shift();
    if (!answer) throw new Error('no attached answer scripted');
    return answer();
  },
  stopDaemon: async () => 'stopped',
}));
vi.mock('../../src/lib/host/windows-remote-host.js', () => ({
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

beforeEach(() => {
  host.next.length = 0;
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

  it('names the daemon that won the start when this one stood down beside it', async () => {
    host.next.push(() => startsThenExits(75));
    await expect(new WindowsAttachedDaemon(ssh).start()).rejects.toMatchObject({
      message: 'another puddled process won the startup race on alice@winbox',
    });
  }, 5000);
});

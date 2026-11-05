import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectorRun } from '../../src/lib/installation/windows-connector.js';

const host = vi.hoisted(() => ({
  connectorInstalled: vi.fn(async () => ({ installed: true, version: '1.2.3' as string | null })),
  connector: vi.fn(
    async (_args: readonly string[], _opts?: { stdin?: string; timeoutMs?: number }) =>
      ({ code: 0, stdout: '{}', stderr: '' }) as ConnectorRun,
  ),
}));
// The Windows SSH host's helper operations (windows-remote-host.ts), scripted.
vi.mock('../../src/lib/host/windows-remote-host.js', () => ({ remoteWindowsHost: () => host }));

import { RemoteAccessControl } from '../../src/lib/host/remote-access.js';
import { SshTransport } from '../../src/lib/transport/ssh.js';

const profile = 'b'.repeat(10);

// A POSIX client's transport makes its ControlPath directory in the client
// home: a temporary one, never the real ~/.puddle.
let savedHome: string | undefined;
let clientHome: string;
beforeAll(() => {
  savedHome = process.env.PUDDLE_HOME;
  clientHome = mkdtempSync(join(tmpdir(), 'puddle-ra-win-'));
  process.env.PUDDLE_HOME = clientHome;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.PUDDLE_HOME;
  else process.env.PUDDLE_HOME = savedHome;
  rmSync(clientHome, { recursive: true, force: true });
});

function windowsTransport(): SshTransport {
  const ssh = new SshTransport('alice@winbox', { platform: 'linux', remotePlatform: 'win32' });
  expect(ssh.args()).toContain(`ControlPath=${clientHome}/cm-%C`);
  return ssh;
}

describe('remote access on a Windows SSH host', () => {
  it('runs the host’s connector through its helper, with values only on stdin', async () => {
    const answers: Record<string, string> = {
      '--version': 'puddle-connector remote protocol 4; cockpit controls 2; delete registration 1',
      '--inspect': JSON.stringify({
        configured: false,
        enabled: false,
        connected: false,
        supervisor: 'task_scheduler',
        devices: [],
      }),
      '--configure': JSON.stringify({ enabled: true, connected: false }),
    };
    host.connector.mockImplementation(async (args) => ({
      code: 0,
      stdout: answers[args[0]!] ?? '{}',
      stderr: '',
    }));
    const ssh = windowsTransport();
    const exec = vi.spyOn(ssh, 'exec');
    const control = new RemoteAccessControl(ssh);
    expect(await control.status(profile)).toMatchObject({
      availability: 'ready',
      supervisor: 'task_scheduler',
      canDeleteRegistration: true,
    });
    const registration = {
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
      code: 'c'.repeat(64),
    };
    await control.request({ t: 'enable', registration }, () => true, profile);
    const configure = host.connector.mock.calls.find(([args]) => args[0] === '--configure')!;
    expect(configure[0]).toEqual(['--configure']);
    expect(JSON.parse(configure[1]!.stdin!)).toEqual({
      profile,
      setup: { ...registration, managed: true },
    });
    // Enabling may start the host's supervisor first.
    expect(configure[1]!.timeoutMs).toBe(120_000);
    // Never a POSIX command line, and never a secret in one.
    expect(exec).not.toHaveBeenCalled();
    expect(JSON.stringify(configure[0])).not.toContain('c'.repeat(64));
  });

  it('reports a host whose release lacks the connector without running anything', async () => {
    host.connectorInstalled.mockResolvedValueOnce({ installed: false, version: null });
    host.connector.mockClear();
    const ssh = windowsTransport();
    expect((await new RemoteAccessControl(ssh).status(profile)).availability).toBe('not_installed');
    expect(host.connector).not.toHaveBeenCalled();
  });
});

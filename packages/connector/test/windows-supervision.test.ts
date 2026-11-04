import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ipcPath, ipcProof, listenPrivate } from '@puddle/shared/node';
import type { PowerShellRunner } from '@puddle/shared/node/platform';
import { installConnectorSupervisor, supervisorKind } from '../src/supervisor.js';

/**
 * Remote access under the Windows supervisor (docs/windows.md), with an
 * injected platform and a stand-in supervisor pipe, so it runs on any OS
 * and never registers a task or starts a process.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function home(marker?: string, prefix = 'puddle-connector-supervision-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  if (marker !== undefined) writeFileSync(join(directory, 'supervisor'), `${marker}\n`);
  return directory;
}

/** A supervisor that answers every request with its proof, recording what it was asked. */
async function supervisor(at: string) {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = await listenPrivate(ipcPath(at, 'supervisor'), (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', (data: Buffer) => {
      const { t, challenge } = JSON.parse(data.toString()) as { t: string; challenge: string };
      requests.push(t);
      socket.end(
        JSON.stringify({
          t: 'supervisor',
          proof: ipcProof(at, 'supervisor', challenge),
          pid: 4242,
          daemon: 4243,
          connector: null,
          stopping: false,
        }) + '\n',
      );
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return requests;
}

const noPowerShell: PowerShellRunner = async () => {
  throw new Error('no PowerShell in this test');
};

describe('connector supervision on Windows hosts', () => {
  it('reports Task Scheduler for a home whose logon task is registered', () => {
    expect(supervisorKind(home('task'), 'win32')).toBe('task_scheduler');
  });

  it('requires the task, as POSIX requires systemd or launchd', () => {
    expect(() => supervisorKind(home('detached'), 'win32')).toThrow(
      /Persistent daemon supervision is required\. Reinstall the daemon/,
    );
    // POSIX hosts are unchanged.
    expect(() => supervisorKind(home('nohup'), 'linux')).toThrow(/external supervisor/);
    expect(() => supervisorKind(home('task'), 'linux')).toThrow(/external supervisor/);
    expect(supervisorKind(home('systemd'), 'linux')).toBe('systemd');
  });

  it('marks the connector supervised and asks the running supervisor to reconcile', async () => {
    const at = home('task');
    const requests = await supervisor(at);
    await installConnectorSupervisor(at, 'win32', { powershell: noPowerShell });
    expect(existsSync(join(at, 'remote', 'supervised'))).toBe(true);
    expect(requests).toEqual(['reconcile']);
  });

  it('refuses before marking anything when the task cannot supervise', async () => {
    const detached = home('detached');
    await expect(installConnectorSupervisor(detached, 'win32')).rejects.toThrow(
      /Persistent daemon supervision/,
    );
    expect(existsSync(join(detached, 'remote', 'supervised'))).toBe(false);
    // conhost.exe would expand `%…%` in the supervisor's command line.
    const percent = home('task', 'puddle-100%-');
    await expect(installConnectorSupervisor(percent, 'win32')).rejects.toThrow(
      /cannot be supervised/,
    );
    expect(existsSync(join(percent, 'remote', 'supervised'))).toBe(false);
  });
});

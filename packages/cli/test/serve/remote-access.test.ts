const profile = 'a'.repeat(10);
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RemoteAccessControl } from '../../src/lib/host/remote-access.js';
import type { WindowsConnectorRunner } from '../../src/lib/installation/windows-connector.js';
import { LocalTransport } from '../../src/lib/transport/local.js';
import type { ExecOptions, Transport } from '../../src/lib/transport/transport.js';

function fixture() {
  const exec = vi.fn(async (_command: string, _options?: ExecOptions) => ({
    code: 0,
    stdout: 'cockpit controls 2',
    stderr: '',
  }));
  const transport: Transport = {
    kind: 'ssh',
    label: 'owner@example.test',
    exec,
    readFile: async () => null,
    copyTo: async () => {},
    dispose() {},
  };
  return { exec, control: new RemoteAccessControl(transport) };
}

describe('desktop remote control boundary', () => {
  it('gates deletion by host capability and rechecks browser authority', async () => {
    const { exec, control } = fixture();
    await expect(
      control.request({ t: 'delete_registration' }, () => true, profile),
    ).rejects.toThrow('Upgrade the daemon');
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockResolvedValue({
      code: 0,
      stdout: 'cockpit controls 2; delete registration 1',
      stderr: '',
    });
    await expect(
      control.request({ t: 'delete_registration' }, () => false, profile),
    ).rejects.toThrow('expired before dispatch');
    expect(exec).toHaveBeenCalledTimes(2);
    exec.mockResolvedValueOnce({
      code: 0,
      stdout: 'cockpit controls 2; delete registration 1',
      stderr: '',
    });
    exec.mockResolvedValueOnce({
      code: 0,
      stdout: '{"enabled":false,"connected":false}',
      stderr: '',
    });
    await control.request({ t: 'delete_registration' }, () => true, profile);
    const [command, options] = exec.mock.calls.at(-1)!;
    expect(command).toMatch(/--admin$/);
    expect(JSON.parse(options!.stdin!)).toEqual({ profile, request: { t: 'delete_registration' } });
  });

  it('passes registration secrets only through stdin and uses managed supervision', async () => {
    const { exec, control } = fixture();
    exec.mockResolvedValueOnce({ code: 0, stdout: 'cockpit controls 2', stderr: '' });
    exec.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ enabled: true }), stderr: '' });
    const registration = {
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
      code: 'a'.repeat(64),
    };
    await control.request({ t: 'enable', registration }, () => true, profile);
    const [command, options] = exec.mock.calls[1]!;
    expect(command).toMatch(/--configure$/);
    expect(command).not.toContain(registration.service);
    expect(command).not.toContain(registration.code);
    expect(JSON.parse(options!.stdin!)).toEqual({
      profile,
      setup: { ...registration, managed: true },
    });
  });

  it('rechecks browser authority after asynchronous host discovery', async () => {
    const { exec, control } = fixture();
    await expect(control.request({ t: 'disable' }, () => false, profile)).rejects.toThrow(
      'expired before dispatch',
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('does not invoke unsupported older connector flags or expose subprocess diagnostics', async () => {
    const { exec, control } = fixture();
    exec.mockResolvedValueOnce({
      code: 0,
      stdout: 'puddle-connector remote protocol 1',
      stderr: '',
    });
    expect((await control.status(profile)).availability).toBe('upgrade_required');
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockResolvedValueOnce({ code: 0, stdout: 'cockpit controls 2', stderr: '' });
    exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'private-routing-credential' });
    await expect(control.request({ t: 'pair' }, () => true, profile)).rejects.toThrow(
      'Refresh status',
    );
  });

  it('rejects arbitrary commands, host overrides and foreground enablement', async () => {
    const { exec, control } = fixture();
    for (const request of [
      { t: 'run' },
      { t: 'disable', host: 'attacker.test' },
      { t: 'enable', managed: false },
    ]) {
      // Deliberate runtime boundary test: the caller is an untrusted JSON request.
      await expect(
        control.request(request as Parameters<typeof control.request>[0], () => true, profile),
      ).rejects.toThrow();
    }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('remote access on this Windows machine', () => {
  /** A home whose `bin\current` names a release that ships the connector, or none. */
  function windowsHome(version: string | null) {
    const home = mkdtempSync(join(tmpdir(), 'puddle-windows-remote-'));
    if (version !== null) {
      const tree = join(home, 'bin', 'versions', version);
      mkdirSync(join(tree, 'daemon'), { recursive: true });
      writeFileSync(join(tree, 'daemon', 'connector.mjs'), '');
      symlinkSync(
        tree,
        join(home, 'bin', 'current'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    return home;
  }
  function runner(answers: Record<string, string>) {
    const run = vi.fn<WindowsConnectorRunner>(async (_home, args) => ({
      code: 0,
      stdout: answers[args[0]!] ?? '{}',
      stderr: '',
    }));
    return run;
  }
  const windows = (home: string, run: WindowsConnectorRunner) =>
    new RemoteAccessControl(new LocalTransport({ platform: 'win32' }), { run, home: () => home });

  it('runs the installed connector directly, with values only on stdin', async () => {
    const home = windowsHome('1.2.3');
    const run = runner({
      '--version': 'puddle-connector remote protocol 4; cockpit controls 2; delete registration 1',
      '--inspect': JSON.stringify({
        availability: 'ready',
        configured: false,
        enabled: false,
        connected: false,
        supervisor: 'task_scheduler',
        devices: [],
      }),
      '--configure': JSON.stringify({ enabled: true, connected: false }),
    });
    const control = windows(home, run);
    expect(await control.status(profile)).toMatchObject({
      availability: 'ready',
      supervisor: 'task_scheduler',
      canDeleteRegistration: true,
    });
    const registration = {
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
      code: 'a'.repeat(64),
    };
    expect(await control.request({ t: 'enable', registration }, () => true, profile)).toEqual({
      enabled: true,
      connected: false,
    });
    const configure = run.mock.calls.find(([, args]) => args[0] === '--configure')!;
    expect(configure[0]).toBe(home);
    expect(configure[1]).toEqual(['--configure']);
    expect(JSON.parse(configure[2]!.stdin!)).toEqual({
      profile,
      setup: { ...registration, managed: true },
    });
    expect(run.mock.calls.find(([, args]) => args[0] === '--inspect')![2]!.stdin).toBe(
      JSON.stringify({ profile }) + '\n',
    );
  });

  it('asks the installed release for its capabilities once per version', async () => {
    const home = windowsHome('1.2.3');
    const run = runner({
      '--version': 'puddle-connector remote protocol 4; cockpit controls 2',
      '--inspect': JSON.stringify({
        configured: false,
        enabled: false,
        connected: false,
        supervisor: null,
        devices: [],
      }),
    });
    const control = windows(home, run);
    await control.status(profile);
    await control.status(profile);
    expect(run.mock.calls.filter(([, args]) => args[0] === '--version')).toHaveLength(1);
  });

  it('reports a release without the connector, and an older one, without enabling anything', async () => {
    const missing = runner({});
    expect(await windows(windowsHome(null), missing).status(profile)).toMatchObject({
      availability: 'not_installed',
      supervisor: null,
    });
    expect(missing).not.toHaveBeenCalled();
    const older = runner({ '--version': 'puddle-connector remote protocol 3' });
    const control = windows(windowsHome('1.0.0'), older);
    expect((await control.status(profile)).availability).toBe('upgrade_required');
    await expect(control.request({ t: 'disable' }, () => true, profile)).rejects.toThrow(
      'Upgrade the daemon',
    );
  });
});

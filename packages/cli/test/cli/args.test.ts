import { describe, expect, it } from 'vitest';
import { argvFor, parseArgs } from '../../src/cli/args.js';
import { CliError } from '../../src/lib/types.js';

describe('argument parsing', () => {
  it('parses launch: bare and local mean local, a host means SSH', () => {
    expect(
      parseArgs(['launch', '--port', '7500', '--no-browser', '--tarball', 'x.tar.gz']),
    ).toEqual({
      cmd: 'launch',
      target: 'local',
      port: 7500,
      tarball: 'x.tar.gz',
      noBrowser: true,
      noUpgrade: false,
      foreground: false,
    });
    expect(parseArgs(['launch', 'local'])).toMatchObject({ cmd: 'launch', target: 'local' });
    expect(parseArgs(['launch', 'alice@devbox', '--remote-port', '7500', '--no-upgrade'])).toEqual({
      cmd: 'launch',
      target: 'alice@devbox',
      remotePort: 7500,
      noBrowser: false,
      noUpgrade: true,
      foreground: false,
    });
    expect(parseArgs(['launch', '--foreground'])).toMatchObject({
      cmd: 'launch',
      foreground: true,
    });
    expect(() => parseArgs(['launch', 'a@b', 'c@d'])).toThrow(/at most one target/);
    expect(() => parseArgs(['launch', '--remote-port', '7500'])).toThrow(/SSH target/);
  });

  it('start and connect say what replaced them', () => {
    expect(() => parseArgs(['start'])).toThrow(/puddle launch/);
    expect(() => parseArgs(['connect', 'a@b'])).toThrow(/puddle launch a@b/);
  });

  it('parses refresh: bare, with a target, and with pass-through flags', () => {
    expect(parseArgs(['refresh'])).toEqual({
      cmd: 'refresh',
      noBrowser: false,
      noUpgrade: false,
      foreground: false,
    });
    expect(parseArgs(['refresh', 'alice@devbox', '--no-browser'])).toEqual({
      cmd: 'refresh',
      target: 'alice@devbox',
      noBrowser: true,
      noUpgrade: false,
      foreground: false,
    });
    expect(parseArgs(['refresh', 'local', '--port', '7500', '--tarball', 'x.tar.gz'])).toEqual({
      cmd: 'refresh',
      target: 'local',
      port: 7500,
      tarball: 'x.tar.gz',
      noBrowser: false,
      noUpgrade: false,
      foreground: false,
    });
    expect(() => parseArgs(['refresh', 'a@b', 'c@d'])).toThrow(/at most one target/);
  });

  it('parses --prefer-port on launch (non-strict UI port for refresh)', () => {
    expect(parseArgs(['launch', '--prefer-port', '7435'])).toMatchObject({
      cmd: 'launch',
      preferPort: 7435,
    });
    expect(parseArgs(['launch', 'a@b', '--prefer-port', '7435'])).toMatchObject({
      cmd: 'launch',
      target: 'a@b',
      preferPort: 7435,
    });
  });

  it('argvFor is the inverse of parseArgs for launch', () => {
    const local = parseArgs([
      'launch',
      '--port',
      '7500',
      '--prefer-port',
      '7435',
      '--tarball',
      'x.tar.gz',
      '--no-browser',
      '--no-upgrade',
      '--foreground',
    ]);
    if (local.cmd !== 'launch') throw new Error('expected launch');
    expect(parseArgs(argvFor(local))).toEqual(local);

    const remote = parseArgs(['launch', 'alice@devbox', '--remote-port', '7500']);
    if (remote.cmd !== 'launch') throw new Error('expected launch');
    expect(parseArgs(argvFor(remote))).toEqual(remote);
  });

  it('parses list and kill', () => {
    expect(parseArgs(['list'])).toEqual({ cmd: 'list' });
    expect(parseArgs(['kill'])).toEqual({ cmd: 'kill', all: false });
    expect(parseArgs(['kill', 'alice@devbox'])).toEqual({
      cmd: 'kill',
      target: 'alice@devbox',
      all: false,
    });
    expect(parseArgs(['kill', '--all'])).toEqual({ cmd: 'kill', all: true });
    expect(() => parseArgs(['kill', 'a@b', '--all'])).toThrow(/not both/);
    expect(() => parseArgs(['list', 'extra'])).toThrow(CliError);
  });

  it('rejects unknown flags and commands', () => {
    expect(() => parseArgs(['launch', '--frobnicate'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['nonsense'])).toThrow(/unknown command/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseArgs(['launch', '--port', '99999'])).toThrow(/between 1 and 65535/);
  });

  it('attach: one positional is a session, two are host + session', () => {
    expect(parseArgs(['attach', 'abc123'])).toEqual({ cmd: 'attach', session: 'abc123' });
    expect(parseArgs(['attach', 'user@host', 'abc123', '--term', 'shell-1'])).toEqual({
      cmd: 'attach',
      host: 'user@host',
      session: 'abc123',
      term: 'shell-1',
    });
  });

  it('logs: a lone user@host positional is a host, anything else a session', () => {
    expect(parseArgs(['logs', 'user@host', '-f'])).toEqual({
      cmd: 'logs',
      host: 'user@host',
      follow: true,
    });
    expect(parseArgs(['logs', 'abc123'])).toEqual({
      cmd: 'logs',
      session: 'abc123',
      follow: false,
    });
    expect(parseArgs(['logs'])).toEqual({ cmd: 'logs', follow: false });
  });

  it('upgrade: bare covers everything installed; component and @version are optional', () => {
    expect(parseArgs(['upgrade'])).toEqual({ cmd: 'upgrade' });
    expect(parseArgs(['upgrade', 'cli'])).toEqual({ cmd: 'upgrade', what: 'cli' });
    expect(parseArgs(['upgrade', 'daemon'])).toEqual({ cmd: 'upgrade', what: 'daemon' });
    expect(parseArgs(['upgrade', 'daemon', 'user@host'])).toEqual({
      cmd: 'upgrade',
      what: 'daemon',
      host: 'user@host',
    });
    expect(parseArgs(['upgrade', 'desktop@v0.0.32'])).toEqual({
      cmd: 'upgrade',
      what: 'desktop',
      version: '0.0.32',
    });
    // Bare @version: that version for every installed component.
    expect(parseArgs(['upgrade', '@0.0.31'])).toEqual({ cmd: 'upgrade', version: '0.0.31' });
    // A lone user@host is the target, not a component.
    expect(parseArgs(['upgrade', 'user@host'])).toEqual({ cmd: 'upgrade', host: 'user@host' });
    expect(parseArgs(['upgrade', 'daemon', '--tarball', 'x.tar.gz'])).toEqual({
      cmd: 'upgrade',
      what: 'daemon',
      tarball: 'x.tar.gz',
    });
  });

  it('upgrade: a malformed version or a stray word is rejected', () => {
    expect(() => parseArgs(['upgrade', 'daemon@not-a-version'])).toThrow(CliError);
    // Two positionals where the first is not a component: nonsense, not a host.
    expect(() => parseArgs(['upgrade', 'nonsense', 'user@host'])).toThrow(CliError);
  });

  it('install: needs daemon or desktop, takes @version, host, --tarball', () => {
    expect(parseArgs(['install', 'daemon'])).toEqual({ cmd: 'install', what: 'daemon' });
    expect(parseArgs(['install', 'daemon@v0.0.32', 'user@host'])).toEqual({
      cmd: 'install',
      what: 'daemon',
      version: '0.0.32',
      host: 'user@host',
    });
    expect(parseArgs(['install', 'desktop'])).toEqual({ cmd: 'install', what: 'desktop' });
    expect(() => parseArgs(['install'])).toThrow(CliError);
    // The CLI installs itself via npm — the hint says so.
    expect(() => parseArgs(['install', 'cli'])).toThrow(CliError);
    // A bare @version has no component to install.
    expect(() => parseArgs(['install', '@0.0.32'])).toThrow(CliError);
  });

  it('remove: needs a component; --purge is daemon-only', () => {
    expect(parseArgs(['remove', 'daemon'])).toEqual({
      cmd: 'remove',
      what: 'daemon',
      yes: false,
      purge: false,
    });
    expect(parseArgs(['remove', 'daemon', 'user@host', '--yes', '--purge'])).toEqual({
      cmd: 'remove',
      what: 'daemon',
      host: 'user@host',
      yes: true,
      purge: true,
    });
    // No `uninstall` alias: one spelling (decision 2026-08-07).
    expect(() => parseArgs(['uninstall', 'cli'])).toThrow(CliError);
    expect(() => parseArgs(['remove'])).toThrow(CliError);
    expect(() => parseArgs(['remove', 'daemon@v0.0.32'])).toThrow(CliError);
    expect(() => parseArgs(['remove', 'desktop', '--purge'])).toThrow(CliError);
  });

  it('help and version', () => {
    expect(parseArgs([])).toEqual({ cmd: 'help' });
    expect(parseArgs(['--help'])).toEqual({ cmd: 'help' });
    expect(parseArgs(['--version'])).toEqual({ cmd: 'version' });
  });
});

describe('remote administration arguments', () => {
  it('keeps registration secrets out of arguments and requires explicit secure origins', () => {
    expect(
      parseArgs([
        'remote',
        'enable',
        '--profile',
        '0123456789',
        'user@host',
        '--service',
        'https://relay.example.test',
        '--app-origin',
        'https://app.example.test',
      ]),
    ).toMatchObject({ cmd: 'remote', action: 'enable', host: 'user@host', foreground: false });
    expect(parseArgs(['remote', 'reset', '--profile', '0123456789'])).toMatchObject({
      cmd: 'remote',
      action: 'reset',
    });
    expect(() => parseArgs(['remote', 'enable', '--code', 'secret'])).toThrow();
    expect(() =>
      parseArgs(['remote', 'enable', '--service', 'http://relay.example.test']),
    ).toThrow();
    expect(() => parseArgs(['remote', 'approve', 'Phone'])).toThrow();
    expect(() =>
      parseArgs(['remote', 'disable', '--service', 'https://relay.example.test']),
    ).toThrow();
  });
});

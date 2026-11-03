import { describe, expect, it, vi } from 'vitest';
import type { VersionResponse } from '@puddle/shared';
import { PROTOCOL_VERSION } from '@puddle/shared';
import {
  CLI_UPGRADE_COMMAND,
  decideHandshake,
  runHandshake,
} from '../../src/lib/connection/handshake.js';
import { CliError } from '../../src/lib/types.js';

const CLI = { major: 5 };

describe('decideHandshake', () => {
  it('same major proceeds (app-version skew is silent)', () => {
    expect(decideHandshake(CLI, { major: 5 })).toEqual({ kind: 'proceed' });
  });
  it('older daemon major upgrades', () => {
    expect(decideHandshake(CLI, { major: 4 })).toEqual({ kind: 'upgrade-daemon' });
  });
  it('newer daemon major refuses with the CLI upgrade command', () => {
    expect(decideHandshake(CLI, { major: 6 })).toEqual({
      kind: 'refuse-cli-outdated',
      command: CLI_UPGRADE_COMMAND,
    });
  });

  it.each([15, 19, 20])('upgrades a %i.x daemon to the current protocol', (major) => {
    expect(decideHandshake(PROTOCOL_VERSION, { major })).toEqual({
      kind: 'upgrade-daemon',
    });
  });
});

const v = (major: number, version = '1.0.0'): VersionResponse => ({
  version,
  protocol: { major, minor: 0 },
});
const inspection = (major: number) => ({
  t: 'inspection' as const,
  port: 7434,
  version: v(major),
  liveSessions: 3,
});

describe('runHandshake', () => {
  it('proceeds on a matching major without prompting or upgrading', async () => {
    const confirmDaemonUpgrade = vi.fn();
    const upgradeDaemon = vi.fn();
    expect(
      await runHandshake({
        host: 'devbox',
        inspection: inspection(PROTOCOL_VERSION.major),
        confirmDaemonUpgrade,
        upgradeDaemon,
      }),
    ).toEqual(v(PROTOCOL_VERSION.major));
    expect(confirmDaemonUpgrade).not.toHaveBeenCalled();
    expect(upgradeDaemon).not.toHaveBeenCalled();
  });

  it('asks with host, protocol and live-session details, then upgrades and verifies', async () => {
    const confirmDaemonUpgrade = vi.fn(async () => true);
    const upgradeDaemon = vi.fn(async () => v(PROTOCOL_VERSION.major, '2.0.0'));
    const result = await runHandshake({
      host: 'devbox',
      inspection: inspection(PROTOCOL_VERSION.major - 1),
      confirmDaemonUpgrade,
      upgradeDaemon,
    });
    expect(confirmDaemonUpgrade).toHaveBeenCalledExactlyOnceWith({
      host: 'devbox',
      daemon: v(PROTOCOL_VERSION.major - 1),
      clientProtocol: PROTOCOL_VERSION,
      liveSessions: 3,
    });
    expect(upgradeDaemon).toHaveBeenCalledOnce();
    expect(result.version).toBe('2.0.0');
  });

  it.each([undefined, async () => false])(
    'does not upgrade without approval',
    async (confirmDaemonUpgrade) => {
      const upgradeDaemon = vi.fn();
      await expect(
        runHandshake({
          host: 'devbox',
          inspection: inspection(PROTOCOL_VERSION.major - 1),
          confirmDaemonUpgrade,
          upgradeDaemon,
        }),
      ).rejects.toMatchObject({
        code: 'upgrade_failed',
        message: expect.stringContaining('not approved'),
      });
      expect(upgradeDaemon).not.toHaveBeenCalled();
    },
  );

  it('aborts on --no-upgrade before prompting', async () => {
    const confirmDaemonUpgrade = vi.fn();
    const upgradeDaemon = vi.fn();
    await expect(
      runHandshake({
        host: 'devbox',
        inspection: inspection(PROTOCOL_VERSION.major - 1),
        noUpgrade: true,
        confirmDaemonUpgrade,
        upgradeDaemon,
      }),
    ).rejects.toMatchObject({
      code: 'upgrade_failed',
      hint: expect.stringContaining('3 live session(s)'),
    });
    expect(confirmDaemonUpgrade).not.toHaveBeenCalled();
    expect(upgradeDaemon).not.toHaveBeenCalled();
  });

  it.each([-1, 1])('fails when the replacement still mismatches (%i)', async (offset) => {
    await expect(
      runHandshake({
        host: 'devbox',
        inspection: inspection(PROTOCOL_VERSION.major - 1),
        confirmDaemonUpgrade: async () => true,
        upgradeDaemon: async () => v(PROTOCOL_VERSION.major + offset),
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof CliError && e.code === 'upgrade_failed');
  });

  it('refuses a newer daemon without prompting or installing', async () => {
    const confirmDaemonUpgrade = vi.fn();
    const upgradeDaemon = vi.fn();
    await expect(
      runHandshake({
        host: 'devbox',
        inspection: inspection(PROTOCOL_VERSION.major + 1),
        confirmDaemonUpgrade,
        upgradeDaemon,
      }),
    ).rejects.toMatchObject({
      code: 'cli_outdated',
      hint: expect.stringContaining(CLI_UPGRADE_COMMAND),
    });
    expect(confirmDaemonUpgrade).not.toHaveBeenCalled();
    expect(upgradeDaemon).not.toHaveBeenCalled();
  });
});

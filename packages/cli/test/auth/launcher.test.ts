import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  requestCockpitShutdown,
  requestInvitation,
  startLauncher,
} from '../../src/lib/auth/launcher.js';

describe('the cockpit launcher pipe', () => {
  it('stops the cockpit on request: Windows `puddle kill` has no SIGTERM to send', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-launcher-'));
    let stops = 0;
    const launcher = await startLauncher(
      home,
      'local:http://localhost:7433',
      () => 'http://localhost:7433/#invite=x',
      () => stops++,
    );
    try {
      expect(await requestInvitation(home, launcher.path)).toBe('http://localhost:7433/#invite=x');
      await requestCockpitShutdown(home, launcher.path);
      expect(stops).toBe(1);
    } finally {
      await launcher.close();
    }
  });

  it('refuses a stop request when the cockpit offers none', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-launcher-'));
    const launcher = await startLauncher(home, 'local:http://localhost:7434', () => 'http://x/');
    try {
      await expect(requestCockpitShutdown(home, launcher.path)).rejects.toThrow();
    } finally {
      await launcher.close();
    }
  });

  it.runIf(process.platform === 'win32')('removes the pipe’s stored secret on close', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-launcher-'));
    const launcher = await startLauncher(home, 'local:http://localhost:7435', () => 'http://x/');
    expect(readdirSync(join(home, 'launcher-authority'))).toHaveLength(1);
    await launcher.close();
    expect(existsSync(join(home, 'launcher-authority'))).toBe(true);
    expect(readdirSync(join(home, 'launcher-authority'))).toHaveLength(0);
  });
});

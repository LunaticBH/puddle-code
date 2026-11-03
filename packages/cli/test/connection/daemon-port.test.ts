import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDaemonPort } from '../../src/lib/connection/daemon-client.js';
import { LocalTransport } from '../../src/lib/transport/local.js';

/** Point PUDDLE_HOME at a fresh dir and seed the given files. */
function home(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-port-'));
  mkdirSync(join(dir, '.puddle'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, '.puddle', name), body);
  }
  process.env.PUDDLE_HOME = join(dir, '.puddle');
  return dir;
}

describe('readDaemonPort discovery precedence', () => {
  afterEach(() => delete process.env.PUDDLE_HOME);

  it('prefers the live runtime.json port over config.json', async () => {
    home({
      'config.json': JSON.stringify({ port: 7434, configVersion: 2 }),
      'runtime.json': JSON.stringify({ port: 7451, pid: 999 }),
    });
    expect(await readDaemonPort(new LocalTransport())).toBe(7451);
  });

  it('falls back to config.json when runtime.json is absent', async () => {
    home({ 'config.json': JSON.stringify({ port: 7500, configVersion: 2 }) });
    expect(await readDaemonPort(new LocalTransport())).toBe(7500);
  });

  it('ignores a malformed runtime.json and uses config.json', async () => {
    home({
      'config.json': JSON.stringify({ port: 7500, configVersion: 2 }),
      'runtime.json': 'not json',
    });
    expect(await readDaemonPort(new LocalTransport())).toBe(7500);
  });

  it('defaults to 7434 when neither file exists', async () => {
    home({});
    expect(await readDaemonPort(new LocalTransport())).toBe(7434);
  });
});

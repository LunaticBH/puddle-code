import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { spawnNpm } from '../../src/cli/manage-cli.js';

describe('npm channel', () => {
  // npm is npm.cmd on Windows, which Node refuses to start without a shell
  // (EINVAL since CVE-2024-27980); spawnNpm runs its script with node.exe.
  it.runIf(process.platform === 'win32')('starts npm.cmd without a shell', async () => {
    const child = spawnNpm(['--version'], ['ignore', 'pipe', 'ignore']);
    let output = '';
    child.stdout?.on('data', (chunk) => (output += String(chunk)));
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports a missing npm through the error event rather than throwing', async () => {
    const child = spawnNpm(['--version'], 'ignore');
    child.kill();
    // Whichever comes first, the caller's error/exit listeners see it.
    await Promise.race([once(child, 'exit'), once(child, 'error')]);
  });
});

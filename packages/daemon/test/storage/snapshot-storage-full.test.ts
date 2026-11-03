import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TerminalScreenStateStore } from '../../src/pty/terminal-screen-state.js';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, writeFile: vi.fn(real.writeFile) };
});

it('keeps live snapshots available, removes partial files and retries after ENOSPC', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-screen-full-'));
  const health = vi.fn();
  const store = new TerminalScreenStateStore(home, health);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementationOnce(async (file) => {
    await real.writeFile(file, 'partial');
    throw Object.assign(new Error('full'), { code: 'ENOSPC' });
  });
  try {
    store.write('session', 'agent', 'still visible');
    expect(await store.snapshot('session', 'agent')).toContain('still visible');
    await vi.waitFor(() => expect(health).toHaveBeenCalledWith(true), { timeout: 3000 });
    expect(
      readdirSync(join(home, 'session')).filter((name) => name.includes('.tmp-')),
    ).toHaveLength(0);
    expect(await store.snapshot('session', 'agent')).toContain('still visible');
    await vi.waitFor(() => expect(health).toHaveBeenLastCalledWith(false), { timeout: 4000 });
    expect(readdirSync(join(home, 'session'))).toEqual(['agent.terminal.json']);
  } finally {
    await store.closeAll();
    rmSync(home, { recursive: true, force: true });
  }
});

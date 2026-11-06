import { describe, expect, it } from 'vitest';
import type { WorktreeDeps } from '../../src/http/routes/worktrees/worktree-shared.js';
import { NotebookKernels } from '../../src/notebooks/kernels.js';

/**
 * Closing notebook kernels as the daemon stops. Each bridge's close may take
 * its 3 s shutdown grace and then, on Windows, its stop's 5 s: there they
 * all close at once, so the shutdown's wait for them stays within one
 * bridge's. POSIX keeps the catalogue's bridge first, then the kernels'.
 */

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kernels whose catalogue bridge and one kernel's bridge each take 200 ms to close. */
function kernels() {
  const events: string[] = [];
  const bridge = (name: string) => ({
    close: async () => {
      events.push(`${name} closing`);
      await pause(200);
      events.push(`${name} closed`);
    },
  });
  const created = new NotebookKernels({} as WorktreeDeps);
  // The bridges running as dispose begins, as discovery and a kernel leave them.
  const internals = created as unknown as {
    catalogueBridge: unknown;
    entries: Map<string, unknown>;
  };
  internals.catalogueBridge = bridge('catalogue');
  internals.entries.set('/notebook.ipynb', { bridge: bridge('kernel'), finished: null });
  return { created, events };
}

describe('closing notebook kernels as the daemon stops', () => {
  it('closes every bridge at once on Windows', async () => {
    const { created, events } = kernels();
    await created.dispose('win32');
    expect(events.slice(0, 2).sort()).toEqual(['catalogue closing', 'kernel closing']);
  });

  it('keeps POSIX on closing the catalogue’s bridge first', async () => {
    const { created, events } = kernels();
    await created.dispose('linux');
    expect(events.slice(0, 2)).toEqual(['catalogue closing', 'catalogue closed']);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { openPath, registerOpenPathHandler } from '../../../src/lib/navigation/path-open';

describe('path-open bridge', () => {
  it('forwards the typed path to the mounted workspace and unregisters cleanly', async () => {
    const handler = vi.fn(async () => undefined);
    const unregister = registerOpenPathHandler(handler);

    await openPath('~/notes.md');
    expect(handler).toHaveBeenCalledWith('~/notes.md');

    unregister();
    await expect(openPath('README.md')).rejects.toThrow('Open a project');
  });
});

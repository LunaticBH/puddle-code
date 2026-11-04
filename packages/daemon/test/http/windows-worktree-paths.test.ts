import { describe, expect, it } from 'vitest';
import {
  onDiskRelative,
  refusesForeignNetworkPath,
} from '../../src/http/routes/worktrees/windows-paths.js';

/**
 * The Windows path decisions of `GET /resolve` and `PUT /file`, driven through
 * their injected `platform` (and a fake real-path lookup) so they run on every
 * host (docs/windows.md, decision 11).
 */

describe('network paths in /resolve', () => {
  const roots = () => ['C:\\Users\\a\\wt'];

  it('refuses UNC and device paths outside the session root on Windows', () => {
    for (const abs of [
      '\\\\attacker.example\\share\\x.txt',
      '//attacker.example/share/x.txt',
      '\\\\10.0.0.5\\c$\\notes.md',
      '\\\\?\\UNC\\attacker\\share\\x',
      '\\\\?\\C:\\Users\\a\\wt\\x.ts',
      '\\\\.\\pipe\\puddle',
    ]) {
      expect(refusesForeignNetworkPath(abs, roots, 'win32'), abs).toBe(true);
    }
  });

  it('leaves drive paths alone without consulting the roots', () => {
    const untouched = () => {
      throw new Error('roots must not be read for a drive path');
    };
    expect(refusesForeignNetworkPath('C:\\elsewhere\\x.ts', untouched, 'win32')).toBe(false);
    expect(refusesForeignNetworkPath('D:\\x.ts', untouched, 'win32')).toBe(false);
  });

  it('still resolves a worktree that lives on a share, in any case', () => {
    const share = () => ['C:\\Users\\a\\wt', '\\\\files\\team\\wt'];
    expect(refusesForeignNetworkPath('\\\\files\\team\\wt\\src\\a.ts', share, 'win32')).toBe(false);
    expect(refusesForeignNetworkPath('\\\\FILES\\Team\\WT\\a.ts', share, 'win32')).toBe(false);
    expect(refusesForeignNetworkPath('\\\\files\\team\\other\\a.ts', share, 'win32')).toBe(true);
    expect(refusesForeignNetworkPath('\\\\files\\team\\wt-evil\\a.ts', share, 'win32')).toBe(true);
  });

  it('never refuses on POSIX, where a leading \\\\ is an ordinary name', () => {
    const untouched = () => {
      throw new Error('roots must not be read on POSIX');
    };
    expect(refusesForeignNetworkPath('\\\\server\\share\\x', untouched, 'linux')).toBe(false);
    expect(refusesForeignNetworkPath('//server/share/x', untouched, 'darwin')).toBe(false);
  });
});

describe('on-disk spelling', () => {
  /** A fake `realpath` over a case-insensitive volume whose names are stored as listed. */
  function volume(stored: Record<string, string>) {
    return (path: string) => {
      const real = stored[path.toLowerCase()];
      return real === undefined
        ? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }))
        : Promise.resolve(real);
    };
  }

  const disk = volume({
    'c:\\users\\a\\repo': 'C:\\Users\\a\\repo',
    'c:\\users\\a\\repo\\src\\app.tsx': 'C:\\Users\\a\\repo\\src\\App.tsx',
    'c:\\users\\a\\repo\\src\\mixed': 'C:\\Users\\a\\repo\\src\\Mixed',
    'c:\\users\\a\\repo\\linked.ts': 'D:\\elsewhere\\target.ts',
  });

  it('gives the stored case of a path typed in another case on Windows', async () => {
    const base = 'c:\\users\\A\\REPO';
    expect(await onDiskRelative(base, `${base}\\SRC\\app.tsx`, 'win32', disk)).toBe('src\\App.tsx');
    expect(await onDiskRelative(base, `${base}\\src\\MIXED`, 'win32', disk)).toBe('src\\Mixed');
    expect(await onDiskRelative(base, base, 'win32', disk)).toBe('');
  });

  it("keeps the caller's spelling when links move the path, or it cannot be read", async () => {
    const base = 'C:\\Users\\a\\repo';
    expect(await onDiskRelative(base, `${base}\\linked.ts`, 'win32', disk)).toBeNull();
    expect(await onDiskRelative(base, `${base}\\missing.ts`, 'win32', disk)).toBeNull();
  });

  it('never touches the filesystem on POSIX', async () => {
    const untouched = () => Promise.reject(new Error('realpath must not run on POSIX'));
    expect(await onDiskRelative('/repo', '/repo/SRC/app.tsx', 'linux', untouched)).toBeNull();
    expect(await onDiskRelative('/repo', '/repo/a', 'darwin', untouched)).toBeNull();
  });
});

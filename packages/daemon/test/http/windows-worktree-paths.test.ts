import { describe, expect, it } from 'vitest';
import { refusesForeignNetworkPath } from '../../src/http/routes/worktrees/windows-paths.js';

/**
 * The Windows path decisions of the worktree routes, driven through their
 * injected `platform` so they run on every host (docs/windows.md, decision 11).
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

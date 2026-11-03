import { describe, expect, it } from 'vitest';
import { windowsUpdateTarget } from '../src/update-target.js';

describe('Windows in-app update target', () => {
  const exe = 'C:\\Users\\a\\AppData\\Local\\Programs\\@puddle-codedesktop\\Puddle.exe';

  it('updates only an NSIS installation, recognised by its uninstaller', () => {
    const seen: string[] = [];
    expect(
      windowsUpdateTarget(exe, (path) => {
        seen.push(path);
        return true;
      }),
    ).toBe(exe);
    expect(seen).toEqual([
      'C:\\Users\\a\\AppData\\Local\\Programs\\@puddle-codedesktop\\Uninstall Puddle.exe',
    ]);
    expect(windowsUpdateTarget('D:\\portable\\Puddle.exe', () => false)).toBeNull();
  });
});

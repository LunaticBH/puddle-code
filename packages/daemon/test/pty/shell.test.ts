import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultShell, shellKind } from '../../src/pty/shell.js';

describe('defaultShell', () => {
  const none = () => false;

  it('keeps $SHELL, then bash, on POSIX', () => {
    expect(defaultShell({ platform: 'linux', env: { SHELL: '/bin/zsh' }, isFile: none })).toBe(
      '/bin/zsh',
    );
    expect(defaultShell({ platform: 'darwin', env: {}, isFile: none })).toBe('bash');
  });

  const windowsEnv = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

  it('honours SHELL on Windows only as an existing absolute executable', () => {
    const exists = (path: string) => path === 'D:\\tools\\nu.exe' || path === powershell;
    const shell = (SHELL: string) =>
      defaultShell({ platform: 'win32', env: { ...windowsEnv, SHELL }, isFile: exists });
    expect(shell('D:\\tools\\nu.exe')).toBe('D:\\tools\\nu.exe');
    // Git Bash's MSYS spelling, a bare name, a missing file, a script: ignored.
    expect(shell('/usr/bin/bash')).toBe(powershell);
    expect(shell('bash')).toBe(powershell);
    expect(shell('D:\\tools\\missing.exe')).toBe(powershell);
    expect(shell('D:\\tools\\nu.cmd')).toBe(powershell);
  });

  it('prefers pwsh on Path, then Windows PowerShell, then ComSpec, then cmd.exe', () => {
    const bin = mkdtempSync(join(tmpdir(), 'puddle-shell-'));
    writeFileSync(join(bin, 'pwsh.exe'), '');
    expect(
      defaultShell({ platform: 'win32', env: { ...windowsEnv, PATH: bin }, isFile: none }),
    ).toBe(join(bin, 'pwsh.exe'));
    expect(
      defaultShell({ platform: 'win32', env: windowsEnv, isFile: (p) => p === powershell }),
    ).toBe(powershell);
    expect(
      defaultShell({
        platform: 'win32',
        env: windowsEnv,
        isFile: (p) => p === windowsEnv.ComSpec,
      }),
    ).toBe(windowsEnv.ComSpec);
    expect(defaultShell({ platform: 'win32', env: windowsEnv, isFile: none })).toBe(
      'C:\\Windows\\System32\\cmd.exe',
    );
  });
});

describe('shellKind', () => {
  it('compares POSIX basenames exactly', () => {
    expect(shellKind('/bin/zsh', 'linux')).toBe('zsh');
    expect(shellKind('/opt/homebrew/bin/bash', 'darwin')).toBe('bash');
    expect(shellKind('/usr/bin/fish', 'linux')).toBe('other');
    expect(shellKind('/bin/Bash', 'linux')).toBe('other');
  });

  it('ignores case and .exe on Windows, and tells WSL bash from Git Bash', () => {
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe('powershell');
    expect(
      shellKind('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE', 'win32'),
    ).toBe('powershell');
    expect(shellKind('C:\\WINDOWS\\system32\\cmd.exe', 'win32')).toBe('cmd');
    expect(shellKind('C:\\Program Files\\Git\\bin\\bash.exe', 'win32')).toBe('bash');
    expect(shellKind('C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'win32')).toBe('bash');
    expect(shellKind('C:\\Windows\\System32\\bash.exe', 'win32')).toBe('wsl');
    expect(shellKind('C:\\Windows\\Sysnative\\bash.exe', 'win32')).toBe('wsl');
    expect(shellKind('C:\\Program Files\\WSL\\wsl.exe', 'win32')).toBe('wsl');
    expect(shellKind('C:\\msys64\\usr\\bin\\zsh.exe', 'win32')).toBe('other');
  });
});

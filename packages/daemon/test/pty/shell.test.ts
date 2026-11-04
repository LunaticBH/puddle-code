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

  it('honours SHELL on Windows only as an existing absolute PowerShell', () => {
    const existing = new Set([
      'D:\\pwsh-preview\\pwsh.exe',
      'D:\\tools\\nu.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Windows\\system32\\cmd.exe',
      powershell,
    ]);
    const shell = (SHELL: string) =>
      defaultShell({
        platform: 'win32',
        env: { ...windowsEnv, SHELL },
        isFile: (path) => existing.has(path),
      });
    expect(shell('D:\\pwsh-preview\\pwsh.exe')).toBe('D:\\pwsh-preview\\pwsh.exe');
    expect(shell(powershell)).toBe(powershell);
    // Other shells, an MSYS spelling, a bare name, a missing file, a script: ignored.
    for (const ignored of [
      'D:\\tools\\nu.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Windows\\system32\\cmd.exe',
      '/usr/bin/bash',
      'pwsh.exe',
      'D:\\missing\\pwsh.exe',
      'D:\\pwsh-preview\\pwsh.cmd',
    ]) {
      expect(shell(ignored), ignored).toBe(powershell);
    }
  });

  it('prefers pwsh on Path, then Windows PowerShell, never cmd.exe', () => {
    const bin = mkdtempSync(join(tmpdir(), 'puddle-shell-'));
    writeFileSync(join(bin, 'pwsh.exe'), '');
    expect(
      defaultShell({ platform: 'win32', env: { ...windowsEnv, PATH: bin }, isFile: none }),
    ).toBe(join(bin, 'pwsh.exe'));
    expect(defaultShell({ platform: 'win32', env: windowsEnv, isFile: none })).toBe(powershell);
    expect(
      defaultShell({ platform: 'win32', env: { SystemRoot: 'D:\\WINNT' }, isFile: none }),
    ).toBe('D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('shellKind', () => {
  it('compares POSIX basenames exactly', () => {
    expect(shellKind('/bin/zsh', 'linux')).toBe('zsh');
    expect(shellKind('/opt/homebrew/bin/bash', 'darwin')).toBe('bash');
    expect(shellKind('/usr/bin/fish', 'linux')).toBe('other');
    expect(shellKind('/bin/Bash', 'linux')).toBe('other');
  });

  it('recognises only PowerShell on Windows, ignoring case and .exe', () => {
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe('powershell');
    expect(
      shellKind('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE', 'win32'),
    ).toBe('powershell');
    for (const other of [
      'C:\\WINDOWS\\system32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\bash.exe',
      'C:\\Windows\\Sysnative\\bash.exe',
      'C:\\Program Files\\WSL\\wsl.exe',
      'C:\\msys64\\usr\\bin\\zsh.exe',
    ]) {
      expect(shellKind(other, 'win32'), other).toBe('other');
    }
  });
});

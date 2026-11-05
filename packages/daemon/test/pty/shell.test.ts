import { lstatSync, mkdtempSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultShell,
  isPowerShellAppAlias,
  shellKind,
  type AliasProbe,
} from '../../src/pty/shell.js';

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

  it('finds PowerShell 7 installed from the Microsoft Store, by its App Execution Alias', () => {
    const alias = 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
    const env = { ...windowsEnv, LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    const isPowerShellAlias = (path: string) => path === alias;
    expect(defaultShell({ platform: 'win32', env, isFile: none, isPowerShellAlias })).toBe(alias);
    // SHELL may name it too, though it cannot be stat'ed.
    expect(
      defaultShell({
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows', SHELL: alias },
        isFile: none,
        isPowerShellAlias,
      }),
    ).toBe(alias);
    // An installed pwsh.exe on Path still comes first; no alias, then Windows PowerShell.
    const bin = mkdtempSync(join(tmpdir(), 'puddle-shell-'));
    writeFileSync(join(bin, 'pwsh.exe'), '');
    expect(
      defaultShell({
        platform: 'win32',
        env: { ...env, PATH: bin },
        isFile: none,
        isPowerShellAlias,
      }),
    ).toBe(join(bin, 'pwsh.exe'));
    expect(
      defaultShell({ platform: 'win32', env, isFile: none, isPowerShellAlias: () => false }),
    ).toBe(powershell);
  });
});

describe('isPowerShellAppAlias', () => {
  const denied = () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  };
  const link = { isSymbolicLink: () => true };
  const store = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.5.4.0_x64__8wekyb3d8bbwe';
  const alias = 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
  const probe = (target: string) => ({ stat: denied, lstat: () => link, readlink: () => target });

  it('accepts only an alias of the Store PowerShell’s pwsh.exe', () => {
    expect(isPowerShellAppAlias(alias, probe(`${store}\\pwsh.exe`))).toBe(true);
    expect(
      isPowerShellAppAlias(
        alias,
        probe(
          'C:\\Program Files\\WindowsApps\\Microsoft.PowerShellPreview_7.6.0.5_x64__8wekyb3d8bbwe\\pwsh.exe',
        ),
      ),
    ).toBe(true);
    // Never another Store stub, whatever the alias is called.
    const installer =
      'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe';
    expect(
      isPowerShellAppAlias(alias, probe(`${installer}\\AppInstallerPythonRedirector.exe`)),
    ).toBe(false);
    expect(isPowerShellAppAlias(alias, probe(`${installer}\\pwsh.exe`))).toBe(false);
    expect(
      isPowerShellAppAlias(
        'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe',
        probe(`${store}\\pwsh.exe`),
      ),
    ).toBe(false);
  });

  it('leaves files, missing paths and unreadable links to the ordinary checks', () => {
    const file = { stat: () => ({}), lstat: () => link, readlink: () => `${store}\\pwsh.exe` };
    expect(isPowerShellAppAlias(alias, file)).toBe(false);
    const missing = {
      ...probe(`${store}\\pwsh.exe`),
      stat: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    expect(isPowerShellAppAlias(alias, missing)).toBe(false);
    expect(
      isPowerShellAppAlias(alias, { ...probe(''), lstat: () => ({ isSymbolicLink: () => false }) }),
    ).toBe(false);
    expect(
      isPowerShellAppAlias(alias, {
        ...probe(''),
        readlink: () => {
          throw new Error('EINVAL');
        },
      }),
    ).toBe(false);
  });

  // Windows ships App Execution Aliases of its own (python.exe, winget.exe): read, never changed.
  it.runIf(process.platform === 'win32')(
    'reads this machine’s own Store aliases as Node reports them, by their target',
    () => {
      const local = process.env.LOCALAPPDATA ?? '';
      const real = ['python.exe', 'python3.exe', 'winget.exe']
        .map((name) => join(local, 'Microsoft', 'WindowsApps', name))
        .filter((path) => {
          try {
            return lstatSync(path).isSymbolicLink();
          } catch {
            return false;
          }
        });
      for (const path of real) {
        // Named as the Store PowerShell's would be, Node's own reads of the real alias.
        const asRead: AliasProbe = {
          stat: () => statSync(path),
          lstat: () => lstatSync(path),
          readlink: () => readlinkSync(path),
        };
        expect(isPowerShellAppAlias(alias, asRead), path).toBe(false);
        expect(
          isPowerShellAppAlias(alias, { ...asRead, readlink: () => `${store}\\pwsh.exe` }),
        ).toBe(true);
      }
    },
  );
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

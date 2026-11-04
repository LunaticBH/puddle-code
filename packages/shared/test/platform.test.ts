import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteEnv,
  disableCurrentDirectorySearch,
  envKey,
  findExecutable,
  getEnv,
  isPidAlive,
  killProcessTree,
  pathListDelimiter,
  prependPathEntry,
  renameWithRetry,
  renameWithRetrySync,
  setEnv,
  system32Path,
  windowsExtensions,
} from '../src/node/platform.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-platform-'));
  temporary.push(dir);
  return dir;
}

describe('findExecutable on POSIX', () => {
  const posix = { platform: 'linux' as const };

  it('returns null for an absent name and skips empty PATH entries', () => {
    const dir = directory();
    expect(findExecutable('puddle-absent', { ...posix, path: `::${dir}:` })).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'requires an execute bit, as the daemon always has',
    () => {
      const dir = directory();
      const file = join(dir, 'tool');
      writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
      expect(findExecutable('tool', { ...posix, path: dir })).toBeNull();
      chmodSync(file, 0o755);
      expect(findExecutable('tool', { ...posix, path: dir })).toBe(file);
      expect(findExecutable('tool', { ...posix, env: { PATH: `/nonexistent:${dir}` } })).toBe(file);
      // PATH is case-sensitive on POSIX; PATHEXT means nothing.
      expect(findExecutable('tool', { ...posix, env: { Path: dir } })).toBeNull();
      expect(findExecutable('tool.cmd', { ...posix, path: dir })).toBeNull();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'checks a name with a slash directly and follows symlinks',
    () => {
      const dir = directory();
      const file = join(dir, 'real');
      writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
      symlinkSync(file, join(dir, 'link'));
      expect(findExecutable(join(dir, 'link'), posix)).toBe(join(dir, 'link'));
      expect(findExecutable('link', { ...posix, path: dir })).toBe(join(dir, 'link'));
      expect(findExecutable('./nope/real', posix)).toBeNull();
      mkdirSync(join(dir, 'sub'));
      chmodSync(join(dir, 'sub'), 0o755);
      expect(findExecutable('sub', { ...posix, path: dir })).toBeNull();
    },
  );
});

describe('findExecutable on Windows', () => {
  const windows = { platform: 'win32' as const };

  it('completes names with PATHEXT in order, without an execute bit', () => {
    const dir = directory();
    writeFileSync(join(dir, 'tool.cmd'), '');
    writeFileSync(join(dir, 'tool.exe'), '');
    expect(findExecutable('tool', { ...windows, path: dir })).toBe(join(dir, 'tool.exe'));
    expect(findExecutable('tool', { ...windows, path: dir, pathext: '.CMD;.EXE' })).toBe(
      join(dir, 'tool.cmd'),
    );
    // A bare name without its extension never matches the extensionless file.
    writeFileSync(join(dir, 'bare'), '');
    expect(findExecutable('bare', { ...windows, path: dir })).toBeNull();
  });

  it('tries a name that already has a PATHEXT extension as given', () => {
    const dir = directory();
    writeFileSync(join(dir, 'tool.cmd'), '');
    writeFileSync(join(dir, 'tool.cmd.exe'), '');
    expect(findExecutable('tool.cmd', { ...windows, path: dir })).toBe(join(dir, 'tool.cmd'));
    // Extension comparison is case-insensitive.
    expect(findExecutable('tool.cmd', { ...windows, path: dir, pathext: '.EXE;.CMD' })).toBe(
      join(dir, 'tool.cmd'),
    );
    // An extension outside PATHEXT is completed like any other name.
    writeFileSync(join(dir, 'archive.tar.exe'), '');
    expect(findExecutable('archive.tar', { ...windows, path: dir })).toBe(
      join(dir, 'archive.tar.exe'),
    );
  });

  it('reads Path and PATHEXT case-insensitively, strips quotes and skips empties', () => {
    const first = directory();
    const second = directory();
    writeFileSync(join(second, 'tool.bat'), '');
    const env = { Path: `;"${first}";;"${second}";`, PathExt: '.BAT' };
    expect(findExecutable('tool', { ...windows, env })).toBe(join(second, 'tool.bat'));
    expect(findExecutable('tool', { ...windows, env: { PATH: second } })).toBe(
      join(second, 'tool.bat'),
    );
  });

  it('never resolves a bare name through a relative or drive-relative PATH entry', () => {
    const dir = directory();
    writeFileSync(join(dir, 'tool.exe'), '');
    // Relative entries name whichever directory the process runs in, and
    // libuv would resolve the result against the child's instead.
    const relativeDir = relative(process.cwd(), dir);
    expect(isAbsolute(relativeDir)).toBe(false);
    const env = { PATH: ['.', relativeDir, '\\rooted', ''].join(';') };
    expect(findExecutable('tool', { ...windows, env })).toBeNull();
    expect(findExecutable('tool', { ...windows, env: { PATH: `${relativeDir};${dir}` } })).toBe(
      join(dir, 'tool.exe'),
    );
  });

  it('checks explicit paths directly, with completion, and never searches them on PATH', () => {
    const dir = directory();
    writeFileSync(join(dir, 'tool.exe'), '');
    mkdirSync(join(dir, 'folder.exe'));
    expect(findExecutable(join(dir, 'tool'), windows)).toBe(join(dir, 'tool.exe'));
    expect(findExecutable(join(dir, 'tool.exe'), windows)).toBe(join(dir, 'tool.exe'));
    expect(findExecutable(join(dir, 'folder'), windows)).toBeNull();
    expect(findExecutable('sub\\tool', { ...windows, path: dir })).toBeNull();
    expect(findExecutable('', { ...windows, path: dir })).toBeNull();
  });

  it('defaults PATHEXT when it is unset or holds no extensions', () => {
    expect(windowsExtensions(undefined)).toEqual(['.COM', '.EXE', '.BAT', '.CMD']);
    expect(windowsExtensions(' ; ;')).toEqual(['.COM', '.EXE', '.BAT', '.CMD']);
    expect(windowsExtensions('.EXE; .JS ;bad;.')).toEqual(['.EXE', '.JS']);
  });
});

describe('disableCurrentDirectorySearch', () => {
  it('leaves POSIX untouched, where the working directory is never searched', () => {
    const env: Record<string, string | undefined> = { PATH: '/bin' };
    disableCurrentDirectorySearch(env, 'linux');
    disableCurrentDirectorySearch(env, 'darwin');
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('sets NoDefaultCurrentDirectoryInExePath on Windows, keeping a value already there', () => {
    const env: Record<string, string | undefined> = { Path: 'C:\\Windows' };
    disableCurrentDirectorySearch(env, 'win32');
    expect(env).toEqual({ Path: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: '1' });
    const own: Record<string, string | undefined> = { NODEFAULTCURRENTDIRECTORYINEXEPATH: 'yes' };
    disableCurrentDirectorySearch(own, 'win32');
    expect(own).toEqual({ NODEFAULTCURRENTDIRECTORYINEXEPATH: 'yes' });
  });
});

describe('environment helpers', () => {
  it('use plain keys on POSIX', () => {
    const env: Record<string, string | undefined> = { Path: '/a', PATH: '/b' };
    expect(envKey(env, 'path', 'linux')).toBe('path');
    expect(getEnv(env, 'PATH', 'linux')).toBe('/b');
    setEnv(env, 'path', '/c', 'darwin');
    expect(env).toEqual({ Path: '/a', PATH: '/b', path: '/c' });
    deleteEnv(env, 'PATH', 'linux');
    expect(env).toEqual({ Path: '/a', path: '/c' });
    prependPathEntry(env, '/bin', 'linux');
    expect(env).toEqual({ Path: '/a', path: '/c', PATH: '/bin' });
    expect(pathListDelimiter('linux')).toBe(':');
  });

  it('match keys case-insensitively on Windows without creating duplicates', () => {
    const env: Record<string, string | undefined> = { Path: 'C:\\a', Other: 'x' };
    expect(envKey(env, 'PATH', 'win32')).toBe('Path');
    expect(getEnv(env, 'path', 'win32')).toBe('C:\\a');
    setEnv(env, 'PATH', 'C:\\b', 'win32');
    expect(env).toEqual({ Path: 'C:\\b', Other: 'x' });
    setEnv(env, 'New', '1', 'win32');
    expect(env.New).toBe('1');
    deleteEnv(env, 'PATH', 'win32');
    expect(env).toEqual({ Other: 'x', New: '1' });
    expect(envKey(env, 'Missing', 'win32')).toBe('Missing');
    expect(pathListDelimiter('win32')).toBe(';');
  });

  it('resolve duplicate Windows spellings as child_process does, then collapse them', () => {
    const env: Record<string, string | undefined> = { path: 'lower', Path: 'mixed', PATH: 'upper' };
    // Node sorts the keys and passes the first: 'PATH' < 'Path' < 'path'.
    expect(envKey(env, 'Path', 'win32')).toBe('PATH');
    expect(getEnv(env, 'path', 'win32')).toBe('upper');
    setEnv(env, 'path', 'one', 'win32');
    expect(env).toEqual({ PATH: 'one' });
  });

  it('prepend a PATH entry once on Windows, preserving the rest', () => {
    const env: Record<string, string | undefined> = {
      Path: 'C:\\Windows;"c:\\tools\\";;C:\\Other\\Tools;C:\\TOOLS',
    };
    prependPathEntry(env, 'C:\\Tools', 'win32');
    expect(env).toEqual({ Path: 'C:\\Tools;C:\\Windows;;C:\\Other\\Tools' });
    prependPathEntry(env, 'C:\\', 'win32');
    expect(env.Path).toBe('C:\\;C:\\Tools;C:\\Windows;;C:\\Other\\Tools');
    const empty: Record<string, string | undefined> = {};
    prependPathEntry(empty, 'C:\\bin', 'win32');
    expect(empty).toEqual({ PATH: 'C:\\bin' });
  });

  it('prepend on POSIX compares exactly and keeps empty entries', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin::/opt/x:/OPT/X:/opt/x' };
    prependPathEntry(env, '/opt/x', 'darwin');
    expect(env.PATH).toBe('/opt/x:/usr/bin::/OPT/X');
  });

  it('locate System32 tools from SystemRoot', () => {
    expect(system32Path('taskkill.exe', { SYSTEMROOT: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\taskkill.exe',
    );
    expect(system32Path('icacls.exe', { windir: 'E:\\W' })).toBe('E:\\W\\System32\\icacls.exe');
    expect(system32Path('whoami.exe', {})).toBe('C:\\Windows\\System32\\whoami.exe');
  });
});

describe('isPidAlive', () => {
  it('reports this process alive and rejects pids that would address groups', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(isPidAlive(pid)).toBe(false);
  });

  it('reports an exited child as dead', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    expect(isPidAlive(child.pid!)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('treats EPERM as alive on Windows only', () => {
    // The System process (pid 4) exists but cannot be opened by a user.
    expect(isPidAlive(4, 'win32')).toBe(true);
    expect(isPidAlive(4, 'linux')).toBe(false);
  });
});

describe('killProcessTree', () => {
  it('rejects pids that are not positive integers', async () => {
    await expect(killProcessTree(0)).rejects.toThrow(RangeError);
    await expect(killProcessTree(-5, { platform: 'linux' })).rejects.toThrow(RangeError);
  });

  it('stops a process and its descendants, and resolves for a missing one', async () => {
    const dir = directory();
    const marker = join(dir, 'grandchild.pid');
    // A child that starts a grandchild, records its pid, and then waits.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });",
      `writeFileSync(${JSON.stringify(marker)}, String(g.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    for (let i = 0; i < 200 && !existsSync(marker); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const grandchild = Number(readFileSync(marker, 'utf8'));
    expect(isPidAlive(grandchild)).toBe(true);
    await killProcessTree(child.pid!);
    await exited;
    if (process.platform === 'win32') {
      // taskkill /T reaches descendants however they were started.
      for (let i = 0; i < 40 && isPidAlive(grandchild); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isPidAlive(grandchild)).toBe(false);
    } else {
      // POSIX only reaches the leader's own group; this grandchild has its own.
      process.kill(grandchild, 'SIGKILL');
    }
    await expect(killProcessTree(child.pid!)).resolves.toBeUndefined();
  });
});

describe('renameWithRetry', () => {
  it('replaces the target on every platform', async () => {
    const dir = directory();
    writeFileSync(join(dir, 'a'), 'one');
    renameWithRetrySync(join(dir, 'a'), join(dir, 'target'));
    writeFileSync(join(dir, 'b'), 'two');
    await renameWithRetry(join(dir, 'b'), join(dir, 'target'));
    expect(readFileSync(join(dir, 'target'), 'utf8')).toBe('two');
  });

  it('fails at once for errors that retrying cannot fix', async () => {
    const dir = directory();
    const started = performance.now();
    expect(() => renameWithRetrySync(join(dir, 'missing'), join(dir, 'x'), 'win32')).toThrow(
      /ENOENT/,
    );
    await expect(renameWithRetry(join(dir, 'missing'), join(dir, 'x'), 'win32')).rejects.toThrow(
      /ENOENT/,
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.skipIf(process.platform !== 'win32')(
    'retries on Windows until a reader closes the target',
    async () => {
      const dir = directory();
      const target = join(dir, 'state.json');
      writeFileSync(target, 'old');
      // Node opens files without FILE_SHARE_DELETE, so the replace is refused while this is open.
      const handle = await open(target, 'r');
      writeFileSync(join(dir, 'next'), 'new');
      setTimeout(() => void handle.close(), 150);
      await renameWithRetry(join(dir, 'next'), target);
      expect(readFileSync(target, 'utf8')).toBe('new');

      const held = await open(target, 'r');
      writeFileSync(join(dir, 'again'), 'newer');
      const started = performance.now();
      await expect(renameWithRetry(join(dir, 'again'), target)).rejects.toThrow(
        /EPERM|EACCES|EBUSY/,
      );
      expect(performance.now() - started).toBeGreaterThan(800);
      await held.close();
      expect(() => renameWithRetrySync(join(dir, 'again'), target)).not.toThrow();
    },
  );
});

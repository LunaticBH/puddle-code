import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  spawn: vi.fn(),
  lstat: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execute, spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ lstat: mocks.lstat, stat: mocks.stat }));
import { localFileManager } from '../../src/lib/host/file-manager.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.execute.mockImplementation((_command, _args, _options, callback) => callback(null, '', ''));
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  mocks.lstat.mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => false });
});

describe('local file-manager integration', () => {
  it('reveals literal file paths without a shell and opens directories specifically in Finder', async () => {
    const path = '/work/project/space $(touch marker); "quoted".txt';
    await localFileManager('darwin')!.reveal(path, () => true);
    expect(mocks.execute).toHaveBeenLastCalledWith(
      '/usr/bin/open',
      ['-R', '--', path],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
    mocks.lstat.mockResolvedValue({ isDirectory: () => true });
    await localFileManager('darwin')!.reveal('/work/Example.app', () => true);
    expect(mocks.execute).toHaveBeenLastCalledWith(
      '/usr/bin/open',
      ['-a', 'Finder', '--', '/work/Example.app'],
      expect.not.objectContaining({ shell: true }),
      expect.any(Function),
    );
  });

  it('selects Windows files and opens folders with Explorer, without cmd.exe', async () => {
    const explorer = expect.stringMatching(/^[A-Za-z]:\\.*\\explorer\.exe$/i);
    const path = 'C:\\project files\\notes.txt';
    await localFileManager('win32')!.reveal(path, () => true);
    expect(mocks.spawn).toHaveBeenLastCalledWith(explorer, ['/select,', path], {
      stdio: 'ignore',
      detached: true,
    });
    expect(mocks.spawn.mock.lastCall![0]).not.toMatch(/system32/i);
    mocks.lstat.mockResolvedValue({ isDirectory: () => true });
    await localFileManager('win32')!.reveal('C:\\project files', () => true);
    expect(mocks.spawn).toHaveBeenLastCalledWith(explorer, ['C:\\project files'], {
      stdio: 'ignore',
      detached: true,
    });
  });

  it('hands Explorer the native form of a forward-slashed Windows path', async () => {
    await localFileManager('win32')!.reveal('C:/project files/notes.txt', () => true);
    expect(mocks.spawn.mock.lastCall![1]).toEqual(['/select,', 'C:\\project files\\notes.txt']);
  });

  it('uses Linux selection and folder methods, falling back only to a directory opener', async () => {
    await localFileManager('linux')!.reveal('/work/a b,#.txt', () => true);
    expect(mocks.execute.mock.calls[0]![1]).toEqual(
      expect.arrayContaining([
        'org.freedesktop.FileManager1.ShowItems',
        '["file:///work/a%20b,%23.txt"]',
        '',
      ]),
    );
    mocks.execute.mockImplementationOnce((_command, _args, _options, callback) =>
      callback(new Error('No D-Bus file manager')),
    );
    await localFileManager('linux')!.reveal('/work/a b,#.txt', () => true);
    expect(mocks.spawn).toHaveBeenLastCalledWith('xdg-open', ['/work'], {
      stdio: 'ignore',
      detached: true,
    });
    mocks.lstat.mockResolvedValue({ isDirectory: () => true });
    await localFileManager('linux')!.reveal('/work', () => true);
    expect(mocks.execute.mock.lastCall![1]).toContain('org.freedesktop.FileManager1.ShowFolders');
  });

  it('preserves symlink paths and can select a broken link', async () => {
    mocks.lstat.mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => true });
    mocks.stat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce(new Error('Missing'));
    await localFileManager('darwin')!.reveal('/work/link', () => true);
    expect(mocks.execute.mock.lastCall![1]).toEqual(['-a', 'Finder', '--', '/work/link']);
    await localFileManager('darwin')!.reveal('/work/broken', () => true);
    expect(mocks.execute.mock.lastCall![1]).toEqual(['-R', '--', '/work/broken']);
  });

  it('reports a native launcher that cannot start', async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('File manager unavailable')));
      return child;
    });
    await expect(
      localFileManager('win32')!.reveal('C:\\work\\file.txt', () => true),
    ).rejects.toThrow('File manager unavailable');
  });

  it('refuses relative paths, missing files, and revoked authority before invoking the OS', async () => {
    const manager = localFileManager('darwin')!;
    await expect(manager.reveal('../file', () => true)).rejects.toThrow('absolute');
    await expect(manager.reveal('/work/\0file', () => true)).rejects.toThrow('absolute');
    await expect(manager.reveal('/work/file', () => false)).rejects.toThrow('authorisation');
    mocks.lstat.mockRejectedValueOnce(new Error('No such file'));
    await expect(manager.reveal('/work/missing', () => true)).rejects.toThrow('No such file');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(localFileManager('aix')).toBeUndefined();
  });
});

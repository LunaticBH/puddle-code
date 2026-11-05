import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { windowsProcessTree, type WindowsProcess } from '@puddle/shared/node/platform';
import {
  clearPtyRoots,
  conptyRootBounds,
  ptyRootsFile,
  readPtyRoots,
  writePtyRoots,
} from '../../src/pty/pty-roots.js';

describe('the ConPTY roots record', () => {
  const file = () => ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-pty-roots-')));
  const roots = [
    { pid: 10, startedAtMs: 1000, spawnedAtMs: 1010 },
    {
      pid: 20,
      startedAtMs: 2000,
      spawnedAtMs: 2005,
      createdAtMs: 2004,
      exitedAtMs: 9000,
      host: { pid: 30, createdAtMs: 2002 },
    },
  ];

  it('lives in the home and is read back by the daemon that wrote it only', () => {
    const path = file();
    expect(path.endsWith('pty-roots.json')).toBe(true);
    expect(readPtyRoots(path, 42)).toBeNull();
    writePtyRoots(path, 42, roots);
    expect(readPtyRoots(path, 42)).toEqual(roots);
    expect(readPtyRoots(path, 43)).toBeNull();
    writePtyRoots(path, 42, []);
    expect(readPtyRoots(path, 42)).toEqual([]);
    clearPtyRoots(path);
    expect(existsSync(path)).toBe(false);
    clearPtyRoots(path); // already gone
  });

  it('ignores a malformed record and malformed entries', () => {
    const path = file();
    writeFileSync(path, 'not json');
    expect(readPtyRoots(path, 42)).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({
        daemon: 42,
        roots: [
          roots[0],
          { pid: -1, startedAtMs: 1, spawnedAtMs: 1 },
          { pid: 7, startedAtMs: 'soon', spawnedAtMs: 1 },
          null,
          // A creation, host or exit that is not one is dropped, the root kept.
          {
            pid: 8,
            startedAtMs: 1,
            spawnedAtMs: 2,
            createdAtMs: 1.5,
            exitedAtMs: 'later',
            host: { pid: 0 },
          },
        ],
      }),
    );
    expect(readPtyRoots(path, 42)).toEqual([roots[0], { pid: 8, startedAtMs: 1, spawnedAtMs: 2 }]);
  });

  it('bounds a root’s creation by its spawn, allowing the table’s clock slack only', () => {
    // node-pty creates it inside pty.spawn.
    expect(conptyRootBounds(roots[0]!)).toEqual({ startedAtMs: 1000, createdBeforeMs: 1010 });
    const holder = (createdAtMs: number): WindowsProcess => ({
      pid: 10,
      ppid: 4,
      name: 'node.exe',
      command: 'node',
      commandLine: 'node',
      createdAtMs,
    });
    const tree = (createdAtMs: number) =>
      windowsProcessTree([holder(createdAtMs)], { pid: 10, ...conptyRootBounds(roots[0]!) });
    expect(tree(1050)).toHaveLength(1);
    // 150 ms after pty.spawn returned: another process holds the pid (a second was allowed before).
    expect(tree(1160)).toEqual([]);
  });
});

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    { pid: 20, startedAtMs: 2000, spawnedAtMs: 2005 },
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
        ],
      }),
    );
    expect(readPtyRoots(path, 42)).toEqual([roots[0]]);
  });

  it('bounds a root’s creation to just after its spawn', () => {
    // node-pty creates it inside pty.spawn: a second covers any clock rounding.
    expect(conptyRootBounds(roots[0]!)).toEqual({ startedAtMs: 1000, createdBeforeMs: 2010 });
  });
});

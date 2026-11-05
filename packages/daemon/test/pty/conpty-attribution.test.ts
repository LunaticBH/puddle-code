import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_MARGIN_MS,
  attributeRoot,
  chooseHost,
  type SpawnWindow,
} from '../../src/pty/conpty-jobs.js';

/**
 * Which spawn a ConPTY root or console host is (conpty-jobs.ts), against
 * injected spawn windows and creation times: `pty.spawn` creates the host a
 * few milliseconds in and the root at its end, and spawns never overlap, so
 * a process is a spawn's only when it is nearer that spawn than any other.
 * Without this, a PTY whose own host had gone took a neighbour's.
 */

// Two spawns 45 ms apart, as back-to-back spawns are: A's host at 1005, its
// root at 1043; B's host at 1050, its root at 1088.
const a: SpawnWindow = { startedAtMs: 1000, spawnedAtMs: 1045 };
const b: SpawnWindow = { startedAtMs: 1045, spawnedAtMs: 1090 };
const spawns = [a, b];
const hostA = { pid: 30, createdAtMs: 1005 };
const hostB = { pid: 31, createdAtMs: 1050 };

describe('attributeRoot', () => {
  it('takes a root created at its own spawn’s end, a few ms either side', () => {
    for (const at of [1040, 1045, 1048]) expect(attributeRoot(at, a, spawns)).toBe(true);
  });

  it('never takes a neighbour’s root, which took a dead root’s pid', () => {
    // A's root exited at once and B's root got its pid.
    expect(attributeRoot(1088, a, spawns)).toBe(false);
    expect(attributeRoot(1088, b, spawns)).toBe(true);
  });

  it('never takes a process created as near another spawn as its own', () => {
    expect(attributeRoot(1045 + 22, a, spawns)).toBe(false);
  });
});

describe('chooseHost', () => {
  it('takes the host the root runs in, created before it', () => {
    expect(chooseHost([hostA, hostB], hostA.pid, 1043, a, spawns)).toEqual(hostA);
    // Named by a root it was created after: not its console's.
    expect(chooseHost([hostB], hostB.pid, 1043, a, spawns)).toBeNull();
  });

  it('without a root, takes the host only its own spawn could have created', () => {
    expect(chooseHost([hostA, hostB], 0, null, a, spawns)).toEqual(hostA);
    expect(chooseHost([hostA, hostB], 0, null, b, spawns)).toEqual(hostB);
  });

  it('never takes a neighbour’s host, even when it is the only one left', () => {
    // A's own host has gone (its console was closed); B's is the one candidate.
    expect(chooseHost([hostB], 0, null, a, spawns)).toBeNull();
    // Nor when the neighbour spawned before it.
    expect(chooseHost([hostA], 0, null, b, spawns)).toBeNull();
  });

  it('takes no host when two are as near its start', () => {
    const twin = { pid: 32, createdAtMs: 1005 + ATTRIBUTION_MARGIN_MS - 1 };
    expect(chooseHost([hostA, twin], 0, null, a, [a])).toBeNull();
    const far = { pid: 33, createdAtMs: 1005 + ATTRIBUTION_MARGIN_MS + 5 };
    expect(chooseHost([hostA, far], 0, null, a, [a])).toEqual(hostA);
  });

  it('takes nothing without candidates', () => {
    expect(chooseHost([], 0, null, a, spawns)).toBeNull();
  });
});

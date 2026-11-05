import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConptyConsole, ConsoleMember, ConsoleScan } from '../../src/pty/conpty-jobs.js';
import { consoleTargets, endConsole, ExitDeadline } from '../../src/pty/conpty-teardown.js';

/**
 * What a ConPTY's end ends, against a stand-in helper, so the rule is
 * exercised on any OS (the real one is in windows-pty-teardown.test.ts):
 * what is attached to its console, never a GUI programme or what left it,
 * then its host.
 */

const HOST = 7000;
const ROOT = 10;
const member = (
  pid: number,
  createdAtMs: number,
  consoleHost = HOST,
  more: Partial<ConsoleMember> = {},
): ConsoleMember => ({
  pid,
  createdAtMs,
  key: `${pid}@${createdAtMs}`,
  gui: false,
  consoleHost,
  listed: false,
  ...more,
});
const scan = (members: ConsoleMember[], rootAlive = true, hostAlive = true): ConsoleScan => ({
  rootAlive,
  hostAlive,
  members,
});
const held = { pid: ROOT, console: { rootCreatedAtMs: 100, host: { pid: HOST, createdAtMs: 90 } } };

describe('consoleTargets', () => {
  it('takes what is attached to the console, never a GUI programme nor another console’s', () => {
    const targets = consoleTargets(
      scan([
        member(ROOT, 100),
        member(11, 200),
        member(12, 300, HOST, { gui: true }),
        member(13, 400, 8000),
        member(14, 500, 0),
      ]),
      held,
      { root: false },
    );
    expect(targets).toEqual(['11@200']);
  });

  it('takes the root only when asked, as the root, whatever its image', () => {
    const members = [member(11, 200), member(ROOT, 100, HOST, { gui: true })];
    expect(consoleTargets(scan(members), held, { root: true })).toEqual(['root', '11@200']);
    expect(consoleTargets(scan(members, false), held, { root: true })).toEqual(['11@200']);
  });

  it('never takes a later holder of the root’s pid for the root', () => {
    // Another console's process that took pid 10 after the root exited.
    const reuser = member(ROOT, 5000, 8000);
    expect(consoleTargets(scan([reuser], false), held, { root: true })).toEqual([]);
  });

  it('takes the root only while it is attached to the console', () => {
    // The process held as the root runs in another console: it is not this PTY's.
    const elsewhere = member(ROOT, 100, 8000);
    expect(consoleTargets(scan([elsewhere]), held, { root: true })).toEqual([]);
    // Nor one that runs and was never seen attached.
    expect(consoleTargets(scan([]), held, { root: true })).toEqual([]);
  });

  it('never takes a process left naming a host that was terminated, once its pid is this host’s', () => {
    // 17 ran in a console whose host (pid 7000 then) was terminated; this
    // console's host took the pid at 90: 17 still names it, but was created before it.
    const stale = member(17, 50, HOST);
    expect(consoleTargets(scan([stale, member(11, 200)]), held, { root: false })).toEqual([
      '11@200',
    ]);
    // The console's own list is the console's word.
    expect(
      consoleTargets(scan([member(17, 50, HOST, { listed: true })]), held, { root: false }),
    ).toEqual(['17@50']);
  });

  it('goes by the console’s own list when the host was never told apart', () => {
    const untold = { pid: ROOT, console: { rootCreatedAtMs: 100, host: null } };
    const members = [member(11, 200, -1, { listed: true }), member(12, 300, -1)];
    expect(consoleTargets(scan(members), untold, { root: false })).toEqual(['11@200']);
  });
});

/** A helper's hold whose scans answer `scans` in turn, recording what it is asked. */
function holding(scans: (ConsoleScan | null)[], host: ConptyConsole['host'] = held.console.host) {
  const asked: string[] = [];
  const terminated: string[][] = [];
  const hold: ConptyConsole = {
    rootCreatedAtMs: 100,
    host,
    alive: async () => ({ root: false, host: true }),
    scan: async ({ attach }) => {
      asked.push(attach ? 'scan+list' : 'scan');
      return scans.length > 1 ? scans.shift()! : (scans[0] ?? null);
    },
    terminate: async (keys) => {
      terminated.push([...keys]);
      return keys.length;
    },
    release: () => {},
  };
  return { hold, asked, terminated };
}

describe('endConsole', () => {
  it('ends what is attached, reads the console again, then ends its host', async () => {
    const c = holding([scan([member(11, 200), member(12, 300)], false), scan([], false)]);
    expect(await endConsole(ROOT, c.hold, { root: true, host: true, attach: true })).toBe(3);
    expect(c.terminated).toEqual([['11@200', '12@300'], ['host']]);
    // The console's own list once; then each process's console host.
    expect(c.asked).toEqual(['scan+list', 'scan']);
  });

  it('ends a process started meanwhile, and never one that took a held member’s pid', async () => {
    const c = holding([
      scan([member(11, 200)], false),
      // 11 has gone and its pid names another console's process; 15 is new here.
      scan([member(11, 900, 8000), member(15, 950)], false),
      scan([], false),
    ]);
    await endConsole(ROOT, c.hold, { root: false, host: true, attach: false });
    expect(c.terminated).toEqual([['11@200'], ['15@950'], ['host']]);
  });

  it('ends no host that has gone, and leaves the host when asked to', async () => {
    const gone = holding([scan([], false, false)]);
    expect(await endConsole(ROOT, gone.hold, { root: true, host: true, attach: false })).toBe(0);
    expect(gone.terminated).toEqual([]);
    const kept = holding([scan([member(11, 200)]), scan([])]);
    await endConsole(ROOT, kept.hold, { root: false, host: false, attach: false });
    expect(kept.terminated).toEqual([['11@200']]);
  });

  it('ends the host after three rounds of a console that keeps filling', async () => {
    let next = 200;
    const filling: ConptyConsole = {
      ...holding([]).hold,
      scan: async () => scan([member(next, next++)]),
    };
    const terminated: string[][] = [];
    filling.terminate = async (keys) => {
      terminated.push([...keys]);
      return keys.length;
    };
    await endConsole(ROOT, filling, { root: false, host: true, attach: false });
    expect(terminated).toEqual([['200@200'], ['201@201'], ['202@202'], ['host']]);
  });

  it('ends nothing when the helper does not answer', async () => {
    const c = holding([null]);
    expect(await endConsole(ROOT, c.hold, { root: true, host: true, attach: true })).toBe(0);
    expect(c.terminated).toEqual([]);
  });

  it('keeps reading the console’s own list when the host was never told apart', async () => {
    // (A host never told apart is never alive.)
    const c = holding(
      [
        scan([member(ROOT, 100, -1, { listed: true }), member(11, 200, -1, { listed: true })]),
        scan([], false, false),
      ],
      null,
    );
    await endConsole(ROOT, c.hold, { root: true, host: true, attach: true });
    expect(c.asked).toEqual(['scan+list', 'scan+list']);
    expect(c.terminated).toEqual([['root', '11@200']]);
  });
});

describe('ExitDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only ever comes closer', () => {
    let now = 1000;
    const deadline = new ExitDeadline(() => now);
    expect(deadline.ms).toBe(Infinity);
    deadline.within(4500);
    expect(deadline.ms).toBe(5500);
    now = 2000;
    deadline.within(5000);
    expect(deadline.ms).toBe(5500);
    deadline.within(250);
    expect(deadline.ms).toBe(2250);
  });

  it('settles a race with the work’s value, or with the fallback at the deadline', async () => {
    vi.useFakeTimers();
    const deadline = new ExitDeadline(() => Date.now());
    expect(await deadline.race(Promise.resolve('done'), 'late')).toBe('done');
    deadline.within(1000);
    const slow = deadline.race(new Promise<string>(() => {}), 'late');
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void slow.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await slow).toBe('late');
  });

  it('wakes a race waiting on no deadline, or a later one, when it comes forward', async () => {
    vi.useFakeTimers();
    const deadline = new ExitDeadline(() => Date.now());
    const never = deadline.race(new Promise<number>(() => {}), -1);
    deadline.within(10_000);
    const later = deadline.race(new Promise<number>(() => {}), -2);
    await vi.advanceTimersByTimeAsync(4000);
    deadline.within(250); // a SIGKILL
    await vi.advanceTimersByTimeAsync(250);
    expect(await never).toBe(-1);
    expect(await later).toBe(-2);
  });

  it('treats a rejected work as late', async () => {
    const deadline = new ExitDeadline();
    expect(await deadline.race(Promise.reject(new Error('no helper')), 'late')).toBe('late');
  });
});

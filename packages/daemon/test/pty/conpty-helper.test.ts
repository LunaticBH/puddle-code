import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import { listWindowsProcesses, type WindowsProcess } from '@puddle/shared/node/platform';
import { guardConsoleListKill } from '../../src/pty/conpty-console-list.js';
import {
  ATTACH_MARGIN_MS,
  ConptyHelper,
  conptyHelperLaunch,
  HELPER_ARGS,
  isConptyHelper,
  noteConptySpawn,
} from '../../src/pty/conpty-jobs.js';
import { endConsole } from '../../src/pty/conpty-teardown.js';
import { onTeardown } from '../helpers/process-guard.js';
import {
  consoleVisitorProgram,
  conptyHosts,
  guiProgram,
  marked,
  stillRunning,
  stopMarked,
  survivors,
  waitUntil,
} from '../helpers/process-trees.js';

/**
 * The ConPTY helper (docs/windows.md, decision 8): its protocol against a
 * stand-in on any OS, then the real one on Windows, which names what is
 * attached to a PTY's console, holds it open and ends only that.
 */

const fake = fileURLToPath(new URL('../helpers/fake-conpty-helper.mjs', import.meta.url));
const helpers: ConptyHelper[] = [];
function fakeHelper(mode: string, options: { startMs?: number; answerMs?: number } = {}) {
  const lost: string[] = [];
  const helper = new ConptyHelper({
    worker: { file: process.execPath, args: [fake, mode] },
    onLost: (reason) => lost.push(reason),
    parentPid: 4000,
    ...options,
  });
  helpers.push(helper);
  return { helper, lost };
}

afterEach(() => {
  for (const helper of helpers.splice(0)) {
    const pid = helper.pid;
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch {
        // Gone already.
      }
    }
  }
});

// A spawn that began at 1 000 000 and returned 50 ms later (no clock slack).
const window = {
  fromMs: 1_000_000,
  toMs: 1_000_050,
  startedAtMs: 1_000_000,
  spawnedAtMs: 1_000_050,
};

describe('ConptyHelper', () => {
  it('holds a root and its console host, and reads what is attached', async () => {
    const { helper } = fakeHelper('serve');
    expect(await helper.ready()).toBe(true);
    const held = await helper.track(5, window);
    expect(held).toMatchObject({
      rootCreatedAtMs: window.toMs,
      host: { pid: 7000, createdAtMs: window.fromMs },
    });
    const scan = await held!.scan({ attach: true });
    const member = (pid: number, createdAtMs: number, more: object) => ({
      pid,
      createdAtMs,
      key: `${pid}@${createdAtMs}`,
      gui: false,
      guiStarted: false,
      consoleHost: 7000,
      listed: false,
      ...more,
    });
    expect(scan).toEqual({
      rootAlive: true,
      hostAlive: true,
      members: [
        member(10, 100, { listed: true }),
        member(11, 200, { listed: true }),
        member(12, 300, { gui: true }),
        member(14, 350, { guiStarted: true }),
        member(13, 400, { consoleHost: 8000 }),
      ],
    });
    expect(await held!.terminate(['root', '11@200'])).toBe(2);
    expect(await held!.alive()).toEqual({ root: false, host: true });
    held!.release();
    // Released, it holds nothing any more.
    expect(await held!.scan({ attach: false })).toBeNull();
  });

  it('sends nothing but numbers and the keys it was given', async () => {
    const { helper } = fakeHelper('serve');
    const held = await helper.track(5, window);
    expect(await held!.terminate(['root; Remove-Item', '1@2 3', '../x'])).toBe(0);
    // An attach-by that is no number is none: the request's own bound counts.
    const scan = await held!.scan({ attach: true, attachByMs: Number.NaN });
    expect(scan!.members.filter((m) => m.listed).map((m) => m.pid)).toEqual([10, 11]);
  });

  it('never has the helper attach to a console once whoever asked may have given up on it', async () => {
    const { helper } = fakeHelper('serve');
    const held = await helper.track(5, window);
    const listed = async (options: { attach: boolean; attachByMs?: number }) =>
      (await held!.scan(options))!.members.filter((m) => m.listed).map((m) => m.pid);
    expect(await listed({ attach: true, attachByMs: Date.now() + 60_000 })).toEqual([10, 11]);
    // Past it, the console may be closing: the helper attached to it would end with it.
    // (Well past: two processes' clocks may differ by a few milliseconds.)
    expect(await listed({ attach: true, attachByMs: Date.now() - 10_000 })).toEqual([]);
    expect(await listed({ attach: false })).toEqual([]);
    // Nor later than the margin before the helper's own bound on the answer.
    const { helper: brief } = fakeHelper('serve', { answerMs: ATTACH_MARGIN_MS - 200 });
    const quick = await brief.track(5, window);
    expect((await quick!.scan({ attach: true }))!.members.some((m) => m.listed)).toBe(false);
  });

  it('tells a root that had exited, or whose pid another process took, from one it holds', async () => {
    const { helper } = fakeHelper('serve');
    // Its host is still told apart: the one created nearest its start.
    const host = { pid: 7000, createdAtMs: window.fromMs };
    expect(await helper.track(1500, window)).toMatchObject({ rootCreatedAtMs: null, host });
    expect(await helper.track(2500, window)).toMatchObject({ rootCreatedAtMs: null, host });
    expect(await helper.track(0, window)).toBeNull();
    expect(await helper.track(-3, window)).toBeNull();
  });

  it('never takes the console host of a PTY spawned just after for its own', async () => {
    const { helper } = fakeHelper('serve');
    const at = 5_000_000;
    const own = { fromMs: at, toMs: at + 40, startedAtMs: at, spawnedAtMs: at + 40 };
    // The next spawn began as this one returned; its host is created 40 ms after this one's.
    noteConptySpawn({ startedAtMs: at + 40, spawnedAtMs: at + 85 });
    // This PTY's own host had gone: the next one's is the one candidate.
    expect(await helper.track(3500, own)).toMatchObject({ rootCreatedAtMs: null, host: null });
    // With both there, its own.
    expect(await helper.track(2500, own)).toMatchObject({
      host: { pid: 7000, createdAtMs: at },
    });
  });

  it('holds nothing when the helper cannot start, as under Constrained Language Mode', async () => {
    const { helper } = fakeHelper('fail');
    expect(await helper.ready()).toBe(false);
    expect(await helper.track(5, window)).toBeNull();
    // Not tried again at once.
    expect(await helper.ready()).toBe(false);
  });

  it('stops a helper that never becomes ready, which holds nothing', async () => {
    const { helper } = fakeHelper('mute', { startMs: 300 });
    const started = Date.now();
    expect(await helper.ready()).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(helper.pid).toBeUndefined();
  });

  it('says so when a helper holding PTYs exits, ending nothing, and starts another', async () => {
    const { helper, lost } = fakeHelper('quit-after-track');
    const held = await helper.track(5, window);
    expect(held).not.toBeNull();
    await waitUntil(() => lost.length === 1, 10_000, 'the helper’s exit');
    expect(lost[0]).toMatch(/exit code 0/);
    // What it held is no longer told apart.
    expect(await held!.scan({ attach: false })).toBeNull();
    expect(await held!.terminate(['root'])).toBe(0);
    expect(await helper.track(6, window)).not.toBeNull();
  });

  it('fails a request answered too late without stopping the helper', async () => {
    const { helper, lost } = fakeHelper('slow-scan', { answerMs: 200 });
    const held = await helper.track(5, window);
    const pid = helper.pid;
    expect(await held!.scan({ attach: true })).toBeNull();
    expect(helper.pid).toBe(pid);
    expect(await held!.alive()).toEqual({ root: true, host: true });
    expect(lost).toEqual([]);
  });

  it('adopts a recorded console host only while it is that process, and classifies', async () => {
    const { helper } = fakeHelper('serve');
    expect(await helper.adopt({ pid: 7001, createdAtMs: 5, parentPid: 4000 })).toBeNull();
    const host = await helper.adopt({ pid: 7000, createdAtMs: 5, parentPid: 4000 });
    expect(host?.host).toEqual({ pid: 7000, createdAtMs: 5 });
    expect(host?.rootCreatedAtMs).toBeNull();
    // With the PTY's root, while it is still the one recorded.
    const root = { pid: 10, createdAtMs: 4 };
    const held = await helper.adopt({ pid: 7000, createdAtMs: 5, parentPid: 4000, root });
    expect(held).toMatchObject({ rootCreatedAtMs: 4, host: { pid: 7000, createdAtMs: 5 } });
    expect(await held!.alive()).toEqual({ root: true, host: true });
    const other = { pid: 1010, createdAtMs: 4 };
    expect(
      (await helper.adopt({ pid: 7000, createdAtMs: 5, parentPid: 4000, root: other }))
        ?.rootCreatedAtMs,
    ).toBeNull();
    const classified = await helper.classify([
      { pid: 20, createdAtMs: 1 },
      { pid: 1020, createdAtMs: 2 },
      { pid: 2020, createdAtMs: 3 },
      { pid: 3020, createdAtMs: 4 },
    ]);
    expect(classified?.processes).toEqual([
      { pid: 20, createdAtMs: 1, key: '20@1', gui: false, consoleHost: 7000 },
      { pid: 1020, createdAtMs: 2, key: '1020@2', gui: true, consoleHost: 7000 },
      { pid: 2020, createdAtMs: 3, key: '2020@3', gui: false, consoleHost: 0 },
    ]);
    classified!.console.release();
  });

  it('is told apart from every other PowerShell by its command line', () => {
    expect(isConptyHelper(`powershell.exe ${HELPER_ARGS.join(' ')}`)).toBe(true);
    expect(
      isConptyHelper(
        'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -',
      ),
    ).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('the ConPTY helper on Windows', () => {
  const markers: string[] = [];
  const strays: WindowsProcess[] = [];
  const consoles: pty.IPty[] = [];
  afterEach(async () => {
    // Closing a console ends what is attached to it while its root runs.
    for (const proc of consoles.splice(0)) {
      try {
        proc.kill();
      } catch {
        // Gone already.
      }
    }
    for (const marker of markers.splice(0)) await stopMarked(marker);
    for (const stray of strays.splice(0)) {
      try {
        process.kill(stray.pid);
      } catch {
        // Gone already.
      }
    }
  });

  /**
   * A cmd.exe ConPTY (node-pty itself) that has started, from `dir`, a
   * console child (ping, attached), a node in a console of its own (Start-Process),
   * and the GUI programme.
   */
  async function cmdConsole(helper: ConptyHelper) {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-helper-'));
    markers.push(dir);
    const fromMs = Date.now();
    const proc = pty.spawn('cmd.exe', ['/d', '/k'], { cols: 100, rows: 30, cwd: dir });
    const toMs = Date.now();
    guardConsoleListKill(proc);
    let output = '';
    proc.onData((data) => (output += data));
    consoles.push(proc);
    const held = await helper.track(proc.pid, {
      fromMs: fromMs - 100,
      toMs: toMs + 100,
      startedAtMs: fromMs,
      spawnedAtMs: toMs,
    });
    await waitUntil(() => output.includes('>'), 20_000, 'a prompt');
    const gui = await guiProgram();
    proc.write(`start "" /b ping -n 120 -w 1000 127.0.0.1 > nul & rem ${dir}:ping\r`);
    // (Windows PowerShell's -ArgumentList joins its arguments unquoted: no spaces.)
    proc.write(
      `powershell -NoLogo -NoProfile -Command "Start-Process -WindowStyle Hidden ` +
        `'${process.execPath}' -ArgumentList '-e','setInterval(()=>{},1e9)','${dir}:own-console'"\r`,
    );
    proc.write(`"${gui}" 120 "${dir}:gui"\r`);
    let named: WindowsProcess[] = [];
    await waitUntil(
      async () => (named = await marked(dir)).length === 2,
      20_000,
      'the Start-Process child and the GUI programme',
    );
    // Once the PowerShell that started one has exited.
    await waitUntil(
      async () =>
        !(await listWindowsProcesses({ fresh: true })).some(
          (p) => p.ppid === proc.pid && p.name.toLowerCase() === 'powershell.exe',
        ),
      20_000,
      'PowerShell’s exit',
    );
    let ping: WindowsProcess[] = [];
    await waitUntil(
      async () =>
        (ping = (await listWindowsProcesses({ fresh: true })).filter(
          (p) => p.ppid === proc.pid && p.name.toLowerCase() === 'ping.exe',
        )).length === 1,
      20_000,
      'ping',
    );
    strays.push(...ping);
    return { proc, held, fromMs, toMs, ping: ping[0]!, left: named, dir };
  }

  it('names the PTY’s own console host, and only what is attached to its console', async () => {
    const helper = new ConptyHelper();
    helpers.push(helper);
    const { proc, held, fromMs, toMs, ping, left } = await cmdConsole(helper);
    const hosts = await conptyHosts(fromMs, toMs);
    expect(held?.host?.pid).toBe(hosts[0]?.pid);
    const scan = await held!.scan({ attach: true });
    const attached = scan!.members.filter((m) => m.consoleHost === held!.host!.pid);
    expect(attached.map((m) => m.pid).sort()).toEqual([proc.pid, ping.pid].sort());
    expect(attached.every((m) => m.listed)).toBe(true);
    // The Start-Process child and the GUI programme left the console.
    for (const gone of left) expect(scan!.members.some((m) => m.pid === gone.pid)).toBe(false);
    held!.release();
  });

  it('never attaches to a console once a scan’s attach-by has passed', async () => {
    const helper = new ConptyHelper();
    helpers.push(helper);
    const { proc, held, ping } = await cmdConsole(helper);
    const pid = helper.pid;
    const own = [proc.pid, ping.pid].sort();
    // Taken up late, as by a helper short of CPU: the console may be closing.
    const late = await held!.scan({ attach: true, attachByMs: Date.now() - 10_000 });
    expect(late!.members.some((m) => m.listed)).toBe(false);
    // Each process's console host still names what is attached.
    const attached = late!.members.filter((m) => m.consoleHost === held!.host!.pid);
    expect(attached.map((m) => m.pid).sort()).toEqual(own);
    const timely = await held!.scan({ attach: true, attachByMs: Date.now() + 1000 });
    const listed = timely!.members.filter((m) => m.listed);
    expect(listed.map((m) => m.pid).sort()).toEqual(own);
    expect(helper.pid).toBe(pid);
    held!.release();
  });

  it('ends what stays attached once the root has gone, never a GUI programme, then the host', async () => {
    const helper = new ConptyHelper();
    helpers.push(helper);
    const { proc, held, fromMs, toMs, ping, left } = await cmdConsole(helper);
    const hosts = await conptyHosts(fromMs, toMs);
    process.kill(proc.pid);
    await waitUntil(async () => (await held!.alive())?.root === false, 10_000, 'the root’s exit');
    // Its console still holds ping: found through ping itself.
    const scan = await held!.scan({ attach: true });
    expect(scan!.members.map((m) => m.pid)).toEqual([ping.pid]);
    expect(await held!.terminate([...scan!.members.map((m) => m.key), 'host'])).toBe(2);
    expect(await survivors([ping, ...hosts])).toEqual([]);
    expect(await stillRunning(left)).toHaveLength(2);
    held!.release();
  });

  it('never reads the console of another process that a root it cannot place attached to', async () => {
    // A GUI root that attached to another console (its parent's, as
    // Electron does), its console host not told apart (another spawn began
    // within the margin): that console's list names the daemon and whatever
    // shares its console, none of it the PTY's.
    const helper = new ConptyHelper();
    helpers.push(helper);
    const dir = mkdtempSync(join(tmpdir(), 'puddle-helper-'));
    markers.push(dir);
    // The stand-in daemon: a node in a hidden console of its own.
    const standIn = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', `${dir}:stand-in`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve) => standIn.once('spawn', resolve));
    const flag = join(dir, 'attached.txt');
    const visitor = await consoleVisitorProgram();
    const fromMs = Date.now();
    const proc = pty.spawn(visitor, [String(standIn.pid), '120', flag, `${dir}:root`], {
      cols: 100,
      rows: 30,
      cwd: dir,
    });
    const toMs = Date.now();
    guardConsoleListKill(proc);
    consoles.push(proc);
    // Its console host, not told apart, stays until this process exits (as a daemon's would).
    strays.push(...(await conptyHosts(fromMs, toMs)));
    noteConptySpawn({ startedAtMs: fromMs + 1, spawnedAtMs: toMs + 1000 });
    const held = await helper.track(proc.pid, {
      fromMs: fromMs - 100,
      toMs: toMs + 100,
      startedAtMs: fromMs,
      spawnedAtMs: toMs,
    });
    expect(held?.rootCreatedAtMs).not.toBeNull();
    expect(held?.host).toBeNull();
    await waitUntil(() => existsSync(flag), 20_000, 'the root’s attach');
    expect(readFileSync(flag, 'utf8')).toBe('attached');
    const [standing] = await marked(`${dir}:stand-in`);
    const scan = await held!.scan({ attach: true });
    expect(scan?.rootAlive).toBe(true);
    expect(scan!.members.filter((m) => m.listed)).toEqual([]);
    expect(scan!.members.some((m) => m.pid === standIn.pid || m.pid === process.pid)).toBe(false);
    // Nor does a teardown end anything there.
    expect(await endConsole(proc.pid, held!, { root: true, host: true, attach: true })).toEqual({
      ended: 0,
      answered: true,
    });
    expect(await stillRunning([standing!])).toHaveLength(1);
    held!.release();
  });

  it('never ends a GUI programme it was asked to', async () => {
    const helper = new ConptyHelper();
    helpers.push(helper);
    const dir = mkdtempSync(join(tmpdir(), 'puddle-helper-'));
    markers.push(dir);
    const gui = spawn(await guiProgram(), ['60', `${dir}:gui`], { stdio: 'ignore' });
    const node = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', `${dir}:node`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let both: WindowsProcess[] = [];
    await waitUntil(async () => (both = await marked(dir)).length === 2, 20_000, 'both');
    const classified = await helper.classify(
      both.map((p) => ({ pid: p.pid, createdAtMs: p.createdAtMs! })),
    );
    const facts = classified!.processes;
    expect(facts.find((f) => f.pid === gui.pid)).toMatchObject({ gui: true });
    expect(facts.find((f) => f.pid === node.pid)).toMatchObject({ gui: false });
    expect(facts.find((f) => f.pid === node.pid)!.consoleHost).toBeGreaterThan(0);
    expect(await classified!.console.terminate(facts.map((f) => f.key))).toBe(1);
    expect(await stillRunning(both)).toEqual([both.find((p) => p.pid === gui.pid)]);
    classified!.console.release();
  });

  it('holds no root created outside the window it is given, nor a host that is not the one recorded', async () => {
    const helper = new ConptyHelper();
    helpers.push(helper);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    onTeardown(() => {
      if (child.exitCode === null) child.kill();
    });
    await new Promise((resolve) => child.once('spawn', resolve));
    const now = Date.now();
    const other = await helper.track(child.pid!, { fromMs: now + 60_000, toMs: now + 70_000 });
    expect(other).toMatchObject({ rootCreatedAtMs: null, host: null });
    other!.release();
    expect(
      await helper.adopt({ pid: child.pid!, createdAtMs: now, parentPid: process.pid }),
    ).toBeNull();
    child.kill();
  });

  it('adopts a recorded console host with its root only while the root is the process recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-helper-'));
    markers.push(dir);
    const fromMs = Date.now();
    const proc = pty.spawn('cmd.exe', ['/d', '/k', `rem ${dir}:root`], {
      cols: 100,
      rows: 30,
      cwd: dir,
    });
    const toMs = Date.now();
    guardConsoleListKill(proc);
    consoles.push(proc);
    const [host] = await conptyHosts(fromMs, toMs);
    const root = (await listWindowsProcesses({ fresh: true })).find((p) => p.pid === proc.pid)!;
    const recorded = { pid: host!.pid, createdAtMs: host!.createdAtMs!, parentPid: process.pid };
    // One helper each: a host one holds is never another's.
    const [first, second] = [new ConptyHelper(), new ConptyHelper()];
    helpers.push(first, second);
    // Created at another time: another process's pid.
    const later = await first.adopt({
      ...recorded,
      root: { pid: proc.pid, createdAtMs: root.createdAtMs! + 1000 },
    });
    expect(later?.host?.pid).toBe(host!.pid);
    expect(later?.rootCreatedAtMs).toBeNull();
    const held = await second.adopt({
      ...recorded,
      root: { pid: proc.pid, createdAtMs: root.createdAtMs! },
    });
    expect(Math.abs(held!.rootCreatedAtMs! - root.createdAtMs!)).toBeLessThanOrEqual(1);
    expect(await held!.alive()).toEqual({ root: true, host: true });
    // Held, it is ended as the root; then its host, which node-pty no longer closes.
    expect(await held!.terminate(['root'])).toBe(1);
    expect((await held!.alive())?.root).toBe(false);
    expect(await held!.terminate(['host'])).toBe(1);
    later!.release();
    held!.release();
  });

  /** The real helper, spoken to as the headless driver speaks to it (terminal-source.ts). */
  async function driverHelper() {
    const launch = conptyHelperLaunch();
    const proc = spawn(launch.file, [...launch.args], {
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    onTeardown(() => {
      if (proc.exitCode === null) proc.kill();
    });
    const waiting = new Map<string, (answer: string) => void>();
    let ready!: () => void;
    const up = new Promise<void>((resolve) => (ready = resolve));
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (line === 'ready') ready();
      const space = line.indexOf(' ');
      if (space > 0) waiting.get(line.slice(0, space))?.(line.slice(space + 1));
    });
    await up;
    let sequence = 0;
    return {
      ask: (request: string) =>
        new Promise<string>((resolve) => {
          const id = String(++sequence);
          waiting.set(id, resolve);
          proc.stdin.write(`${id} ${request}\n`);
        }),
      stop: () => proc.kill(),
    };
  }

  it('owns a CLI in a console of its own only as created by the parent named, in the window given', async () => {
    const helper = await driverHelper();
    const fromMs = Date.now();
    // As the driver starts its CLI: hidden, no stdio inherited, so in a console of its own.
    const cli = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const toMs = Date.now();
    onTeardown(() => {
      if (cli.exitCode === null) cli.kill();
    });
    await new Promise((resolve) => cli.once('spawn', resolve));
    let host: WindowsProcess | undefined;
    await waitUntil(
      async () =>
        (host = (await listWindowsProcesses({ fresh: true })).find(
          (p) => p.ppid === cli.pid && p.name.toLowerCase() === 'conhost.exe',
        )) !== undefined,
      10_000,
      'its console host',
    );
    const window = `${fromMs - 100} ${toMs + 100}`;
    const owned = (await helper.ask(`own a ${cli.pid} ${window} ${process.pid}`)).split(' ');
    expect(owned[0]).toBe('ok');
    expect(Number(owned[2])).toBe(host!.pid);
    expect(Math.abs(Number(owned[3]) - host!.createdAtMs!)).toBeLessThanOrEqual(1);
    // Not created in the window given, or not by the parent named: another process's pid.
    expect(
      await helper.ask(`own b ${cli.pid} ${toMs + 60_000} ${toMs + 70_000} ${process.pid}`),
    ).toBe('other 0 0 0');
    expect(await helper.ask(`own c ${cli.pid} ${window} ${process.ppid}`)).toBe('other 0 0 0');
    // What it holds is the CLI's: ended as the root, whatever its image.
    expect(await helper.ask('terminate a root')).toBe('ok 1');
    await waitUntil(() => cli.exitCode !== null || cli.signalCode !== null, 10_000, 'its exit');
    expect(await helper.ask('release a')).toBe('ok');
    helper.stop();
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listWindowsProcesses,
  requestDaemonShutdown,
  type WindowsProcess,
} from '@puddle/shared/node/platform';
import { ptyRootsFile, readPtyRoots } from '../../src/pty/pty-roots.js';
import { reapWindowsDaemon } from '../../src/supervision/reap-daemon.js';
import { onTeardown } from '../helpers/process-guard.js';
import {
  marked,
  orphansOf,
  role,
  stillRunning,
  stopMarked,
  survivors,
  waitUntil,
  withRoles,
  writeTreeAgent,
  type TreeAgent,
} from '../helpers/process-trees.js';

const entry = fileURLToPath(new URL('../helpers/tree-daemon.mjs', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../../dist/daemon.js', import.meta.url)));

/**
 * A real daemon process (the built code; `pnpm build` first) running an
 * agent whose tree has processes on its console and processes that left it,
 * some through intermediates that exited at once
 * (test/helpers/process-trees.ts). Its shutdown, and its termination, end
 * what is attached to the console and nothing that left it; so does the
 * resident supervisor's reap after a crash, which, for a console it was
 * never told the host of, ends instead the console programmes below the
 * root (docs/windows.md, decisions 6 and 8).
 */
describe.runIf(process.platform === 'win32' && built)('a Windows daemon’s PTY consoles', () => {
  const trees: TreeAgent[] = [];
  afterEach(async () => {
    for (const tree of trees.splice(0)) await stopMarked(tree.marker);
  });

  async function start(options: { helper?: false } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'puddle-tree-home-'));
    const tree = await writeTreeAgent({ orphans: true });
    trees.push(tree);
    const env: NodeJS.ProcessEnv = { ...process.env, PUDDLE_HOME: home };
    for (const key of Object.keys(env)) {
      if (/^CLAUDE(CODE|_CODE_)/i.test(key)) delete env[key];
    }
    const startedAtMs = Date.now();
    const args = [entry, ...tree.args, ...(options.helper === false ? ['--no-helper'] : [])];
    const child: ChildProcess = spawn(process.execPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    onTeardown(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const ready = await new Promise<{ pid: number }>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', (line) => resolve(JSON.parse(line)));
      void exited.then(() => reject(new Error(`the daemon exited: ${stderr}`)));
    });
    // The daemon's own command line names the marker too.
    let members: WindowsProcess[] = [];
    await waitUntil(
      async () =>
        (members = (await marked(tree.marker)).filter((p) => p.pid !== ready.pid)).length ===
        tree.size,
      30_000,
      'the agent’s tree',
    );
    // The orphans, and the GUI programme, whose `cmd /c start` has exited.
    expect(await orphansOf(members)).toHaveLength(4);
    return {
      home,
      child,
      exited,
      startedAtMs,
      pid: ready.pid,
      attached: withRoles(members, tree.attached),
      left: withRoles(members, tree.left),
    };
  }

  it('a requested shutdown ends what is attached to every PTY’s console before it exits', async () => {
    const d = await start();
    await waitUntil(
      () => readPtyRoots(ptyRootsFile(d.home), d.pid)?.[0]?.host !== undefined,
      10_000,
      'the console host recorded',
    );
    expect(await requestDaemonShutdown(d.home)).toBe('stopping');
    expect(await d.exited).toBe(0);
    expect(await survivors(d.attached)).toEqual([]);
    expect((await stillRunning(d.left)).map(role).sort()).toEqual(d.left.map(role).sort());
    expect(existsSync(ptyRootsFile(d.home))).toBe(false);
  });

  it('a terminated daemon’s consoles end what is attached; the supervisor ends nothing that left', async () => {
    const d = await start();
    await waitUntil(
      () => readPtyRoots(ptyRootsFile(d.home), d.pid)?.[0]?.host !== undefined,
      10_000,
      'the console host recorded',
    );
    d.child.kill(); // TerminateProcess, as a crash
    await d.exited;
    const exitedAtMs = Date.now();
    await reapWindowsDaemon({ pid: d.pid, startedAtMs: d.startedAtMs }, exitedAtMs, {
      processes: listWindowsProcesses,
      rootsFile: ptyRootsFile(d.home),
    });
    // Windows closed the consoles with the daemon, which ends what is attached.
    expect(await survivors(d.attached, 6000)).toEqual([]);
    expect((await stillRunning(d.left)).map(role).sort()).toEqual(d.left.map(role).sort());
    expect(existsSync(ptyRootsFile(d.home))).toBe(false);
  });

  it('for a console it was never told the host of, the supervisor ends nothing that left it', async () => {
    const d = await start({ helper: false });
    const recorded = readPtyRoots(ptyRootsFile(d.home), d.pid);
    expect(recorded).toHaveLength(1);
    expect(recorded![0]!.host).toBeUndefined();
    d.child.kill();
    await d.exited;
    const exitedAtMs = Date.now();
    expect(await survivors(d.attached, 6000)).toEqual([]);
    await reapWindowsDaemon({ pid: d.pid, startedAtMs: d.startedAtMs }, exitedAtMs, {
      processes: listWindowsProcesses,
      rootsFile: ptyRootsFile(d.home),
    });
    // Never the detached child, nor anything else that left the console (the
    // orphans are beyond what the process table leads to anyway).
    const after = (await stillRunning(d.left)).map(role).sort();
    expect(after).toEqual(['detached', 'gui', 'orphan-detached', 'orphan-start-process']);
    expect(existsSync(ptyRootsFile(d.home))).toBe(false);
  });
});

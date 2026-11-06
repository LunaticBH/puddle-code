import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import {
  disposeCompilationCommands,
  runCompilationCommand,
  terminateWindows,
  type CompilationStopOptions,
} from '../../src/compilation/process.js';
import { onTeardown } from '../helpers/process-guard.js';
import {
  marked,
  role,
  stillRunning,
  stopMarked,
  survivors,
  waitUntil,
} from '../helpers/process-trees.js';
import { consoleProgram, sparedTreeMembers, writeSparedTree } from '../helpers/spared-trees.js';

const host = fileURLToPath(new URL('../helpers/compile-host.mjs', import.meta.url));
const built = existsSync(
  fileURLToPath(new URL('../../dist/compilation/service.js', import.meta.url)),
);

/**
 * A compile command's stop on Windows (docs/windows.md, decision 8). The
 * command has a console of its own, which stands for its POSIX process
 * group: the command and what is attached to that console end, a process
 * its descendants left there as they exited (an orphan through `cmd /c
 * start /b`) included, and what left it outlives it, as `setsid` does: a
 * detached process and one in a console of its own (PowerShell's
 * Start-Process); never a GUI programme the command started, nor what that
 * started. Without the ConPTY helper, the tree the process table shows ends
 * instead, by creation-time-consistent links: a console process the command
 * started detached ends with it, and an orphan is not reached.
 */
describe.runIf(process.platform === 'win32')('a compile command’s stop on Windows', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  /** The spared tree as a compile command; resolves once all of it runs. */
  async function compileTree(options?: CompilationStopOptions) {
    const tree = await writeSparedTree();
    markers.push(tree.marker);
    const run = runCompilationCommand(
      { file: process.execPath, args: tree.args, cwd: tree.marker, timeoutMs: 120_000 },
      options,
    ).catch((error: unknown) => error);
    return { tree, run, members: await sparedTreeMembers(tree.marker) };
  }

  it('ends what is attached to the command’s console, never what left it or a GUI programme’s', async () => {
    const { tree, run, members } = await compileTree();
    const ending = members.filter((e) =>
      ['agent', 'attached', 'orphan-attached'].includes(role(e)),
    );
    const spared = members.filter((e) => !ending.includes(e));
    expect(spared.map(role).sort()).toEqual(
      ['detached', 'gui', 'gui-child', 'gui-child', 'start-process'].sort(),
    );
    // As when the daemon shuts down; what is to end has ended once it resolves.
    await disposeCompilationCommands();
    expect(await survivors(ending, 0)).toEqual([]);
    expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
    // A GUI programme may hold the command's output open: it settles once the survivors end.
    await stopMarked(tree.marker);
    expect(String(await run)).toMatch(/exited with/);
  });

  it('ends the command’s console tree without the helper, never a GUI programme or what one started', async () => {
    const { tree, run, members } = await compileTree({
      stopWindows: (child, processTree) =>
        terminateWindows(child, processTree, { inspector: null }),
    });
    const ending = members.filter((e) => ['agent', 'attached', 'detached'].includes(role(e)));
    const spared = members.filter((e) => ['gui', 'gui-child', 'start-process'].includes(role(e)));
    expect(spared.map(role).sort()).toEqual(['gui', 'gui-child', 'gui-child', 'start-process']);
    await disposeCompilationCommands();
    expect(await survivors(ending, 0)).toEqual([]);
    expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
    await stopMarked(tree.marker);
    expect(String(await run)).toMatch(/exited with/);
  });
});

const HOLDERS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class PuddleStartHolders
{
    // start-holders.exe <wait|exit> <marker> <programme> <arguments...>
    // starts the programme twice, naming "<marker>:own-console" in a hidden
    // console of its own, then "<marker>:detached" with no console, each
    // holding this process's output open, as cmd's start does; then it
    // waits, or exits.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public int X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public short Show, Reserved2;
        public IntPtr Reserved3, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public int Pid, Tid;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder line, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
        ref StartupInfo info, out ProcessInformation created);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static void Start(string line, uint flags)
    {
        var info = new StartupInfo();
        info.Size = Marshal.SizeOf(typeof(StartupInfo));
        info.Flags = 0x1 | 0x100; // STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES
        info.Show = 0; // SW_HIDE
        info.Input = GetStdHandle(-10);
        info.Output = GetStdHandle(-11);
        info.Error = GetStdHandle(-12);
        ProcessInformation created;
        if (!CreateProcessW(null, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, flags,
                IntPtr.Zero, null, ref info, out created))
            Environment.Exit(70);
        CloseHandle(created.Thread);
        CloseHandle(created.Process);
    }

    public static int Main(string[] args)
    {
        var line = new StringBuilder();
        for (int i = 2; i < args.Length; i++) line.Append('"').Append(args[i]).Append("\" ");
        Start(line + "\"" + args[1] + ":own-console\"", 0x10); // CREATE_NEW_CONSOLE
        Start(line + "\"" + args[1] + ":detached\"", 0x8); // DETACHED_PROCESS
        if (args[0] == "wait") Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
`;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The classic Windows build server: a process the command started in a
 * console of its own (`start`), or detached, that keeps the command's output
 * open, so that the command never closes. Once the command's console has
 * closed, whether its stop ended the command or the command had exited, no
 * later stop ends its tree, which would end those processes: the SIGKILL
 * that follows a timeout's stop, the daemon's dispose, and a timeout's stop
 * of a command that had exited all spare them, as POSIX `setsid` does.
 */
describe.runIf(process.platform === 'win32')(
  'a compile command’s stops once its console has closed',
  () => {
    const markers: string[] = [];
    afterEach(async () => {
      for (const marker of markers.splice(0)) await stopMarked(marker);
    });

    /**
     * A command that starts the two holders, then waits or exits, timed out
     * after `timeoutMs`; resolves once both holders run. Each stop records
     * whether the command had exited as it began.
     */
    async function holding(mode: 'wait' | 'exit', timeoutMs: number) {
      const marker = mkdtempSync(join(tmpdir(), 'puddle-holders-'));
      markers.push(marker);
      const keep = 'setInterval(()=>{},1e9)';
      const stops: boolean[] = [];
      let finished = 0;
      const run = runCompilationCommand(
        {
          file: await consoleProgram('start-holders', HOLDERS),
          args: [mode, marker, process.execPath, '-e', keep],
          cwd: marker,
          timeoutMs,
        },
        {
          stopWindows: async (child, tree) => {
            stops.push(child.exitCode !== null || child.signalCode !== null);
            await terminateWindows(child, tree);
            finished++;
          },
        },
      ).catch((error: unknown) => error);
      let holders: WindowsProcess[] = [];
      await waitUntil(
        async () =>
          (holders = (await marked(marker)).filter(
            (entry) =>
              entry.name.toLowerCase() === 'node.exe' &&
              ['own-console', 'detached'].includes(role(entry)),
          )).length === 2,
        30_000,
        'the holders',
      );
      /** Once every stop begun has finished, and none begins for a while (a SIGKILL a second on). */
      const settled = async () => {
        for (;;) {
          await waitUntil(() => finished === stops.length, 30_000, 'the stops');
          const begun = stops.length;
          await pause(1_500);
          if (stops.length === begun) return;
        }
      };
      return { run, stops, holders, settled };
    }

    it('spares them through the SIGKILL and the dispose that follow a stop that ended its console', async () => {
      const { run, stops, holders, settled } = await holding('wait', 5_000);
      const running = async () => (await stillRunning(holders)).map(role).sort();
      expect(String(await run)).toMatch(/exceeded 5000 ms/);
      await settled();
      expect(stops[0]).toBe(false);
      // The SIGKILL a second on, unless it joined the stop under way.
      expect(await running()).toEqual(['detached', 'own-console']);
      // The command never closes: the daemon's dispose stops it again, and
      // a second on, its SIGKILL.
      const begun = stops.length;
      await disposeCompilationCommands();
      await settled();
      expect(stops.length).toBeGreaterThan(begun);
      expect(stops.slice(1).every((exited) => exited)).toBe(true);
      expect(await running()).toEqual(['detached', 'own-console']);
    });

    it('spares them when it times out once it has exited', async () => {
      const { run, stops, holders, settled } = await holding('exit', 6_000);
      expect(String(await run)).toMatch(/exceeded 6000 ms/);
      await settled();
      expect(stops[0]).toBe(true);
      expect((await stillRunning(holders)).map(role).sort()).toEqual(['detached', 'own-console']);
    });
  },
);

/**
 * A daemon may exit as soon as its compilation service has been disposed
 * of. libuv's kill-on-close job then ends the command, but not what the
 * command started (cmd.exe holds its children in no job of its own), so
 * dispose resolves only once the command's tree has been stopped, which on
 * Windows first reads the process table. The built service, in a host
 * process (`pnpm build` first).
 */
describe.runIf(process.platform === 'win32' && built)('a compile command as its host exits', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  it('has ended the command’s grandchild once the service’s dispose resolves', async () => {
    const marker = mkdtempSync(join(tmpdir(), 'puddle-compile-host-'));
    markers.push(marker);
    // A build script whose cmd.exe waits for a console grandchild.
    const script = join(marker, 'build.cmd');
    const keep = 'setInterval(()=>{},1e9)';
    writeFileSync(script, `@"${process.execPath}" -e "${keep}" "${marker}:grandchild"\r\n`);
    const child = spawn(process.execPath, [host, script, marker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    onTeardown(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve, reject) => {
      createInterface({ input: child.stdout }).once('line', () => resolve());
      void exited.then(() => reject(new Error(`the host exited: ${stderr}`)));
    });
    let grandchild: WindowsProcess | undefined;
    await waitUntil(
      async () =>
        (grandchild = (await marked(marker)).find(
          (entry) => entry.name.toLowerCase() === 'node.exe' && role(entry) === 'grandchild',
        )) !== undefined,
      30_000,
      'the grandchild',
    );
    child.stdin.write('dispose\n');
    expect(await exited).toBe(0);
    expect(await survivors([grandchild!])).toEqual([]);
  });
});

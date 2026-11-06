import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessTreeRoot, WindowsProcess } from '@puddle/shared/node/platform';
import { KernelBridge, windowsKernelIdentity } from '../../src/notebooks/kernel-bridge.js';
import { role, stillRunning, stopMarked, survivors, waitUntil } from '../helpers/process-trees.js';
import { consoleProgram, sparedTreeMembers, writeSparedTree } from '../helpers/spared-trees.js';

/**
 * A notebook kernel's stop on Windows (docs/windows.md, decision 8). The
 * kernel runs on its bridge's console, a console of the bridge's own, which
 * stands for the kernel's POSIX process group: what is attached to it ends,
 * a process left there by a parent that exited included, and what left it
 * outlives it, as `setsid` does; never a GUI programme the kernel started,
 * nor what that started. Without the ConPTY helper the kernel, identified
 * by its creation time as a member of the bridge's tree created before the
 * bridge named it, and the tree the process table shows below it end: a
 * console process it started detached ends with it, unlike in a POSIX
 * process group. The identity runs on injected tables on any OS; the last
 * block ends real processes.
 */

const entry = (pid: number, ppid: number, createdAtMs: number | null): WindowsProcess => ({
  pid,
  ppid,
  name: 'python.exe',
  command: 'python',
  commandLine: `python.exe ${pid}`,
  createdAtMs,
});

/** The bridge the daemon started (10), between 995 and 1005. */
const bridge: ProcessTreeRoot = { pid: 10, startedAtMs: 995, createdBeforeMs: 1005 };
const B = entry(10, 1, 1000);
/** As a venv's python.exe runs it: the real bridge, the kernel's redirector and the kernel. */
const realBridge = entry(11, 10, 1010);
const kernel = entry(20, 11, 1500);
const realKernel = entry(21, 20, 1510);

describe('a notebook kernel’s identity on Windows', () => {
  it('is the creation time of the bridge’s child it named', () => {
    expect(windowsKernelIdentity([B, entry(20, 10, 1500)], bridge, 20, 1600)).toBe(1500);
  });

  it('is found below a redirector, whose child the kernel is', () => {
    expect(windowsKernelIdentity([B, realBridge, kernel, realKernel], bridge, 20, 1600)).toBe(1500);
  });

  it('is found once the bridge has exited, through the real bridge that still runs', () => {
    const exited = { ...bridge, exitedAtMs: 1700 };
    expect(windowsKernelIdentity([realBridge, kernel], exited, 20, 1600)).toBe(1500);
  });

  it('is none for a holder of the kernel’s pid created after the bridge named it', () => {
    // The kernel exited and a later child of the real bridge took pid 20.
    expect(windowsKernelIdentity([B, realBridge, entry(20, 11, 2000)], bridge, 20, 1600)).toBe(
      null,
    );
  });

  it('is none for a holder of the kernel’s pid outside the bridge’s tree', () => {
    expect(windowsKernelIdentity([B, realBridge, entry(20, 1, 1500)], bridge, 20, 1600)).toBe(null);
    // Its parent's pid is the real bridge's, but it is older than the real bridge.
    expect(windowsKernelIdentity([B, realBridge, entry(20, 11, 1005)], bridge, 20, 1600)).toBe(
      null,
    );
  });

  it('is none when the bridge’s pid is another process’s and nothing links the two', () => {
    // The bridge and the real bridge exited; pid 10 was taken at 1200.
    expect(windowsKernelIdentity([entry(10, 1, 1200), kernel], bridge, 20, 1600)).toBe(null);
  });

  it('is none for a kernel the table no longer lists, or without a creation time', () => {
    expect(windowsKernelIdentity([B, realBridge], bridge, 20, 1600)).toBe(null);
    expect(windowsKernelIdentity([B, realBridge, entry(20, 11, null)], bridge, 20, 1600)).toBe(
      null,
    );
    expect(windowsKernelIdentity([B, realBridge, kernel], bridge, 10, 1600)).toBe(null);
  });
});

const BRIDGE = String.raw`
using System;
using System.Diagnostics;
using System.Threading;
public static class PuddleFakeBridge
{
    // A stand-in for the notebook bridge: names no kernel specs, starts
    // %PUDDLE_FAKE_KERNEL% %PUDDLE_FAKE_KERNEL_ARGS% as its kernel, says so
    // as the bridge does, then reads its input to the end and waits.
    public static int Main(string[] args)
    {
        Console.Out.Write("{\"event\":\"catalogue\",\"kernels\":[]}\n");
        Console.Out.Flush();
        var start = new ProcessStartInfo(
            Environment.GetEnvironmentVariable("PUDDLE_FAKE_KERNEL"),
            Environment.GetEnvironmentVariable("PUDDLE_FAKE_KERNEL_ARGS"));
        start.UseShellExecute = false;
        var kernel = Process.Start(start);
        Console.Out.Write("{\"event\":\"spawned\",\"pid\":" + kernel.Id + "}\n");
        Console.Out.Flush();
        while (Console.In.ReadLine() != null) { }
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
`;

const REDIRECTOR = String.raw`
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class PuddleFakeRedirector
{
    // A stand-in for a venv's python.exe: runs %PUDDLE_FAKE_REAL_BRIDGE%
    // (naming %PUDDLE_FAKE_BRIDGE_MARKER% for the tests' clean-up) on its own
    // standard handles, in a job that ends it as this process ends and that
    // what it starts leaves, as CPython's redirector does, and waits for it.
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    public static int Main(string[] args)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits();
        limits.LimitFlags = 0x2000 | 0x1000; // KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK
        if (job == IntPtr.Zero ||
            !SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))))
            return 70;
        var start = new ProcessStartInfo(
            Environment.GetEnvironmentVariable("PUDDLE_FAKE_REAL_BRIDGE"),
            "\"" + Environment.GetEnvironmentVariable("PUDDLE_FAKE_BRIDGE_MARKER") + "\"");
        start.UseShellExecute = false;
        var real = Process.Start(start);
        if (!AssignProcessToJobObject(job, real.Handle))
        {
            real.Kill();
            return 71;
        }
        real.WaitForExit();
        return real.ExitCode;
    }
}
`;

/** How the daemon's Python runs the bridge: itself, or through a venv's redirector. */
const BRIDGES = [
  { how: 'a bridge that starts its kernel itself', redirected: false },
  { how: 'a venv’s bridge, through a redirector', redirected: true },
];

describe.runIf(process.platform === 'win32')('a notebook kernel’s stop on Windows', () => {
  const markers: string[] = [];
  const bridges: KernelBridge[] = [];
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) bridge.child.kill();
    for (const marker of markers.splice(0)) await stopMarked(marker);
    for (const name of [
      'PUDDLE_FAKE_KERNEL',
      'PUDDLE_FAKE_KERNEL_ARGS',
      'PUDDLE_FAKE_REAL_BRIDGE',
      'PUDDLE_FAKE_BRIDGE_MARKER',
    ]) {
      delete process.env[name];
    }
  });

  /**
   * A bridge whose kernel runs the spared tree; resolves once all of it
   * runs. `helper` false stands for a host without the ConPTY helper.
   */
  async function kernelTree(redirected: boolean, helper: boolean) {
    const tree = await writeSparedTree();
    markers.push(tree.marker);
    process.env.PUDDLE_FAKE_KERNEL = process.execPath;
    process.env.PUDDLE_FAKE_KERNEL_ARGS = tree.args.map((arg) => `"${arg}"`).join(' ');
    let python = await consoleProgram('fake-bridge', BRIDGE);
    if (redirected) {
      process.env.PUDDLE_FAKE_REAL_BRIDGE = python;
      process.env.PUDDLE_FAKE_BRIDGE_MARKER = tree.marker;
      python = await consoleProgram('fake-redirector', REDIRECTOR);
    }
    let kernel = 0;
    const bridge = new KernelBridge(
      python,
      (message) => {
        if (message.event === 'spawned' && message.pid) kernel = message.pid;
      },
      undefined,
      false,
      helper ? {} : { windows: { endConsole: async () => 'unavailable' } },
    );
    bridges.push(bridge);
    bridge.ready.catch(() => {});
    await bridge.ready;
    await waitUntil(() => kernel !== 0);
    const members = await sparedTreeMembers(tree.marker);
    // With the helper, what is on the bridge's console ends; without, the kernel's tree.
    const roles = helper
      ? ['agent', 'attached', 'orphan-attached']
      : ['agent', 'attached', 'detached'];
    const ending = members.filter((e) => roles.includes(role(e)));
    const sparing = [...(helper ? ['detached'] : []), 'gui', 'gui-child', 'start-process'];
    const spared = members.filter((e) => sparing.includes(role(e)));
    const agent = ending.find((e) => role(e) === 'agent');
    expect(agent?.pid).toBe(kernel);
    // Through a redirector the kernel is the real bridge's child, not the daemon's.
    if (redirected) expect(agent?.ppid).not.toBe(bridge.child.pid);
    else expect(agent?.ppid).toBe(bridge.child.pid);
    expect(spared.map(role).sort()).toEqual([...sparing, 'gui-child'].sort());
    return { bridge, ending, spared };
  }

  for (const { how, redirected } of BRIDGES) {
    for (const helper of [true, false]) {
      describe(`${how}, ${helper ? 'with' : 'without'} the ConPTY helper`, () => {
        it('ends the kernel when its bridge exits, never a GUI programme or what one started', async () => {
          const { bridge, ending, spared } = await kernelTree(redirected, helper);
          // The kernel outlives its bridge: nothing but the daemon ends it,
          // and close, as the daemon's stop calls it, resolves once it has.
          bridge.child.kill();
          await new Promise((resolve) => bridge.child.once('exit', resolve));
          await bridge.close();
          expect(await survivors(ending, 0)).toEqual([]);
          expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
        });

        it('ends the bridge when it does not shut down, never a GUI programme or what one started', async () => {
          const { bridge, ending, spared } = await kernelTree(redirected, helper);
          // The stand-in ignores the shutdown request: the bridge is ended
          // after 3 s, and close resolves once it has been, the kernel with it.
          await bridge.close();
          expect(bridge.child.exitCode !== null || bridge.child.signalCode !== null).toBe(true);
          expect(await survivors(ending, 0)).toEqual([]);
          expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
        });
      });
    }
  }
});

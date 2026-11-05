import { afterEach, describe, expect, it } from 'vitest';
import { KernelBridge } from '../../src/notebooks/kernel-bridge.js';
import { role, stillRunning, stopMarked, survivors, waitUntil } from '../helpers/process-trees.js';
import { consoleProgram, sparedTreeMembers, writeSparedTree } from '../helpers/spared-trees.js';

/**
 * A notebook kernel's stop on Windows (docs/windows.md, decision 8): the
 * kernel, identified as the bridge's child created before the bridge named
 * it, and the tree the process table shows below it end; never a GUI
 * programme the kernel started, nor what that started. A console process it
 * started detached ends with it, unlike in a POSIX process group.
 */

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

describe.runIf(process.platform === 'win32')('a notebook kernel’s stop on Windows', () => {
  const markers: string[] = [];
  const bridges: KernelBridge[] = [];
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) bridge.child.kill();
    for (const marker of markers.splice(0)) await stopMarked(marker);
    delete process.env.PUDDLE_FAKE_KERNEL;
    delete process.env.PUDDLE_FAKE_KERNEL_ARGS;
  });

  /** A bridge whose kernel runs the spared tree; resolves once all of it runs. */
  async function kernelTree() {
    const tree = await writeSparedTree();
    markers.push(tree.marker);
    process.env.PUDDLE_FAKE_KERNEL = process.execPath;
    process.env.PUDDLE_FAKE_KERNEL_ARGS = tree.args.map((arg) => `"${arg}"`).join(' ');
    let kernel = 0;
    const bridge = new KernelBridge(await consoleProgram('fake-bridge', BRIDGE), (message) => {
      if (message.event === 'spawned' && message.pid) kernel = message.pid;
    });
    bridges.push(bridge);
    bridge.ready.catch(() => {});
    await bridge.ready;
    await waitUntil(() => kernel !== 0);
    const members = await sparedTreeMembers(tree.marker);
    const ending = members.filter((e) => ['agent', 'attached', 'detached'].includes(role(e)));
    const spared = members.filter((e) => ['gui', 'gui-child', 'start-process'].includes(role(e)));
    expect(ending.find((e) => role(e) === 'agent')?.pid).toBe(kernel);
    expect(spared.map(role).sort()).toEqual(['gui', 'gui-child', 'gui-child', 'start-process']);
    return { bridge, ending, spared };
  }

  it('ends the kernel’s tree when its bridge exits, never a GUI programme or what one started', async () => {
    const { bridge, ending, spared } = await kernelTree();
    // The kernel outlives its bridge: nothing but the daemon ends it.
    bridge.child.kill();
    expect(await survivors(ending, 10_000)).toEqual([]);
    expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
  });

  it('ends the bridge’s tree when it does not shut down, never a GUI programme or what one started', async () => {
    const { bridge, ending, spared } = await kernelTree();
    // The stand-in ignores the shutdown request: the bridge is ended after 3 s.
    await bridge.close();
    expect(bridge.child.exitCode !== null || bridge.child.signalCode !== null).toBe(true);
    expect(await survivors(ending, 10_000)).toEqual([]);
    expect((await stillRunning(spared)).map(role).sort()).toEqual(spared.map(role).sort());
  });
});

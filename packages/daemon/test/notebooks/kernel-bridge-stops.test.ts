import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KernelBridge, type KernelBridgeWindows } from '../../src/notebooks/kernel-bridge.js';
import { waitUntil } from '../helpers/process-trees.js';
import { consoleProgram } from '../helpers/spared-trees.js';

/**
 * A notebook bridge's Windows stops (docs/windows.md, decision 8), with the
 * stops themselves stand-ins so that this runs on any OS. Each reads its
 * own process table, so they run one after another, never side by side:
 * one beside another could end a pid the other had already ended, by then
 * another process's. The bridge is a stand-in too, which names a kernel and
 * ignores the shutdown request.
 */

const IDLE_BRIDGE = String.raw`
using System;
using System.Threading;
public static class PuddleIdleBridge
{
    // Names no kernel specs and a kernel, as the bridge does, then waits.
    public static int Main(string[] args)
    {
        Console.Out.Write("{\"event\":\"catalogue\",\"kernels\":[]}\n{\"event\":\"spawned\",\"pid\":4242}\n");
        Console.Out.Flush();
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
`;

/** The stand-in bridge, as the `python` KernelBridge runs. */
async function idleBridge(): Promise<string> {
  if (process.platform === 'win32') return consoleProgram('idle-bridge', IDLE_BRIDGE);
  const file = join(mkdtempSync(join(tmpdir(), 'puddle-bridge-')), 'python');
  writeFileSync(
    file,
    '#!/bin/sh\n' +
      `printf '%s\\n' '{"event":"catalogue","kernels":[]}' '{"event":"spawned","pid":4242}'\n` +
      'exec sleep 600\n',
  );
  chmodSync(file, 0o755);
  return file;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a notebook bridge’s Windows stops', () => {
  const bridges: KernelBridge[] = [];
  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.child.kill('SIGKILL');
  });

  /** A bridge whose stops record when they run; resolves once it has named its kernel. */
  async function bridge(windows: (bridge: () => KernelBridge) => Partial<KernelBridgeWindows>) {
    let named = false;
    const created: KernelBridge = new KernelBridge(
      await idleBridge(),
      (message) => {
        if (message.event === 'spawned') named = true;
      },
      undefined,
      false,
      { platform: 'win32', windows: { identify: async () => 1234, ...windows(() => created) } },
    );
    bridges.push(created);
    await created.ready;
    await waitUntil(() => named, 10_000, 'the kernel named');
    return created;
  }

  it('begins the bridge’s tree stop only once the kernel’s has finished', async () => {
    const events: string[] = [];
    const created = await bridge((self) => ({
      endKernelTree: async (pid, createdAtMs) => {
        events.push(`kernel ${pid}@${createdAtMs}`);
        await pause(300);
        events.push('kernel ended');
      },
      endBridgeTree: async () => {
        events.push('bridge');
        self().child.kill('SIGKILL');
      },
    }));
    // The stand-in ignores the shutdown request: its stops begin after 3 s,
    // and close resolves once they have been carried out.
    await created.close();
    expect(events).toEqual(['kernel 4242@1234', 'kernel ended', 'bridge']);
  });

  it('holds close until the kernel’s stop that the bridge’s exit began has finished', async () => {
    const events: string[] = [];
    const created = await bridge(() => ({
      endKernelTree: async () => {
        events.push('kernel');
        await pause(300);
        events.push('kernel ended');
      },
      endBridgeTree: async () => {
        events.push('bridge');
      },
    }));
    const exited = new Promise((resolve) => created.child.once('exit', resolve));
    created.child.kill('SIGKILL');
    await exited;
    await created.close();
    expect(events).toEqual(['kernel', 'kernel ended']);
  });
});

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
  stopMarked,
  survivors,
  TREE_SIZE,
  waitUntil,
  writeTreeAgent,
  type TreeAgent,
} from '../helpers/process-trees.js';

const entry = fileURLToPath(new URL('../helpers/tree-daemon.mjs', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../../dist/daemon.js', import.meta.url)));

/**
 * A real daemon process (the built code; `pnpm build` first) running an
 * agent whose tree escapes the console (test/helpers/process-trees.ts):
 * its shutdown leaves nothing, and when it is terminated instead, what the
 * resident supervisor stops before a restart is all that was left
 * (docs/windows.md, decisions 6 and 8).
 */
describe.runIf(process.platform === 'win32' && built)('a Windows daemon’s PTY trees', () => {
  const trees: TreeAgent[] = [];
  afterEach(async () => {
    for (const tree of trees.splice(0)) await stopMarked(tree.marker);
  });

  async function start() {
    const home = mkdtempSync(join(tmpdir(), 'puddle-tree-home-'));
    const tree = writeTreeAgent();
    trees.push(tree);
    const env: NodeJS.ProcessEnv = { ...process.env, PUDDLE_HOME: home };
    for (const key of Object.keys(env)) {
      if (/^CLAUDE(CODE|_CODE_)/i.test(key)) delete env[key];
    }
    const startedAtMs = Date.now();
    const child: ChildProcess = spawn(process.execPath, [entry, tree.script, tree.marker], {
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
        TREE_SIZE,
      30_000,
      'the agent’s tree',
    );
    return { home, child, exited, startedAtMs, pid: ready.pid, members };
  }

  it('a requested shutdown stops every PTY’s tree before the daemon exits', async () => {
    const d = await start();
    expect(readPtyRoots(ptyRootsFile(d.home), d.pid)).toHaveLength(1);
    expect(await requestDaemonShutdown(d.home)).toBe('stopping');
    expect(await d.exited).toBe(0);
    expect(await survivors(d.members)).toEqual([]);
    expect(existsSync(ptyRootsFile(d.home))).toBe(false);
  });

  it('a terminated daemon leaves what its agent started, and the supervisor’s reaping stops it', async () => {
    const d = await start();
    d.child.kill(); // TerminateProcess, as a crash
    await d.exited;
    const exitedAtMs = Date.now();
    // The pseudoconsoles end their roots with the daemon, but not what escaped them.
    const left = await survivors(d.members, 2000);
    expect(left.some((p) => p.commandLine?.includes(':detached'))).toBe(true);
    const stopped = await reapWindowsDaemon(
      { pid: d.pid, startedAtMs: d.startedAtMs },
      exitedAtMs,
      {
        processes: listWindowsProcesses,
        rootsFile: ptyRootsFile(d.home),
      },
    );
    expect(stopped).toBeGreaterThanOrEqual(left.length);
    expect(await survivors(d.members)).toEqual([]);
    expect(existsSync(ptyRootsFile(d.home))).toBe(false);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listWindowsProcesses,
  system32Path,
  type WindowsProcess,
} from '@puddle/shared/node/platform';
import { LogStore } from '../../src/logs/log-store.js';
import { stripAnsi } from '../../src/pty/ansi.js';
import { PtyManager, type PtyExitEvent } from '../../src/pty/pty-manager.js';
import { ptyRootsFile, readPtyRoots } from '../../src/pty/pty-roots.js';
import { stopPtysAfterFile } from '../helpers/process-guard.js';
import {
  conptyHosts,
  marked,
  stopMarked,
  survivors,
  TREE_SIZE,
  waitUntil,
  writeTreeAgent,
  type TreeAgent,
} from '../helpers/process-trees.js';

/**
 * Windows has no hang-up (docs/windows.md, decision 8): whichever way a
 * ConPTY ends, nothing its root started, however it was started, and not
 * its console host either, may outlive the exit PtyManager reports.
 */
describe.skipIf(process.platform !== 'win32')('a ConPTY’s whole tree ends with it', () => {
  const trees: TreeAgent[] = [];
  afterEach(async () => {
    for (const tree of trees.splice(0)) await stopMarked(tree.marker);
  });

  function manager(rootsFile?: string) {
    const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 64 * 1024);
    const ptys = new PtyManager(logs, undefined, undefined, undefined, rootsFile);
    stopPtysAfterFile(ptys);
    let output = '';
    ptys.on('data', (e: { data: string }) => (output += e.data));
    return { ptys, output: () => stripAnsi(output) };
  }

  /** Runs the tree agent in a PTY; resolves once every process of the tree runs. */
  async function spawnTree(ptys: PtyManager, output: () => string) {
    const tree = writeTreeAgent();
    trees.push(tree);
    const before = Date.now();
    ptys.spawn('s', 'agent', process.execPath, [tree.script, tree.marker], { cwd: tree.marker });
    const after = Date.now();
    await waitUntil(() => output().includes('READY'), 20_000, 'READY');
    let members: WindowsProcess[] = [];
    await waitUntil(
      async () => (members = await marked(tree.marker)).length === TREE_SIZE,
      20_000,
      'the whole tree',
    );
    const hosts = await conptyHosts(before, after);
    expect(hosts).toHaveLength(1);
    return { tree, members: [...members, ...hosts] };
  }

  /** What was still running the moment the exit was reported. */
  function exitObserved(ptys: PtyManager, members: readonly WindowsProcess[]) {
    return new Promise<{ event: PtyExitEvent; live: number }>((resolve) =>
      ptys.once('exit', (event: PtyExitEvent) => resolve({ event, live: ptys.liveCount() })),
    ).then(async ({ event, live }) => ({ event, live, left: await survivors(members) }));
  }

  it('a kill stops every descendant and the console host before the exit is reported', async () => {
    const { ptys, output } = manager();
    const { members } = await spawnTree(ptys, output);
    const exit = exitObserved(ptys, members);
    ptys.kill('s', 'agent');
    const { left, live } = await exit;
    expect(left).toEqual([]);
    expect(live).toBe(0);
  });

  it('SIGKILL stops the same tree', async () => {
    const { ptys, output } = manager();
    const { members } = await spawnTree(ptys, output);
    const exit = exitObserved(ptys, members);
    ptys.kill('s', 'agent', 'SIGKILL');
    expect((await exit).left).toEqual([]);
  });

  it('an agent that exits on its own leaves nothing, its console host included', async () => {
    const { ptys, output } = manager();
    const { members } = await spawnTree(ptys, output);
    const exit = exitObserved(ptys, members);
    ptys.write('s', 'agent', '\x04');
    const { event, left } = await exit;
    expect(event.exitCode).toBe(0);
    expect(left).toEqual([]);
  });

  it('killAll leaves nothing of any PTY, and records the roots for the supervisor meanwhile', async () => {
    const rootsFile = ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-roots-home-')));
    const { ptys, output } = manager(rootsFile);
    expect(readPtyRoots(rootsFile, process.pid)).toEqual([]);
    const { members } = await spawnTree(ptys, output);
    expect(readPtyRoots(rootsFile, process.pid)).toEqual([
      expect.objectContaining({ pid: ptys.pidFor('s', 'agent') }),
    ]);
    const exit = exitObserved(ptys, members);
    ptys.killAll();
    expect((await exit).left).toEqual([]);
    expect(readPtyRoots(rootsFile, process.pid)).toEqual([]);
  });

  it('a PowerShell session stops its console children and Start-Process children', async () => {
    const { ptys, output } = manager();
    const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
    trees.push({ marker: dir, script: '' });
    const shell = system32Path(join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
    const before = Date.now();
    ptys.spawn('p', 'agent', shell, ['-NoLogo', '-NoProfile'], { cwd: dir });
    const after = Date.now();
    await waitUntil(() => /PS .*>/.test(output()), 30_000, 'a prompt');
    const root = ptys.pidFor('p', 'agent')!;
    // A hidden process in a console of its own, then ping in the foreground.
    // (Windows PowerShell's -ArgumentList joins arguments unquoted: no spaces.)
    ptys.write(
      'p',
      'agent',
      `Start-Process -WindowStyle Hidden '${process.execPath}' ` +
        `-ArgumentList '-e','setInterval(()=>{},1e9)','${dir}:start-process'; ping -t 127.0.0.1\r`,
    );
    let members: WindowsProcess[] = [];
    await waitUntil(
      async () => {
        const table = await listWindowsProcesses({ fresh: true });
        members = table.filter(
          (entry) =>
            entry.commandLine?.includes(`${dir}:start-process`) ||
            (entry.ppid === root && entry.name.toLowerCase() === 'ping.exe'),
        );
        return members.length === 2;
      },
      30_000,
      'ping and the Start-Process child',
    );
    const exit = exitObserved(ptys, [...members, ...(await conptyHosts(before, after))]);
    ptys.kill('p', 'agent');
    expect((await exit).left).toEqual([]);
  });

  it('a shell that exits on its own takes what it started with it', async () => {
    const { ptys, output } = manager();
    const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
    trees.push({ marker: dir, script: '' });
    const shell = system32Path(join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
    const before = Date.now();
    ptys.spawn('q', 'agent', shell, ['-NoLogo', '-NoProfile'], { cwd: dir });
    const after = Date.now();
    await waitUntil(() => /PS .*>/.test(output()), 30_000, 'a prompt');
    const hosts = await conptyHosts(before, after);
    ptys.write(
      'q',
      'agent',
      `Start-Process -WindowStyle Hidden '${process.execPath}' ` +
        `-ArgumentList '-e','setInterval(()=>{},1e9)','${dir}:start-process'\r`,
    );
    let members: WindowsProcess[] = [];
    await waitUntil(async () => (members = await marked(`${dir}:start-process`)).length === 1);
    const exit = exitObserved(ptys, [...members, ...hosts]);
    ptys.write('q', 'agent', 'exit\r');
    expect((await exit).left).toEqual([]);
  });
});

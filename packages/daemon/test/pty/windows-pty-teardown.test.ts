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
import { conptyTeardownDeps } from '../../src/pty/conpty-teardown.js';
import { PtyManager, type PtyExitEvent } from '../../src/pty/pty-manager.js';
import { ptyRootsFile, readPtyRoots } from '../../src/pty/pty-roots.js';
import { stopPtysAfterFile } from '../helpers/process-guard.js';
import {
  conptyHosts,
  marked,
  orphanServerCommands,
  orphanServers,
  orphansOf,
  stopMarked,
  survivors,
  waitUntil,
  writeTreeAgent,
  type TreeAgent,
} from '../helpers/process-trees.js';

/**
 * Windows has no hang-up (docs/windows.md, decision 8): whichever way a
 * ConPTY ends, nothing its root started, however it was started and
 * whichever of its parents have exited, and not its console host either,
 * may outlive the exit PtyManager reports.
 */
describe.skipIf(process.platform !== 'win32')('a ConPTY’s whole tree ends with it', () => {
  const trees: TreeAgent[] = [];
  afterEach(async () => {
    for (const tree of trees.splice(0)) await stopMarked(tree.marker);
  });

  /** `jobs: null` runs without the job host: the process table alone. */
  async function manager(options: { rootsFile?: string; jobs?: null } = {}) {
    const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 64 * 1024);
    const ptys = new PtyManager(logs, undefined, undefined, undefined, options);
    stopPtysAfterFile(ptys);
    // As the daemon does before it serves: every root goes in its job at once.
    await ptys.prepare();
    let output = '';
    ptys.on('data', (e: { data: string }) => (output += e.data));
    return { ptys, output: () => stripAnsi(output) };
  }

  /** Runs the tree agent in a PTY; resolves once every process of the tree runs. */
  async function spawnTree(
    ptys: PtyManager,
    output: () => string,
    options: { orphans?: boolean } = {},
  ) {
    const tree = writeTreeAgent(options);
    trees.push(tree);
    const before = Date.now();
    ptys.spawn('s', 'agent', process.execPath, tree.args, { cwd: tree.marker });
    const after = Date.now();
    await waitUntil(() => output().includes('READY'), 20_000, 'READY');
    let members: WindowsProcess[] = [];
    await waitUntil(
      async () => (members = await marked(tree.marker)).length === tree.size,
      20_000,
      'the whole tree',
    );
    const hosts = await conptyHosts(before, after);
    expect(hosts).toHaveLength(1);
    return { tree, members: [...members, ...hosts] };
  }

  /**
   * A PowerShell PTY that has started three servers through intermediates
   * that exited at once: `cmd /c start /b`, a short-lived PowerShell's
   * Start-Process, and a short-lived node that detaches a child. Nothing in
   * the process table leads from the shell to them.
   */
  async function shellWithOrphans(ptys: PtyManager, output: () => string) {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
    trees.push({ marker: dir, script: '', args: [], size: 3 });
    const shell = system32Path(join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
    const before = Date.now();
    ptys.spawn('p', 'agent', shell, ['-NoLogo', '-NoProfile'], { cwd: dir });
    const after = Date.now();
    await waitUntil(() => /PS .*>/.test(output()), 30_000, 'a prompt');
    for (const line of orphanServerCommands(dir)) ptys.write('p', 'agent', line);
    const servers = await orphanServers(dir);
    return { servers, hosts: await conptyHosts(before, after) };
  }

  /** What was still running the moment the exit was reported. */
  function exitObserved(ptys: PtyManager, members: readonly WindowsProcess[]) {
    const started = Date.now();
    return new Promise<{ event: PtyExitEvent; live: number; ms: number }>((resolve) =>
      ptys.once('exit', (event: PtyExitEvent) =>
        resolve({ event, live: ptys.liveCount(), ms: Date.now() - started }),
      ),
    ).then(async (seen) => ({ ...seen, left: await survivors(members) }));
  }

  for (const jobs of [undefined, null] as const) {
    const how = jobs === null ? 'by the process table alone' : 'with its job';
    it(`a kill stops every descendant and the console host before the exit is reported, ${how}`, async () => {
      const { ptys, output } = await manager({ jobs });
      const { members } = await spawnTree(ptys, output);
      const exit = exitObserved(ptys, members);
      ptys.kill('s', 'agent');
      const { left, live } = await exit;
      expect(left).toEqual([]);
      expect(live).toBe(0);
    });

    it(`an agent that exits on its own leaves nothing, its console host included, ${how}`, async () => {
      const { ptys, output } = await manager({ jobs });
      const { members } = await spawnTree(ptys, output);
      const exit = exitObserved(ptys, members);
      ptys.write('s', 'agent', '\x04');
      const { event, left } = await exit;
      expect(event.exitCode).toBe(0);
      expect(left).toEqual([]);
    });
  }

  it('SIGKILL stops the same tree, orphans included', async () => {
    const { ptys, output } = await manager();
    const { members } = await spawnTree(ptys, output, { orphans: true });
    expect(await orphansOf(members)).toHaveLength(2);
    const exit = exitObserved(ptys, members);
    ptys.kill('s', 'agent', 'SIGKILL');
    expect((await exit).left).toEqual([]);
  });

  it('an agent’s orphans, whose parents exited, end with its kill and with its own exit', async () => {
    for (const end of ['kill', 'exit'] as const) {
      const { ptys, output } = await manager();
      const { members } = await spawnTree(ptys, output, { orphans: true });
      expect(await orphansOf(members)).toHaveLength(2);
      const exit = exitObserved(ptys, members);
      if (end === 'kill') ptys.kill('s', 'agent');
      else ptys.write('s', 'agent', '\x04');
      expect((await exit).left).toEqual([]);
    }
  });

  it('killAll leaves nothing of any PTY, and records the roots for the supervisor meanwhile', async () => {
    const rootsFile = ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-roots-home-')));
    const { ptys, output } = await manager({ rootsFile });
    expect(readPtyRoots(rootsFile, process.pid)).toEqual([]);
    const { members } = await spawnTree(ptys, output, { orphans: true });
    expect(readPtyRoots(rootsFile, process.pid)).toEqual([
      expect.objectContaining({ pid: ptys.pidFor('s', 'agent') }),
    ]);
    const exit = exitObserved(ptys, members);
    ptys.killAll();
    expect((await exit).left).toEqual([]);
    expect(readPtyRoots(rootsFile, process.pid)).toEqual([]);
  });

  it('a PowerShell session stops its console children and Start-Process children', async () => {
    const { ptys, output } = await manager();
    const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
    trees.push({ marker: dir, script: '', args: [], size: 2 });
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

  for (const end of ['kill', 'SIGKILL', 'killAll', 'exit'] as const) {
    it(`a shell’s servers started through intermediates that exited end with its ${end}`, async () => {
      const { ptys, output } = await manager();
      const { servers, hosts } = await shellWithOrphans(ptys, output);
      const exit = exitObserved(ptys, [...servers, ...hosts]);
      if (end === 'kill') ptys.kill('p', 'agent');
      else if (end === 'SIGKILL') ptys.kill('p', 'agent', 'SIGKILL');
      else if (end === 'killAll') ptys.killAll();
      else ptys.write('p', 'agent', 'exit\r');
      expect((await exit).left).toEqual([]);
    });
  }

  it('a kill answers by its deadline under a slow process table, and leaves nothing once settled', async () => {
    const { ptys, output } = await manager();
    const { servers, hosts } = await shellWithOrphans(ptys, output);
    const table = conptyTeardownDeps.processes;
    // Every query takes 2.5 s, as on a loaded host or with WMI wedged.
    conptyTeardownDeps.processes = async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return table(options);
    };
    try {
      const exit = exitObserved(ptys, servers);
      ptys.kill('p', 'agent');
      const { ms, left } = await exit;
      // SessionService.kill escalates at 4 s and gives up at 6 s.
      expect(ms).toBeLessThan(5500);
      // The job ended them without the table.
      expect(left).toEqual([]);
      await ptys.settled(30_000);
      expect(await survivors(hosts)).toEqual([]);
    } finally {
      conptyTeardownDeps.processes = table;
    }
  });

  it('SIGKILL brings a slow stop’s deadline forward', async () => {
    const { ptys, output } = await manager();
    const { servers } = await shellWithOrphans(ptys, output);
    const table = conptyTeardownDeps.processes;
    conptyTeardownDeps.processes = async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return table(options);
    };
    try {
      const exit = exitObserved(ptys, servers);
      ptys.kill('p', 'agent');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      ptys.kill('p', 'agent', 'SIGKILL');
      const { ms, left } = await exit;
      expect(ms).toBeLessThan(3500);
      expect(left).toEqual([]);
      await ptys.settled(30_000);
    } finally {
      conptyTeardownDeps.processes = table;
    }
  });
});

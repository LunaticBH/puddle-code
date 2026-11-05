import { mkdtempSync, writeFileSync } from 'node:fs';
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
import { ConptyHelper, type ConptyJobs } from '../../src/pty/conpty-jobs.js';
import { PtyManager, type PtyExitEvent } from '../../src/pty/pty-manager.js';
import { ptyRootsFile, readPtyRoots } from '../../src/pty/pty-roots.js';
import { stopPtysAfterFile } from '../helpers/process-guard.js';
import { refusedHelper, silentHelper, slowHelper } from '../helpers/slow-conpty-helper.js';
import {
  ATTACHED_SERVER,
  attachedGuiProgram,
  conptyHosts,
  guiProgram,
  marked,
  orphanServerCommands,
  orphanServers,
  orphansOf,
  role,
  stillRunning,
  stopMarked,
  survivors,
  waitUntil,
  withRoles,
  writeTreeAgent,
} from '../helpers/process-trees.js';

/** `node writer.mjs <dir>`: see writer() below. */
const WRITER = String.raw`
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const line = '"' + process.execPath + '" -e "setInterval(() => process.stdout.write(String.fromCharCode(46)), 50)" "%M%:writer"';
// (cmd strips the outer quotes of a line that starts with one.)
spawn(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d /c "' + line + '"'], {
  stdio: 'inherit', windowsVerbatimArguments: true, env: { ...process.env, M: process.argv[2] },
});
process.stdout.write('READY\r\n');
process.stdin.on('data', () => process.exit(0));
`;

/**
 * Windows has no hang-up (docs/windows.md, decision 8): whichever way a
 * ConPTY ends, what is attached to its console ends with it, its console
 * host too, before PtyManager reports the exit; what left the console (a
 * GUI programme, a detached process, one in a console of its own) runs on,
 * as `nohup`, `setsid` and GUI launches outlive a POSIX hang-up. Each test
 * stops the survivors it makes.
 */
describe.skipIf(process.platform !== 'win32')(
  'a ConPTY’s end ends what is attached to its console',
  () => {
    const markers: string[] = [];
    const strays: WindowsProcess[] = [];
    afterEach(async () => {
      for (const marker of markers.splice(0)) await stopMarked(marker);
      for (const stray of strays.splice(0)) {
        try {
          process.kill(stray.pid);
        } catch {
          // Gone already.
        }
      }
    });

    /** `jobs`: the ConPTY helper; this process's shared one by default, null for none. */
    async function manager(options: { rootsFile?: string; jobs?: ConptyJobs | null } = {}) {
      const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 64 * 1024);
      const ptys = new PtyManager(logs, undefined, undefined, undefined, options);
      stopPtysAfterFile(ptys);
      // As the daemon does before it serves.
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
      const tree = await writeTreeAgent(options);
      markers.push(tree.marker);
      const before = Date.now();
      ptys.spawn('s', 'agent', process.execPath, tree.args, { cwd: tree.marker });
      const after = Date.now();
      await waitUntil(() => output().includes('READY'), 20_000, 'READY');
      let members: WindowsProcess[] = [];
      await waitUntil(
        async () => (members = await marked(tree.marker)).length === tree.size,
        30_000,
        'the whole tree',
      );
      const hosts = await conptyHosts(before, after);
      expect(hosts).toHaveLength(1);
      return {
        tree,
        attached: [...withRoles(members, tree.attached), ...hosts],
        left: withRoles(members, tree.left),
        members,
      };
    }

    /**
     * A PowerShell PTY that has started three servers through intermediates
     * that exited at once (one stays on the console), and a GUI programme.
     */
    async function shellWithOrphans(ptys: PtyManager, output: () => string) {
      const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
      markers.push(dir);
      const shell = system32Path(join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
      const before = Date.now();
      ptys.spawn('p', 'agent', shell, ['-NoLogo', '-NoProfile'], { cwd: dir });
      const after = Date.now();
      await waitUntil(() => /PS .*>/.test(output()), 30_000, 'a prompt');
      for (const line of orphanServerCommands(dir)) ptys.write('p', 'agent', line);
      const servers = await orphanServers(dir);
      ptys.write('p', 'agent', `& '${await guiProgram()}' 120 '${dir}:gui'\r`);
      let gui: WindowsProcess[] = [];
      await waitUntil(
        async () => (gui = (await marked(dir)).filter((p) => role(p) === 'gui')).length === 1,
        20_000,
        'the GUI programme',
      );
      const hosts = await conptyHosts(before, after);
      expect(hosts).toHaveLength(1);
      return {
        attached: [...servers.filter((p) => role(p) === ATTACHED_SERVER), ...hosts],
        left: [...servers.filter((p) => role(p) !== ATTACHED_SERVER), ...gui],
      };
    }

    /** What the exit found: what was attached and still runs, what left and still runs. */
    function exitObserved(
      ptys: PtyManager,
      attached: readonly WindowsProcess[],
      left: readonly WindowsProcess[],
    ) {
      const started = Date.now();
      return new Promise<{ event: PtyExitEvent; live: number; ms: number }>((resolve) =>
        ptys.once('exit', (event: PtyExitEvent) =>
          resolve({ event, live: ptys.liveCount(), ms: Date.now() - started }),
        ),
      ).then(async (seen) => ({
        ...seen,
        stayed: await survivors(attached),
        outlived: await stillRunning(left),
      }));
    }

    function end(ptys: PtyManager, stream: string, how: 'kill' | 'SIGKILL' | 'killAll' | 'exit') {
      if (how === 'kill') ptys.kill(stream, 'agent');
      else if (how === 'SIGKILL') ptys.kill(stream, 'agent', 'SIGKILL');
      else if (how === 'killAll') ptys.killAll();
      else ptys.write(stream, 'agent', stream === 's' ? '\x04' : 'exit\r');
    }

    for (const how of ['kill', 'SIGKILL', 'killAll', 'exit'] as const) {
      it(`its ${how} ends what is attached, orphans included, and nothing that left`, async () => {
        const { ptys, output } = await manager();
        const { attached, left } = await spawnTree(ptys, output, { orphans: true });
        expect(await orphansOf(attached)).not.toHaveLength(0);
        const exit = exitObserved(ptys, attached, left);
        end(ptys, 's', how);
        const { stayed, outlived, live, event } = await exit;
        expect(stayed).toEqual([]);
        expect(outlived.map(role).sort()).toEqual(left.map(role).sort());
        expect(live).toBe(0);
        if (how === 'exit') expect(event.exitCode).toBe(0);
      });

      it(`a shell’s ${how} ends its console’s server, never Start-Process’s, a detached one or a GUI programme`, async () => {
        const { ptys, output } = await manager();
        const { attached, left } = await shellWithOrphans(ptys, output);
        const exit = exitObserved(ptys, attached, left);
        end(ptys, 'p', how);
        const { stayed, outlived } = await exit;
        expect(stayed).toEqual([]);
        expect(outlived).toHaveLength(left.length);
      });
    }

    for (const how of ['kill', 'SIGKILL'] as const) {
      it(`without the helper, its ${how} still ends what is attached, through the console’s close`, async () => {
        const { ptys, output } = await manager({ jobs: null });
        const { attached, left } = await spawnTree(ptys, output, { orphans: true });
        const exit = exitObserved(ptys, attached, left);
        end(ptys, 's', how);
        const { stayed, outlived, ms } = await exit;
        expect(ms).toBeLessThan(how === 'kill' ? 5000 : 1500);
        expect(await survivors(stayed, 6000)).toEqual([]);
        expect(outlived).toHaveLength(left.length);
      });
    }

    it('without the helper, a root’s own exit is reported at once, leaving its console as it is', async () => {
      const { ptys, output } = await manager({ jobs: null });
      const { attached, left } = await spawnTree(ptys, output, { orphans: true });
      const exit = exitObserved(ptys, [], left);
      end(ptys, 's', 'exit');
      const { ms, outlived } = await exit;
      expect(ms).toBeLessThan(5000);
      expect(outlived).toHaveLength(left.length);
      // Nothing tells what is still attached apart: it ends with the daemon's consoles.
      strays.push(...attached);
    });

    /**
     * A cmd.exe PTY that has started a console child (attached) and a GUI
     * programme that attached to the console and started a console child
     * there, as Electron programmes do.
     */
    async function attachedGui(ptys: PtyManager, output: () => string) {
      const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
      markers.push(dir);
      const program = await attachedGuiProgram();
      ptys.spawn('g', 'agent', system32Path('cmd.exe'), ['/d', '/k'], { cwd: dir });
      await waitUntil(() => output().includes('>'), 20_000, 'a prompt');
      const keep = 'setInterval(()=>{},1e9)';
      ptys.write(
        'g',
        'agent',
        `start "" /b "${process.execPath}" -e "${keep}" "${dir}:attached"\r`,
      );
      ptys.write(
        'g',
        'agent',
        `start "" "${program}" 120 "${process.execPath}" -e "${keep}" "${dir}:gui-child"\r`,
      );
      let found: WindowsProcess[] = [];
      const named = (wanted: string) =>
        found.filter((p) =>
          wanted === 'gui'
            ? p.name.toLowerCase() === 'gui-attach.exe'
            : p.name.toLowerCase() === 'node.exe' && role(p) === wanted,
        );
      await waitUntil(
        async () => {
          found = await marked(dir);
          return ['attached', 'gui', 'gui-child'].every((wanted) => named(wanted).length === 1);
        },
        20_000,
        'the console child, the GUI programme and its child',
      );
      return { attached: named('attached'), left: [...named('gui'), ...named('gui-child')] };
    }

    for (const how of ['kill', 'kill, then SIGKILL', 'exit'] as const) {
      it(`its ${how} leaves a GUI programme that attached to its console, and what it started there`, async () => {
        const { ptys, output } = await manager();
        const { attached, left } = await attachedGui(ptys, output);
        const exit = exitObserved(ptys, attached, left);
        if (how === 'exit') ptys.write('g', 'agent', 'exit\r');
        else ptys.kill('g', 'agent');
        if (how === 'kill, then SIGKILL') {
          await new Promise((resolve) => setTimeout(resolve, 200));
          ptys.kill('g', 'agent', 'SIGKILL');
        }
        const { stayed, outlived, ms } = await exit;
        expect(stayed).toEqual([]);
        expect(outlived).toHaveLength(2);
        expect(ms).toBeLessThan(4500);
      });
    }

    it('a PowerShell session ends ping in its console, never a Start-Process child', async () => {
      const { ptys, output } = await manager();
      const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
      markers.push(dir);
      const shell = system32Path(join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
      ptys.spawn('p', 'agent', shell, ['-NoLogo', '-NoProfile'], { cwd: dir });
      await waitUntil(() => /PS .*>/.test(output()), 30_000, 'a prompt');
      const root = ptys.pidFor('p', 'agent')!;
      // (Windows PowerShell's -ArgumentList joins arguments unquoted: no spaces.)
      ptys.write(
        'p',
        'agent',
        `Start-Process -WindowStyle Hidden '${process.execPath}' ` +
          `-ArgumentList '-e','setInterval(()=>{},1e9)','${dir}:start-process'; ping -t 127.0.0.1\r`,
      );
      let ping: WindowsProcess[] = [];
      let started: WindowsProcess[] = [];
      await waitUntil(
        async () => {
          const table = await listWindowsProcesses({ fresh: true });
          started = table.filter((p) => p.commandLine?.includes(`${dir}:start-process`));
          ping = table.filter((p) => p.ppid === root && p.name.toLowerCase() === 'ping.exe');
          return started.length === 1 && ping.length === 1;
        },
        30_000,
        'ping and the Start-Process child',
      );
      const exit = exitObserved(ptys, ping, started);
      ptys.kill('p', 'agent');
      const { stayed, outlived } = await exit;
      expect(stayed).toEqual([]);
      expect(outlived).toHaveLength(1);
    });

    it('ends the console hosts of roots that exited before a starting helper could hold them', async () => {
      // The table warm, so as to see the hosts before the helper can end them.
      await listWindowsProcesses({ fresh: true });
      // A helper just started, as after one was lost: it answers in ~0.5 s.
      const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 64 * 1024);
      const ptys = new PtyManager(logs, undefined, undefined, undefined, {
        jobs: new ConptyHelper(),
      });
      stopPtysAfterFile(ptys);
      const exits: PtyExitEvent[] = [];
      ptys.on('exit', (e: PtyExitEvent) => exits.push(e));
      const before = Date.now();
      for (const stream of ['q1', 'q2', 'q3']) {
        ptys.spawn(stream, 'agent', process.execPath, ['-e', "process.stdout.write('x')"], {
          cwd: tmpdir(),
        });
      }
      const after = Date.now();
      const hosts = await conptyHosts(before, after);
      expect(hosts).toHaveLength(3);
      await waitUntil(() => exits.length === 3, 15_000, 'three exits');
      await ptys.settled(15_000);
      // Each was told apart by its creation nearest its own spawn.
      expect(await survivors(hosts)).toEqual([]);
    });

    it('tells apart the console hosts of two PTYs spawned together, and ends each with its PTY', async () => {
      const rootsFile = ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-roots-home-')));
      const { ptys, output } = await manager({ rootsFile });
      const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
      markers.push(dir);
      const cmd = system32Path('cmd.exe');
      const before = Date.now();
      ptys.spawn('a', 'agent', cmd, ['/d', '/k'], { cwd: dir });
      ptys.spawn('b', 'agent', cmd, ['/d', '/k'], { cwd: dir });
      const after = Date.now();
      await waitUntil(() => (output().match(/>/g) ?? []).length >= 2, 20_000, 'two prompts');
      const hosts = await conptyHosts(before, after);
      expect(hosts).toHaveLength(2);
      let roots = readPtyRoots(rootsFile, process.pid)!;
      await waitUntil(
        () => (roots = readPtyRoots(rootsFile, process.pid)!).every((r) => r.host),
        10_000,
        'both hosts recorded',
      );
      expect(roots.map((r) => r.host!.pid).sort()).toEqual(hosts.map((h) => h.pid).sort());
      const first = hosts.find(
        (h) => h.pid === roots.find((r) => r.pid === ptys.pidFor('a', 'agent'))!.host!.pid,
      )!;
      const exit = exitObserved(
        ptys,
        [first],
        hosts.filter((h) => h !== first),
      );
      ptys.write('a', 'agent', 'exit\r');
      const { stayed, outlived } = await exit;
      expect(stayed).toEqual([]);
      expect(outlived).toHaveLength(1);
      const second = exitObserved(ptys, outlived, []);
      ptys.write('b', 'agent', 'exit\r');
      expect((await second).stayed).toEqual([]);
    });

    it('records when a root exited, before its PTY reports it, then forgets it', async () => {
      const rootsFile = ptyRootsFile(mkdtempSync(join(tmpdir(), 'puddle-roots-home-')));
      const { ptys, output } = await manager({ rootsFile });
      const { attached, left } = await spawnTree(ptys, output);
      expect(readPtyRoots(rootsFile, process.pid)).toEqual([
        expect.objectContaining({ pid: ptys.pidFor('s', 'agent') }),
      ]);
      let reportedAt = 0;
      ptys.once('exit', () => (reportedAt = Date.now()));
      const exit = exitObserved(ptys, attached, left);
      end(ptys, 's', 'exit');
      let seenAt = 0;
      let exitedAtMs: number | undefined;
      while (reportedAt === 0) {
        exitedAtMs ??= readPtyRoots(rootsFile, process.pid)?.[0]?.exitedAtMs;
        if (exitedAtMs !== undefined && seenAt === 0) seenAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Recorded as the root exited, not when the exit was reported: the
      // supervisor's bound on what the root's pid started is that exit.
      expect(exitedAtMs).toBeDefined();
      expect(seenAt - exitedAtMs!).toBeLessThan(250);
      expect(exitedAtMs!).toBeLessThanOrEqual(reportedAt);
      expect((await exit).stayed).toEqual([]);
      expect(readPtyRoots(rootsFile, process.pid)).toEqual([]);
    });

    /**
     * An agent that has a process in its console write to it every 50 ms, and
     * keep on once the agent has exited: node-pty never drains. (Through
     * `cmd /c`: Node ends the children it starts itself with it.)
     */
    function writer(dir: string): string[] {
      const script = join(dir, 'writer.mjs');
      writeFileSync(script, WRITER);
      return [script, dir];
    }

    for (const jobs of [undefined, null] as const) {
      const how = jobs === null ? 'without the helper' : 'with the helper';
      it(`reports a root’s exit in bounded time though its console keeps writing, ${how}`, async () => {
        const { ptys, output } = await manager({ jobs });
        const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
        markers.push(dir);
        const before = Date.now();
        ptys.spawn('w', 'agent', process.execPath, writer(dir), { cwd: dir });
        const after = Date.now();
        await waitUntil(() => output().includes('READY'), 20_000, 'READY');
        // Without the helper its console host stays, with the writer, until the daemon goes.
        if (jobs === null) strays.push(...(await conptyHosts(before, after)));
        let writers: WindowsProcess[] = [];
        await waitUntil(
          async () =>
            (writers = (await marked(dir)).filter((p) => role(p) === 'writer')).length === 1,
          20_000,
          'the writer',
        );
        const exit = exitObserved(ptys, jobs === null ? [] : writers, []);
        // (A line: the console is not in raw mode.)
        ptys.write('w', 'agent', 'x\r');
        const { ms, stayed } = await exit;
        expect(ms).toBeLessThan(jobs === null ? 6500 : 3000);
        expect(stayed).toEqual([]);
        if (jobs === null) strays.push(...writers);
      });
    }

    for (const [name, jobs] of [
      ['answers 2.5 s late', () => slowHelper(2500)],
      ['cannot start', refusedHelper],
      ['never answers', silentHelper],
    ] as const) {
      it(`a kill answers by its deadline when the helper ${name}, and SIGKILL brings it forward`, async () => {
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
          const { ptys, output } = await manager({ jobs: jobs() });
          const { attached, left } = await spawnTree(ptys, output, { orphans: true });
          const exit = exitObserved(ptys, [], left);
          ptys.kill('s', 'agent');
          if (signal === 'SIGKILL') {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            ptys.kill('s', 'agent', 'SIGKILL');
          }
          const { ms, outlived } = await exit;
          // SessionService.kill escalates at 4 s and gives up at 6 s.
          expect(ms).toBeLessThan(signal === 'SIGKILL' ? 3500 : 5500);
          await ptys.settled(30_000);
          // The console's close ended what was attached; nothing that left was touched.
          expect(await survivors(attached, 6000)).toEqual([]);
          expect(outlived).toHaveLength(left.length);
          await stopMarked(markers.at(-1)!);
        }
      });
    }
  },
);

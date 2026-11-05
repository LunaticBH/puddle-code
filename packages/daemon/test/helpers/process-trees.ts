import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  isPidAlive,
  listWindowsProcesses,
  type WindowsProcess,
} from '@puddle/shared/node/platform';

/**
 * Windows process-tree fixtures for the teardown tests (docs/windows.md,
 * decision 8): an agent whose descendants include every way a process can
 * stay on its console or leave it. A PTY's end must end those attached to
 * its console and leave the others running, as a hang-up does on POSIX.
 * Every process it starts names its directory on its command line, so the
 * tests find them in the process table; each test stops the survivors it
 * makes.
 */

/**
 * `node agent.mjs <marker> <gui.exe> [orphans]`: starts processes attached
 * to its console (a child that inherits it, and a grandchild through a
 * `cmd /c` that inherits it too) and processes that left it (a detached
 * child, and a GUI programme through `cmd /c start`); with `orphans`, also
 * three through intermediates that exit at once: one that stays on the
 * console (`cmd /c start /b`), a detached one (through a short-lived node)
 * and one in a console of its own (PowerShell's Start-Process). Then it
 * prints READY and waits; Ctrl-D ends it.
 *
 * Node puts each child it starts without `detached` in a kill-on-close job
 * of its own (libuv's), which ends the child with it, but not the child's
 * children: whatever is to outlive its Node parent here is detached, or
 * started through `cmd` or PowerShell. Only the processes of the tree name
 * the marker on their command lines: the intermediates take it from their
 * environment (`%M%`, `$env:PUDDLE_TREE_MARKER`).
 */
const AGENT = `
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const [marker, gui, orphans] = process.argv.slice(2);
const node = process.execPath;
const keep = 'setInterval(()=>{},1e9)';
const env = { ...process.env, M: marker, PUDDLE_TREE_MARKER: marker };
// cmd.exe /d /c <line>, verbatim; without windowsHide it, and what it starts
// in its console, stays on this one.
const cmd = (line, options = {}) =>
  spawn(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d /c ' + line], {
    stdio: 'ignore', windowsVerbatimArguments: true, env, ...options,
  });
spawn(node, ['-e', keep, marker + ':inherit'], { stdio: 'ignore' });
// (cmd strips the outer quotes of a line that starts with one.)
cmd('""' + node + '" -e "' + keep + '" "%M%:grandchild""');
spawn(node, ['-e', keep, marker + ':detached'], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
cmd('start "" "' + gui + '" 120 "%M%:gui"', { windowsHide: true });
if (orphans === 'orphans') {
  cmd('start "" /b "' + node + '" -e "' + keep + '" "%M%:orphan-attached"');
  const detach = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', process.env.PUDDLE_TREE_MARKER + ':orphan-detached'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()";
  spawn(node, ['-e', detach], { stdio: 'ignore', windowsHide: true, env });
  const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Windows PowerShell's -ArgumentList joins its arguments unquoted: no spaces.
  const start = "Start-Process -WindowStyle Hidden '" + node + "' -ArgumentList '-e','" + keep + "',($env:PUDDLE_TREE_MARKER + ':orphan-start-process')";
  spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', start], { stdio: 'ignore', windowsHide: true, env });
}
process.stdout.write('LAUNCH skip=false\\r\\nREADY\\r\\n');
process.stdin.setRawMode?.(true);
process.stdin.on('data', (data) => { if (data.toString('utf8').includes('\\x04')) process.exit(0); });
`;

/** What ends with the agent's console: the agent itself and what is attached to its console. */
export const ATTACHED = ['agent', 'inherit', 'grandchild'] as const;
/** What left it, and outlives it. */
export const LEFT = ['detached', 'gui'] as const;
/** What `orphans` adds, through intermediates that exited. */
export const ORPHANS_ATTACHED = ['orphan-attached'] as const;
export const ORPHANS_LEFT = ['orphan-detached', 'orphan-start-process'] as const;

export interface TreeAgent {
  /** The directory every process of the tree names. */
  marker: string;
  script: string;
  /** Its arguments: the script, the marker and the GUI programme, then `orphans` when asked for. */
  args: string[];
  /** How many processes of the tree run once it is ready. */
  size: number;
  /** The roles (role()) that end with the agent's console, and those that outlive it. */
  attached: string[];
  left: string[];
}

export async function writeTreeAgent(options: { orphans?: boolean } = {}): Promise<TreeAgent> {
  const marker = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
  const script = join(marker, 'agent.mjs');
  writeFileSync(script, AGENT);
  const args = [script, marker, await guiProgram(), ...(options.orphans ? ['orphans'] : [])];
  const attached = [...ATTACHED, ...(options.orphans ? ORPHANS_ATTACHED : [])];
  const left = [...LEFT, ...(options.orphans ? ORPHANS_LEFT : [])];
  return { marker, script, args, size: attached.length + left.length, attached, left };
}

/** A tree member's role: the agent, or the suffix its command line ends with. */
export function role(entry: WindowsProcess): string {
  const line = entry.commandLine ?? '';
  if (/agent\.mjs/i.test(line)) return 'agent';
  return line.split(':').pop()!.replace(/"/g, '').trim();
}

/** The members of `tree` whose role is one of `roles`. */
export function withRoles(members: readonly WindowsProcess[], roles: readonly string[]) {
  return members.filter((entry) => roles.includes(role(entry)));
}

const GUI_SOURCE = `
using System.Threading;
public static class PuddleTestGui
{
    // A GUI-subsystem programme that does nothing for <seconds>, then exits.
    public static int Main(string[] args)
    {
        Thread.Sleep(int.Parse(args.Length > 0 ? args[0] : "60") * 1000);
        return 0;
    }
}
`;

let gui: Promise<string> | null = null;

/**
 * A GUI-subsystem programme (`/target:winexe`), compiled once per process
 * with the .NET Framework 4 C# compiler every supported Windows ships, as
 * the release's puddle-hidden.exe is: `gui.exe <seconds> [anything]` waits,
 * then exits, its arguments naming whatever the test needs found.
 */
export function guiProgram(): Promise<string> {
  return (gui ??= (async () => {
    const windir = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const compiler = ['Framework64', 'FrameworkArm64', 'Framework']
      .map((framework) => join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
      .find((candidate) => existsSync(candidate));
    if (compiler === undefined) throw new Error('no .NET Framework C# compiler');
    const dir = mkdtempSync(join(tmpdir(), 'puddle-gui-'));
    const source = join(dir, 'gui.cs');
    const exe = join(dir, 'gui.exe');
    writeFileSync(source, GUI_SOURCE);
    await promisify(execFile)(
      compiler,
      ['/nologo', '/target:winexe', '/platform:anycpu', `/out:${exe}`, source],
      { windowsHide: true },
    );
    return exe;
  })());
}

/**
 * What to type into a PowerShell PTY to start three servers through
 * intermediates that exit at once: `cmd /c start /b` (which stays on the
 * console), a short-lived PowerShell's Start-Process (a console of its own)
 * and a short-lived node that detaches a child. Only the servers' command
 * lines name `dir` (it travels in `$env:M`).
 */
export function orphanServerCommands(dir: string): string[] {
  const node = process.execPath;
  // (Windows PowerShell's -ArgumentList joins arguments unquoted: no spaces.)
  return [
    `$env:M = '${dir}'; ` +
      `cmd --% /d /c start "" /b "${node}" -e "setInterval(()=>{},1e9)" "%M%:start"\r`,
    `powershell -NoLogo -NoProfile -Command 'Start-Process -WindowStyle Hidden ''${node}'' ` +
      `-ArgumentList ''-e'',''setInterval(()=>{},1e9)'',($env:M + '':start-process'')'\r`,
    `& '${node}' -e "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', ` +
      `process.env.M + ':detached'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()"\r`,
  ];
}

/** Of orphanServerCommands' servers, the one that stays on the console. */
export const ATTACHED_SERVER = 'start';

/** The three servers orphanServerCommands starts, once they all run, each an orphan. */
export async function orphanServers(dir: string): Promise<WindowsProcess[]> {
  let servers: WindowsProcess[] = [];
  await waitUntil(
    async () =>
      // Not cmd.exe, which names the directory too until it exits.
      (servers = (await marked(dir)).filter((p) => p.name.toLowerCase() === 'node.exe')).length ===
      3,
    30_000,
    'the three servers',
  );
  if ((await orphansOf(servers)).length !== 3) throw new Error('a server’s parent still runs');
  return servers;
}

/**
 * Of `members`, the orphans: running processes whose parent has exited, so
 * that nothing in the process table leads to them from the root.
 */
export async function orphansOf(members: readonly WindowsProcess[]): Promise<WindowsProcess[]> {
  const table = await listWindowsProcesses({ fresh: true });
  return members.filter((member) => {
    const parent = table.find((entry) => entry.pid === member.ppid);
    return (
      parent === undefined ||
      parent.createdAtMs === null ||
      member.createdAtMs === null ||
      parent.createdAtMs > member.createdAtMs
    );
  });
}

/** Running processes whose command line names `marker`, from a fresh table. */
export async function marked(marker: string): Promise<WindowsProcess[]> {
  const needle = marker.toLowerCase();
  return (await listWindowsProcesses({ fresh: true })).filter((entry) =>
    entry.commandLine?.toLowerCase().includes(needle),
  );
}

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  ms = 20_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Which of `processes` are still the same running processes: TerminateProcess
 * completes asynchronously, so a process stopped just now gets `graceMs`.
 */
export async function survivors(
  processes: readonly WindowsProcess[],
  graceMs = 1000,
): Promise<WindowsProcess[]> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const alive = processes.filter((entry) => isPidAlive(entry.pid));
    if (alive.length === 0 || Date.now() > deadline) {
      if (alive.length === 0) return [];
      // Confirm by identity: a pid may have been reused meanwhile.
      const table = await listWindowsProcesses({ fresh: true });
      return alive.filter((entry) =>
        table.some((row) => row.pid === entry.pid && row.createdAtMs === entry.createdAtMs),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Which of `processes` still run as the same processes, now (no grace). */
export async function stillRunning(
  processes: readonly WindowsProcess[],
): Promise<WindowsProcess[]> {
  const table = await listWindowsProcesses({ fresh: true });
  return processes.filter((entry) =>
    table.some((row) => row.pid === entry.pid && row.createdAtMs === entry.createdAtMs),
  );
}

/** The headless ConPTY hosts this process created between `from` and `to`. */
export async function conptyHosts(from: number, to: number): Promise<WindowsProcess[]> {
  return (await listWindowsProcesses({ fresh: true })).filter(
    (entry) =>
      entry.ppid === process.pid &&
      entry.name.toLowerCase() === 'conhost.exe' &&
      /--headless/i.test(entry.commandLine ?? '') &&
      entry.createdAtMs !== null &&
      entry.createdAtMs >= from - 25 &&
      entry.createdAtMs <= to + 25,
  );
}

/** Stops whatever a test left of a tree, its deliberate survivors included (best effort). */
export async function stopMarked(marker: string): Promise<void> {
  for (const entry of await marked(marker).catch(() => [])) {
    try {
      process.kill(entry.pid);
    } catch {
      // Gone already.
    }
  }
}

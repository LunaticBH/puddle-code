import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPidAlive,
  listWindowsProcesses,
  type WindowsProcess,
} from '@puddle/shared/node/platform';

/**
 * Windows process-tree fixtures for the teardown tests: an agent whose
 * descendants escape every mechanism but Puddle's own (docs/windows.md,
 * decision 8). Every process it starts names its directory on its command
 * line, so the tests find them in the process table.
 */

/**
 * `node agent.mjs <marker> [orphans]`: starts a console-inheriting child, a
 * hidden one (a console of its own), a detached one, and a hidden one that
 * starts its own child; with `orphans`, also two through intermediates that
 * exit at once, as `cmd /c start` or a tool's short-lived shell leaves them:
 * a detaching node, and PowerShell's Start-Process. The intermediates' command
 * lines do not name the marker (it travels in their environment). Then it
 * prints READY and waits; Ctrl-D ends it.
 */
const AGENT = `
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const marker = process.argv[2];
const keep = 'setInterval(() => {}, 1e9)';
spawn(process.execPath, ['-e', keep, marker + ':inherit'], { stdio: 'ignore' });
spawn(process.execPath, ['-e', keep, marker + ':hidden'], { stdio: 'ignore', windowsHide: true });
spawn(process.execPath, ['-e', keep, marker + ':detached'], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
const deep = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', process.argv[1] + ':deep'], { stdio: 'ignore' }); setInterval(() => {}, 1e9)";
spawn(process.execPath, ['-e', deep, marker + ':mid'], { stdio: 'ignore', windowsHide: true });
if (process.argv[3] === 'orphans') {
  const env = { ...process.env, PUDDLE_TREE_MARKER: marker };
  const detach = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', process.env.PUDDLE_TREE_MARKER + ':orphan-detached'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()";
  spawn(process.execPath, ['-e', detach], { stdio: 'ignore', windowsHide: true, env });
  const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Windows PowerShell's -ArgumentList joins its arguments unquoted: no spaces.
  const start = "Start-Process -WindowStyle Hidden '" + process.execPath + "' -ArgumentList '-e','setInterval(()=>{},1e9)',($env:PUDDLE_TREE_MARKER + ':orphan-start-process')";
  spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', start], { stdio: 'ignore', windowsHide: true, env });
}
process.stdout.write('LAUNCH skip=false\\r\\nREADY\\r\\n');
process.stdin.setRawMode?.(true);
process.stdin.on('data', (data) => { if (data.toString('utf8').includes('\\x04')) process.exit(0); });
`;

/** The agent plus every descendant it starts. */
export const TREE_SIZE = 6;

/** What `orphans` adds: two processes whose parents have exited. */
export const ORPHANS = 2;

export interface TreeAgent {
  /** The directory every process of the tree names. */
  marker: string;
  script: string;
  /** Its arguments: the script and the marker, then `orphans` when asked for. */
  args: string[];
  /** How many processes of the tree run once it is ready. */
  size: number;
}

export function writeTreeAgent(options: { orphans?: boolean } = {}): TreeAgent {
  const marker = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
  const script = join(marker, 'agent.mjs');
  writeFileSync(script, AGENT);
  const args = [script, marker, ...(options.orphans ? ['orphans'] : [])];
  return { marker, script, args, size: TREE_SIZE + (options.orphans ? ORPHANS : 0) };
}

/**
 * What to type into a PowerShell PTY to start three servers through
 * intermediates that exit at once: `cmd /c start /b`, a short-lived
 * PowerShell's Start-Process, and a short-lived node that detaches a child.
 * Only the servers' command lines name `dir` (it travels in `$env:M`).
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

/** Stops whatever a failed test left of a tree (best effort). */
export async function stopMarked(marker: string): Promise<void> {
  for (const entry of await marked(marker).catch(() => [])) {
    try {
      process.kill(entry.pid);
    } catch {
      // Gone already.
    }
  }
}

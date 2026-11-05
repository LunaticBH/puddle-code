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
 * `node agent.mjs <marker>`: starts a console-inheriting child, a hidden one
 * (a console of its own), a detached one, and a hidden one that starts its
 * own child, prints READY and waits; Ctrl-D ends it.
 */
const AGENT = `
import { spawn } from 'node:child_process';
const marker = process.argv[2];
const keep = 'setInterval(() => {}, 1e9)';
spawn(process.execPath, ['-e', keep, marker + ':inherit'], { stdio: 'ignore' });
spawn(process.execPath, ['-e', keep, marker + ':hidden'], { stdio: 'ignore', windowsHide: true });
spawn(process.execPath, ['-e', keep, marker + ':detached'], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
const deep = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', process.argv[1] + ':deep'], { stdio: 'ignore' }); setInterval(() => {}, 1e9)";
spawn(process.execPath, ['-e', deep, marker + ':mid'], { stdio: 'ignore', windowsHide: true });
process.stdout.write('LAUNCH skip=false\\r\\nREADY\\r\\n');
process.stdin.setRawMode?.(true);
process.stdin.on('data', (data) => { if (data.toString('utf8').includes('\\x04')) process.exit(0); });
`;

/** The agent plus every descendant it starts. */
export const TREE_SIZE = 6;

export interface TreeAgent {
  /** The directory every process of the tree names. */
  marker: string;
  script: string;
}

export function writeTreeAgent(): TreeAgent {
  const marker = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
  const script = join(marker, 'agent.mjs');
  writeFileSync(script, AGENT);
  return { marker, script };
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

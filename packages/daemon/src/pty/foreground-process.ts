import { execFile } from 'node:child_process';
import { listWindowsProcesses, type WindowsProcess } from '@puddle/shared/node/platform';

export interface ProcessEntry {
  pid: number;
  parent: number;
  group: number;
  foregroundGroup: number;
  tty: string;
  state: string;
  command: string;
  /**
   * Windows only: creation time in Unix ms (null when Windows withholds it).
   * Windows never re-parents orphans and reuses pids quickly, so a parent
   * link is trusted only when the child is not older than its parent.
   */
  createdAtMs?: number | null;
}

/** Shared macOS/Linux ps columns; malformed/incomplete records are ignored. */
export function parseProcessSnapshot(stdout: string): Map<number, ProcessEntry> {
  const entries = new Map<number, ProcessEntry>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const entry: ProcessEntry = {
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      foregroundGroup: Number(match[4]),
      tty: match[5]!,
      state: match[6]!,
      command: match[7]!,
    };
    entries.set(entry.pid, entry);
  }
  return entries;
}

/**
 * A Windows process table as ProcessEntry records. Windows has no terminals,
 * process groups or job states, so those fields are empty; `command` takes the
 * shape adapters match on POSIX (see windowsProcessCommand).
 */
export function windowsProcessSnapshot(
  processes: readonly WindowsProcess[],
): Map<number, ProcessEntry> {
  const entries = new Map<number, ProcessEntry>();
  for (const proc of processes) {
    entries.set(proc.pid, {
      pid: proc.pid,
      parent: proc.ppid,
      group: 0,
      foregroundGroup: 0,
      tty: '',
      state: '',
      command: windowsProcessCommand(proc),
      createdAtMs: proc.createdAtMs,
    });
  }
  return entries;
}

/**
 * `ps args`-shaped text for a Windows process: the image name without `.exe`
 * in lower case, then the rest of its command line with `\` turned into `/`.
 * `"C:\Program Files\nodejs\node.exe" C:\npm\node_modules\@openai\codex\bin\codex.js`
 * becomes `node C:/npm/node_modules/@openai/codex/bin/codex.js`, so the
 * adapters' executable and entry-point matching applies unchanged. Only the
 * image name is known for another user's or a protected process.
 */
export function windowsProcessCommand(proc: WindowsProcess): string {
  const line = proc.commandLine?.trim() ?? '';
  const first = /^(?:"[^"]*"|\S+)/.exec(line)?.[0] ?? '';
  const rest = line.slice(first.length).trim().replaceAll('\\', '/');
  return rest === '' ? proc.command : `${proc.command} ${rest}`;
}

/** One bounded asynchronous snapshot for all terminal sessions, never sent to clients. */
export function readProcessSnapshot(
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, ProcessEntry>> {
  if (platform === 'win32') return listWindowsProcesses().then(windowsProcessSnapshot);
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-ww', '-axo', 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,args='],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessSnapshot(stdout));
      },
    );
  });
}

/**
 * Foreground jobs and their ancestors, restricted to this PTY's descendants.
 * Keeping ancestors preserves the agent icon while it runs a foreground tool;
 * a background/suspended job or another terminal's agent cannot claim it.
 *
 * Windows has no job control, so every descendant of the PTY's root counts as
 * foreground: each root-to-leaf path is returned, and the caller's
 * one-agent-only rule settles ambiguity.
 */
export function foregroundProcesses(
  rootPid: number,
  entries: ReadonlyMap<number, ProcessEntry>,
  platform: NodeJS.Platform = process.platform,
): ProcessEntry[][] {
  if (platform === 'win32') return descendantPaths(rootPid, entries);
  const root = entries.get(rootPid);
  if (!root || /^\?+$/.test(root.tty) || root.foregroundGroup <= 0) return [];
  const paths: ProcessEntry[][] = [];
  for (const entry of entries.values()) {
    if (entry.tty !== root.tty || entry.group !== root.foregroundGroup) continue;
    const path: ProcessEntry[] = [];
    const seen = new Set<number>();
    let current: ProcessEntry | undefined = entry;
    while (current && !seen.has(current.pid)) {
      if (current.tty !== root.tty || /[TtZ]/.test(current.state)) break;
      seen.add(current.pid);
      path.push(current);
      if (current.pid === rootPid) {
        paths.push(path.reverse());
        break;
      }
      current = entries.get(current.parent);
    }
  }
  return paths;
}

/** Every root-to-leaf path below `rootPid`, following only creation-consistent links. */
function descendantPaths(
  rootPid: number,
  entries: ReadonlyMap<number, ProcessEntry>,
): ProcessEntry[][] {
  const root = entries.get(rootPid);
  if (!root) return [];
  const children = childrenByParent(entries.values());
  const paths: ProcessEntry[][] = [];
  const walk = (path: ProcessEntry[], seen: Set<number>): void => {
    const parent = path[path.length - 1]!;
    const next = (children.get(parent.pid) ?? []).filter(
      (child) => !seen.has(child.pid) && bornAfter(child, parent),
    );
    if (next.length === 0) {
      paths.push(path);
      return;
    }
    for (const child of next) walk([...path, child], new Set(seen).add(child.pid));
  };
  walk([root], new Set([rootPid]));
  return paths;
}

function childrenByParent(entries: Iterable<ProcessEntry>): Map<number, ProcessEntry[]> {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parent);
    if (siblings) siblings.push(entry);
    else children.set(entry.parent, [entry]);
  }
  return children;
}

/**
 * Whether `child` can really be `parent`'s child: a child started before its
 * recorded parent was created belongs to an earlier holder of the parent's pid.
 * Unknown times are trusted, as POSIX trusts every parent link.
 */
export function bornAfter(
  child: Pick<ProcessEntry, 'createdAtMs'>,
  parent: Pick<ProcessEntry, 'createdAtMs'>,
): boolean {
  const childTime = child.createdAtMs ?? null;
  const parentTime = parent.createdAtMs ?? null;
  return childTime === null || parentTime === null || childTime >= parentTime;
}

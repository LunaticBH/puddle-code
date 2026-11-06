import type { WindowsProcess } from '@puddle/shared/node/platform';
import type { ClassifiedProcess, ConptyConsole } from '../../src/pty/conpty-jobs.js';

/**
 * Stand-ins for the Windows stops that go by a console (docs/windows.md,
 * decision 8): a process table and a ConPTY helper over it, so that those
 * stops run on any OS.
 */

/** A process table entry. */
export const entry = (
  pid: number,
  ppid: number,
  createdAtMs: number,
  name = 'node.exe',
): WindowsProcess => ({
  pid,
  ppid,
  name,
  command: name.replace(/\.exe$/i, '').toLowerCase(),
  commandLine: `${name} ${pid}`,
  createdAtMs,
});

/** The helper's key for `entry`. */
export const key = (e: WindowsProcess) => `${e.pid}@${e.createdAtMs}`;

/**
 * A process table and a ConPTY helper over it: `attached` names each
 * process's console host (0 for none), `gui` the GUI programmes. The helper
 * holds only processes still running as created then; ending one removes it.
 */
export function world(
  initial: WindowsProcess[],
  info: { attached: Record<number, number>; gui?: number[] },
) {
  let processes = [...initial];
  const ended: string[] = [];
  const terminated: number[] = [];
  const classified: string[][] = [];
  let released = 0;
  const hooks: Array<(key: string) => void> = [];
  const remove = (pid: number, createdAtMs?: number) => {
    processes = processes.filter(
      (p) => !(p.pid === pid && (createdAtMs === undefined || p.createdAtMs === createdAtMs)),
    );
  };
  const console = (): ConptyConsole => ({
    rootCreatedAtMs: null,
    host: null,
    alive: async () => null,
    scan: async () => null,
    terminate: async (keys) => {
      for (const key of keys) {
        ended.push(key);
        const [pid, created] = key.split('@').map(Number);
        remove(pid!, created);
        for (const hook of hooks) hook(key);
      }
      return keys.length;
    },
    release: () => {
      released++;
    },
  });
  return {
    ended,
    terminated,
    classified,
    released: () => released,
    add: (...more: WindowsProcess[]) => processes.push(...more),
    remove,
    onEnd: (hook: (key: string) => void) => hooks.push(hook),
    processes: async () => [...processes],
    terminate: (pid: number) => {
      terminated.push(pid);
      remove(pid);
    },
    inspector: {
      ready: async () => true,
      classify: async (list: readonly { pid: number; createdAtMs: number }[]) => {
        classified.push(list.map((p) => `${p.pid}@${p.createdAtMs}`));
        const held: ClassifiedProcess[] = list
          .filter((p) => processes.some((e) => e.pid === p.pid && e.createdAtMs === p.createdAtMs))
          .map((p) => ({
            ...p,
            key: `${p.pid}@${p.createdAtMs}`,
            gui: info.gui?.includes(p.pid) ?? false,
            consoleHost: info.attached[p.pid] ?? 0,
          }));
        return { console: console(), processes: held };
      },
    },
  };
}

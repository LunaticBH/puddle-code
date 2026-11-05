import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * node-pty's ConPTY `kill()` lists the processes attached to the console with
 * a helper process (`conpty_console_list_agent.js`) and ends each one. When
 * the helper cannot attach to the console, because the root has exited
 * already (closing its console or ending its job does that), node-pty waits
 * 5 s and then ends the root's pid regardless, which by then may name another
 * process; and the helper's stack trace lands in the daemon's log. This
 * replaces the listing on one PTY with the same helper and the same list when
 * it succeeds, and with nothing to end, at once, when it fails
 * (docs/windows.md, decision 8). node-pty 1.1's internals, guarded: on
 * another version that lacks them this changes nothing.
 */
export function guardConsoleListKill(proc: unknown): void {
  const agent = (proc as { _agent?: ConsoleListAgent } | null)?._agent;
  if (!agent || typeof agent._getConsoleProcessList !== 'function') return;
  agent._getConsoleProcessList = () => consoleProcessList(agent._innerPid);
}

interface ConsoleListAgent {
  _innerPid: number;
  _getConsoleProcessList(): Promise<number[]>;
}

/** node-pty's own bound on the helper. */
const HELPER_MS = 5000;

let helper: string | null | undefined;

function helperScript(): string | null {
  if (helper === undefined) {
    try {
      const entry = createRequire(import.meta.url).resolve('node-pty');
      helper = join(dirname(entry), 'conpty_console_list_agent.js');
    } catch {
      helper = null;
    }
  }
  return helper;
}

/** The pids attached to `pid`'s console; none when that cannot be read. */
export function consoleProcessList(pid: number, script = helperScript()): Promise<number[]> {
  if (script === null || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = fork(script, [String(pid)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    } catch {
      resolve([]);
      return;
    }
    let done = false;
    const finish = (list: number[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(list);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, HELPER_MS);
    child.on('message', (message: { consoleProcessList?: unknown } | null) => {
      const list = message?.consoleProcessList;
      finish(
        Array.isArray(list)
          ? list.filter((entry): entry is number => Number.isSafeInteger(entry) && entry > 0)
          : [],
      );
    });
    // After the IPC channel has closed, so a message it sent has been read.
    child.on('close', () => finish([]));
    child.on('error', () => finish([]));
  });
}

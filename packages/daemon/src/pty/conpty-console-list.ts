/**
 * node-pty's ConPTY `kill()` lists the processes attached to the console
 * with a helper process (`conpty_console_list_agent.js`) and ends each one
 * at once by pid, racing the console's own close: whatever it lists loses
 * its CTRL_CLOSE grace, a pid listed may name another process by the time
 * it is ended, and when the helper cannot attach (the root has exited) it
 * waits 5 s and ends the root's pid regardless, its stack trace landing in
 * the daemon's log. This makes the listing on one PTY empty, so that its
 * `kill()` only closes the pseudoconsole; PtyManager ends what the close
 * leaves through the ConPTY helper, which holds what it ends
 * (conpty-teardown.ts; docs/windows.md, decision 8). node-pty 1.1's
 * internals, guarded: on another version that lacks them this changes
 * nothing.
 */
export function guardConsoleListKill(proc: unknown): void {
  const agent = (proc as { _agent?: ConsoleListAgent } | null)?._agent;
  if (!agent || typeof agent._getConsoleProcessList !== 'function') return;
  agent._getConsoleProcessList = () => Promise.resolve([]);
}

interface ConsoleListAgent {
  _getConsoleProcessList(): Promise<number[]>;
}

/**
 * Calls `onExit` with the root's exit code as soon as node-pty learns of
 * it, from the thread that waits on the root: node-pty's own exit event
 * comes only once the console's output has been quiet for a second, which
 * a process still attached to it may put off indefinitely. Returns
 * whether it could (node-pty 1.1's internals, guarded).
 */
export function onRootExit(proc: unknown, onExit: (exitCode: number) => void): boolean {
  const agent = (proc as { _agent?: RootExitAgent } | null)?._agent;
  if (!agent || typeof agent._$onProcessExit !== 'function') return false;
  const original = agent._$onProcessExit.bind(agent);
  agent._$onProcessExit = (exitCode: number) => {
    try {
      onExit(exitCode);
    } finally {
      original(exitCode);
    }
  };
  return true;
}

interface RootExitAgent {
  _$onProcessExit(exitCode: number): void;
}

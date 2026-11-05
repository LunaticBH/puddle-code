import type { ConptyConsole, ConsoleScan } from './conpty-jobs.js';

/**
 * What a ConPTY's end ends (docs/windows.md, decision 8): exactly the
 * processes attached to its console, then its headless console host, as a
 * hang-up ends the processes of a POSIX terminal's session and nothing else.
 *
 * Windows ends a console's processes itself when the console closes
 * (ClosePseudoConsole sends them CTRL_CLOSE_EVENT, and ends them once their
 * handlers return), but node-pty closes a pseudoconsole only from `kill()`
 * while its root runs, so a console whose root exited on its own, and
 * whatever still runs in it, would last as long as the daemon. A process
 * that left the console is never ended: a GUI programme and everything it
 * starts, a detached process, one started in a console of its own (any
 * hidden Node child, PowerShell's `Start-Process`, `start` of a programme),
 * as `nohup`, `setsid` and GUI launches survive a hang-up on POSIX. The
 * ConPTY helper (conpty-jobs.ts) names the console's processes and holds
 * each one open, so a pid it names is never another process's.
 */

/** The root as the helper holds it, and its pid. */
export interface HeldRoot {
  pid: number;
  console: Pick<ConptyConsole, 'rootCreatedAtMs' | 'host'>;
}

/**
 * Which held processes of `scan` a teardown ends: every process attached to
 * the PTY's console (by its console host, else by the console's own list),
 * never a GUI programme; the root only when `root`, as `root`, whatever its
 * image (it is the session's own process).
 */
export function consoleTargets(
  scan: ConsoleScan,
  held: HeldRoot,
  options: { root: boolean },
): string[] {
  const targets: string[] = [];
  if (options.root && scan.rootAlive) targets.push('root');
  const host = held.console.host;
  for (const member of scan.members) {
    const isRoot =
      member.pid === held.pid &&
      held.console.rootCreatedAtMs !== null &&
      member.createdAtMs === held.console.rootCreatedAtMs;
    if (isRoot || member.gui) continue;
    if (host !== null ? member.consoleHost === host.pid : member.listed) targets.push(member.key);
  }
  return targets;
}

export interface EndConsoleOptions {
  /** End the root too, if it still runs. */
  root: boolean;
  /** Then end the console host, if it still runs. */
  host: boolean;
  /**
   * Read the console's own list as well (attaching to it): only while
   * nobody closes the console, whose close would end whatever is attached.
   */
  attach: boolean;
}

/**
 * Ends what `console` holds attached to the PTY's console, reading it again
 * for processes started in between, at most twice more; then its console
 * host. Resolves with how many processes it ended; never rejects.
 */
export async function endConsole(
  root: number,
  console: ConptyConsole,
  options: EndConsoleOptions,
): Promise<number> {
  const held: HeldRoot = { pid: root, console };
  let ended = 0;
  // Without a known host only the console's own list names its processes.
  const attach = options.attach && console.host === null;
  for (let round = 0; round < 3; round++) {
    const scan = await console.scan({ attach: round === 0 ? options.attach : attach });
    if (!scan) return ended;
    const targets = consoleTargets(scan, held, { root: options.root });
    if (targets.length === 0) {
      if (options.host && scan.hostAlive) ended += await console.terminate(['host']);
      return ended;
    }
    ended += await console.terminate(targets);
  }
  // Something keeps starting processes in it: its host goes regardless.
  if (options.host) ended += await console.terminate(['host']);
  return ended;
}

/**
 * When a ConPTY's exit is reported at the latest (PtyManager): set by the
 * first stop request and by the root's own exit, brought forward by a
 * SIGKILL, never put back.
 */
export class ExitDeadline {
  private at = Infinity;
  private readonly wakers = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The deadline, Infinity while none is set. */
  get ms(): number {
    return this.at;
  }

  /** At most `ms` from now. */
  within(ms: number): void {
    const at = this.now() + ms;
    if (at >= this.at) return;
    this.at = at;
    for (const wake of [...this.wakers]) wake();
  }

  /** Resolves with `work`'s value, or with `late` when the deadline passes first. */
  race<T>(work: Promise<T>, late: T): Promise<T> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: T) => {
        clearTimeout(timer);
        this.wakers.delete(arm);
        resolve(value);
      };
      const arm = () => {
        clearTimeout(timer);
        const left = this.at - this.now();
        if (left <= 0) done(late);
        else if (Number.isFinite(left)) timer = setTimeout(arm, left);
      };
      this.wakers.add(arm);
      arm();
      work.then(done, () => done(late));
    });
  }
}

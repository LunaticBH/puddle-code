/**
 * When a test's child process started and exited, for stopping what it
 * left running on Windows (cli/e2e/helpers.ts): the process table tells the
 * child's orphans from a later holder of its pid's children only by when
 * the child lived, so its exit is recorded the moment Node sees it, never
 * when a stop gets round to it, and what it left is stopped once.
 */

interface Lifetime {
  startedAtMs: number;
  exitedAtMs?: number;
  reaped: boolean;
}

const lifetimes = new WeakMap<object, Lifetime>();

/** What of a ChildProcess this needs. */
export interface ExitingChild {
  readonly pid?: number | undefined;
  once(event: 'exit', listener: () => void): unknown;
}

/** Starts a child through `start`, recording when (just before) and, later, when it exits. */
export function tracked<T extends ExitingChild>(start: () => T, now: () => number = Date.now): T {
  const startedAtMs = now();
  const child = start();
  const lifetime: Lifetime = { startedAtMs, reaped: false };
  lifetimes.set(child, lifetime);
  child.once('exit', () => (lifetime.exitedAtMs ??= now()));
  return child;
}

/** What is known of a tracked child that has exited: its pid's lifetime then. */
export interface ExitedChild {
  pid: number;
  startedAtMs: number;
  exitedAtMs: number;
}

/**
 * Once a tracked `child` has exited, runs `stop` on its lifetime, at most
 * once however many times it is asked (a test's own stop, then its file's
 * teardown). Resolves whether it ran.
 */
export async function reapExited(
  child: Pick<ExitingChild, 'pid'>,
  stop: (exited: ExitedChild) => Promise<unknown>,
  now: () => number = Date.now,
): Promise<boolean> {
  const lifetime = lifetimes.get(child);
  if (!lifetime || lifetime.reaped || child.pid === undefined) return false;
  lifetime.reaped = true;
  await stop({
    pid: child.pid,
    startedAtMs: lifetime.startedAtMs,
    exitedAtMs: lifetime.exitedAtMs ?? now(),
  });
  return true;
}

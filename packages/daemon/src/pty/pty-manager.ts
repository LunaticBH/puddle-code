import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import type { LogStore } from '../logs/log-store.js';
import { guardConsoleListKill, hangUpConsole, onRootExit } from './conpty-console-list.js';
import {
  ATTACH_MARGIN_MS,
  noteConptySpawn,
  sharedConptyJobs,
  type ConptyConsole,
  type ConptyJobs,
} from './conpty-jobs.js';
import { endConsole, endRootByPid, ExitDeadline, guiAttached } from './conpty-teardown.js';
import { EnvOscFilter, type EnvDelta } from './env-osc.js';
import { writePtyRoots, type PtyRootRecord } from './pty-roots.js';
import { planPtySpawn } from './pty-spawn.js';
import { TerminalScreenStateStore } from './terminal-screen-state.js';
import { findColourQueries, QUERY_CARRY, type TerminalTheme } from './terminal-theme.js';

export interface PtyDataEvent {
  stream: string;
  term: string;
  data: string;
}

export interface PtyExitEvent {
  stream: string;
  term: string;
  exitCode: number;
}

/** A captured-env report parsed (and stripped) from a PTY's OSC 7733 side-channel. */
export interface PtyEnvDeltaEvent {
  stream: string;
  term: string;
  delta: EnvDelta;
}

/** A shell prompt's current directory, parsed and stripped from OSC 7733. */
export interface PtyCwdEvent {
  stream: string;
  term: string;
  cwd: string;
}

interface Live {
  proc: pty.IPty;
  record: boolean;
  filter: EnvOscFilter;
  /** Mutable runtime placement; lifecycle switches rebind without respawning. */
  stream: string;
  term: string;
  /** Raw chunks held while the old log/screen segment is being frozen. */
  quiesced: string[] | null;
  /** Chunk-boundary carry for the OSC colour-query scanner (terminal-theme.ts). */
  queryTail: string;
  /** Windows only (null elsewhere); see ConptyState. */
  conpty: ConptyState | null;
}

/**
 * ConPTY bookkeeping. node-pty on Windows queues write/resize/kill until the
 * first output chunk and then runs them inside its socket listener, where a
 * throw (resizing a PTY that exited meanwhile) is uncaught and ends the
 * daemon. Resizes are therefore held here until the PTY is ready, and the
 * pseudoconsole is closed at most once (`closed`): a second `kill()` reaches
 * a closed native handle.
 *
 * `size` is the pseudoconsole's current size. ResizePseudoConsole repaints the
 * whole screen even when the size is unchanged, which would duplicate a
 * viewer's just-replayed snapshot as live output, so an unchanged size is
 * never re-applied.
 *
 * Windows has no hang-up: the PTY's end ends what is attached to its console
 * (conpty-teardown.ts) before its exit is reported. `startedAtMs` and
 * `spawnedAtMs` bracket `pty.spawn`, which creates the root and the console
 * host: with them the ConPTY helper tells this PTY's root and host apart and
 * holds them open (`console`, conpty-jobs.ts). `exitedAtMs` is when
 * node-pty's thread saw the root exit; `drained` settles once node-pty has
 * reported the exit, a second after the console's output went quiet.
 * `closing` is set once a stop has begun to close the pseudoconsole,
 * `scanning` while the helper is attached to it just before, `spareGui`
 * when that found a GUI programme attached to it (or something one started
 * there), which the console's close would end: the console is then never
 * closed, and the teardown ends the rest itself. `killing` is set once a
 * SIGKILL has come; `settling` once the teardown has begun. `deadline` is
 * when the exit is reported at the latest, whatever the helper does.
 */
interface ConptyState {
  ready: boolean;
  closed: boolean;
  closedAtMs: number;
  size: { cols: number; rows: number };
  startedAtMs: number;
  spawnedAtMs: number;
  console: Promise<ConptyConsole | null>;
  /** `console` once it has settled; undefined until then. */
  held: ConptyConsole | null | undefined;
  /** node-pty's own callback reports the root's exit here (onRootExit). */
  hooked: boolean;
  exitedAtMs: number | undefined;
  exitCode: number | undefined;
  rootExited: Deferred;
  drained: Deferred;
  closing: boolean;
  scanning: boolean;
  spareGui: boolean;
  killing: boolean;
  settling: boolean;
  /** The teardown is over: the helper holds nothing for this PTY any more. */
  released: boolean;
  reported: boolean;
  deadline: ExitDeadline;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/**
 * Bounds on reporting a ConPTY's exit, the stopping going on after it: from
 * the first stop request, from a SIGKILL, and from the root's own exit when
 * nobody asked. SessionService.kill sends SIGKILL 4 s after its stop and
 * gives up 2 s later, so a stop answers within that even when the ConPTY
 * helper is slow, wedged or missing (PowerShell in Constrained Language
 * Mode): only node-pty's own calls stand between a SIGKILL and the exit.
 */
const STOP_BOUND_MS = 4500;
const KILL_BOUND_MS = 250;
const CONPTY_TEARDOWN_MS = 5000;

/**
 * After a stop closed the console, how long what was attached to it may
 * take to handle CTRL_CLOSE_EVENT and exit, before what is left is ended.
 */
const CLOSE_GRACE_MS = 3000;

/** A grace ends at least this long before the deadline, so that the teardown can end what is left. */
const END_MARGIN_MS = 300;

/** Bound on reading the console's processes before a stop closes it (the helper answers in ~30 ms). */
const SNAPSHOT_BOUND_MS = 1500;

/** Bound on the daemon's start waiting for its ConPTY helper (it starts in ~0.5 s). */
const JOBS_READY_BOUND_MS = 5000;

const windows = process.platform === 'win32';

/** Between this process's clock and the creation times Windows records (measured within 10 ms). */
const CLOCK_SLACK_MS = 100;

/** Resolves with `work`'s value, or `late` once `ms` passes or it rejects; never rejects. */
function within<T>(work: Promise<T>, ms: number, late: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(late), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(late);
      },
    );
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The size a PTY starts at when no viewer has ever sized this (stream, term) —
 * a plausible terminal, not the one on screen (nothing is attached yet).
 */
const DEFAULT_SIZE = { cols: 120, rows: 32 } as const;

/**
 * Owns every live PTY, keyed by (stream, term) where stream is a session id
 * or `login-<accountId>`. Tees recorded output to the LogStore. Emits
 * 'data' (PtyDataEvent), 'exit' (PtyExitEvent), 'env-delta'
 * (PtyEnvDeltaEvent), and 'cwd' (PtyCwdEvent). A PTY has exactly one size — the most recent
 * attach/resize wins (SPEC §6). Every PTY's output passes through an
 * EnvOscFilter, so OSC 7733 payloads (captured env, potential secrets) are
 * stripped before any log write or 'data' emit.
 */
export class PtyManager extends EventEmitter {
  private readonly live = new Map<string, Live>();
  private readonly sidecars = new Map<string, { pids: Set<number>; hiddenPorts: Set<number> }>();
  private readonly screens: TerminalScreenStateStore;
  /**
   * The last size a viewer asked for, per (stream, term) — kept whether or not a
   * PTY is live so the NEXT one starts at it. A resume or an account migration
   * replaces the PTY under an attached viewer, and nothing re-sends the size
   * then: the viewer is already attached (no fresh `attach`) and its container
   * has not changed (no resize), so a fixed default left the agent rendering to
   * a screen that wasn't there — a TUI wrapped or short of the pane it sits in.
   */
  private readonly sizes = new Map<string, { cols: number; rows: number }>();

  constructor(
    private readonly logs: LogStore,
    /**
     * Answers OSC 10/11 colour queries from PTY output (protocol 14.1) —
     * agents query at spawn, before any viewer attaches, so the daemon is
     * the one party that always sees the query. Optional so tests that
     * exercise PTYs alone need not care.
     */
    private readonly theme?: TerminalTheme,
    stateDir?: string,
    onScreenHealth?: (degraded: boolean) => void,
    /**
     * Windows: `rootsFile` is where to record the live ConPTYs for the
     * resident supervisor (pty-roots.ts; the daemon passes
     * `<home>\pty-roots.json`), and `jobs` the ConPTY helper
     * (conpty-jobs.ts), this process's shared one by default; null runs
     * without one, as where PowerShell cannot run it.
     */
    conpty: { rootsFile?: string; jobs?: ConptyJobs | null } = {},
  ) {
    super();
    this.screens = new TerminalScreenStateStore(stateDir, onScreenHealth);
    this.rootsFile = conpty.rootsFile;
    this.jobs = windows ? (conpty.jobs === undefined ? sharedConptyJobs() : conpty.jobs) : null;
    // Started now, so that the first PTY's root is held before it can exit.
    void this.jobs?.ready();
    this.recordRoots();
  }

  private readonly rootsFile: string | undefined;
  private readonly jobs: ConptyJobs | null;
  /** Windows: the teardowns still ending what exited PTYs' consoles held. */
  private readonly teardowns = new Set<Promise<unknown>>();

  /**
   * Windows: resolves once the ConPTY helper can take this process's PTYs,
   * or cannot start, within a bound: a root held from its spawn is told
   * apart, with its console, however soon it exits.
   */
  async prepare(): Promise<void> {
    if (this.jobs) await within(this.jobs.ready(), JOBS_READY_BOUND_MS, false);
  }

  /**
   * Windows: waits, up to `ms`, for every teardown still ending what exited
   * PTYs' consoles held (their exits were reported at their deadlines).
   */
  async settled(ms: number): Promise<void> {
    if (this.teardowns.size > 0) {
      await within(Promise.allSettled([...this.teardowns]), ms, []);
    }
  }

  private track<T>(work: Promise<T>): Promise<T | undefined> {
    const tracked = work.catch(() => undefined);
    this.teardowns.add(tracked);
    void tracked.finally(() => this.teardowns.delete(tracked));
    return tracked;
  }

  /** Replaces the supervisor's record of this process's live ConPTYs. */
  private recordRoots(): void {
    if (!windows || this.rootsFile === undefined) return;
    writePtyRoots(
      this.rootsFile,
      process.pid,
      [...this.live.values()].map((live) => {
        const state = live.conpty!;
        const record: PtyRootRecord = {
          pid: live.proc.pid,
          startedAtMs: state.startedAtMs,
          spawnedAtMs: state.spawnedAtMs,
        };
        if (state.held && state.held.rootCreatedAtMs !== null) {
          record.createdAtMs = state.held.rootCreatedAtMs;
        }
        if (state.exitedAtMs !== undefined) record.exitedAtMs = state.exitedAtMs;
        if (state.held?.host) record.host = { ...state.held.host };
        return record;
      }),
    );
  }

  spawn(
    stream: string,
    term: string,
    file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string>; record?: boolean },
  ): void {
    const key = this.key(stream, term);
    if (this.live.has(key)) throw new Error(`pty ${key} already live`);
    const record = opts.record ?? true;
    const size = this.sizes.get(key) ?? DEFAULT_SIZE;
    this.screens.resize(stream, term, size.cols, size.rows);
    const plan = planPtySpawn(file, args, opts.env);
    const startedAtMs = windows ? Date.now() : 0;
    const proc = pty.spawn(plan.file, plan.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: opts.cwd,
      env: plan.env,
    });
    const spawnedAtMs = windows ? Date.now() : 0;
    if (windows) {
      guardConsoleListKill(proc);
      // So that no process of this spawn's is taken for another's (conpty-jobs.ts).
      noteConptySpawn({ startedAtMs, spawnedAtMs });
    }
    const filter = new EnvOscFilter();
    const live: Live = {
      proc,
      record,
      filter,
      stream,
      term,
      quiesced: null,
      queryTail: '',
      conpty: windows
        ? {
            ready: false,
            closed: false,
            closedAtMs: 0,
            size,
            startedAtMs,
            spawnedAtMs,
            console: Promise.resolve(null),
            held: undefined,
            hooked: false,
            exitedAtMs: undefined,
            exitCode: undefined,
            rootExited: deferred(),
            drained: deferred(),
            closing: false,
            scanning: false,
            spareGui: false,
            killing: false,
            settling: false,
            released: false,
            reported: false,
            deadline: new ExitDeadline(),
          }
        : null,
    };
    if (live.conpty) {
      const state = live.conpty;
      state.console = this.holdConsole(proc.pid, startedAtMs, spawnedAtMs).then((held) => {
        // Too late for a teardown that went ahead without it: nothing to hold.
        if (state.released) {
          held?.release();
          return null;
        }
        state.held = held;
        // The supervisor's lead to the console, should the daemon die.
        if (held?.host && this.live.get(this.key(live.stream, live.term)) === live) {
          this.recordRoots();
        }
        return held;
      });
      state.hooked = onRootExit(proc, (exitCode) => this.conptyRootExited(live, exitCode));
    }
    this.live.set(key, live);
    this.recordRoots();
    proc.onData((raw) => {
      // Windows: what the console still writes once the exit is reported goes nowhere.
      if (live.conpty?.reported) return;
      if (live.conpty && !live.conpty.ready) this.conptyReady(live);
      if (live.quiesced !== null) {
        live.quiesced.push(raw);
        return;
      }
      this.handleData(live, raw);
    });
    proc.onExit(({ exitCode }) => {
      if (live.conpty) {
        this.conptyDrained(live, exitCode);
        return;
      }
      this.exited(live, exitCode);
    });
  }

  /** The helper's hold on the PTY, waiting for it no later than the deadline (or `boundMs`). */
  private heldConsole(state: ConptyState, boundMs?: number): Promise<ConptyConsole | null> {
    if (state.held !== undefined) return Promise.resolve(state.held);
    const raced = state.deadline.race(state.console, null);
    return boundMs === undefined ? raced : within(raced, boundMs, null);
  }

  /** The ConPTY helper's hold on the root and its console host (conpty-jobs.ts); null without one. */
  private holdConsole(
    pid: number,
    startedAtMs: number,
    spawnedAtMs: number,
  ): Promise<ConptyConsole | null> {
    if (!this.jobs) return Promise.resolve(null);
    return this.jobs
      .track(pid, {
        fromMs: startedAtMs - CLOCK_SLACK_MS,
        toMs: spawnedAtMs + CLOCK_SLACK_MS,
        startedAtMs,
        spawnedAtMs,
      })
      .catch(() => null);
  }

  /** node-pty's thread saw the root exit: its console's teardown begins (Windows has no hang-up). */
  private conptyRootExited(live: Live, exitCode: number | undefined): void {
    const state = live.conpty!;
    if (state.exitedAtMs !== undefined) return;
    state.exitedAtMs = Date.now();
    state.exitCode ??= exitCode;
    state.rootExited.resolve();
    state.deadline.within(CONPTY_TEARDOWN_MS);
    // The supervisor bounds what it takes for this root's by when it exited.
    if (this.live.get(this.key(live.stream, live.term)) === live) this.recordRoots();
    this.settleConpty(live);
  }

  /**
   * node-pty reported the exit: the console's output has drained. Without
   * an exit code the root may still run (its console host went first).
   */
  private conptyDrained(live: Live, exitCode: number | undefined): void {
    const state = live.conpty!;
    state.drained.resolve();
    if (exitCode !== undefined && !state.hooked) this.conptyRootExited(live, exitCode);
    state.exitCode ??= exitCode;
    state.deadline.within(CONPTY_TEARDOWN_MS);
    this.settleConpty(live);
  }

  /**
   * Once the root has exited, or node-pty has reported the exit: the PTY
   * stays live, and its exit unreported, until what was attached to its
   * console is ended and node-pty has drained its output, or until the
   * deadline, so that a session's kill and the daemon's shutdown wait for
   * that too; the teardown carries on past the deadline (`settled`).
   */
  private settleConpty(live: Live): void {
    const state = live.conpty!;
    if (state.settling) return;
    state.settling = true;
    const teardown = this.track(this.conptyTeardown(live));
    void state.deadline
      .race(
        Promise.all([teardown, state.drained.promise]).then(() => true),
        false,
      )
      .then(() => {
        if (state.reported) return;
        state.reported = true;
        this.exited(live, state.exitCode);
      });
  }

  /**
   * Ends what the PTY's console still holds (conpty-teardown.ts). A console
   * a stop closed first has its grace: Windows asks what is attached to it
   * to exit, and the host goes once they have. One a stop left open for a
   * GUI programme attached to it has none: nothing but its close could ask
   * the rest to exit. Without the helper, when it does not answer, or when
   * it never told the console host apart, a console nobody closed is hung
   * up (hangUpConsole), which ends what is attached as a close does; only
   * the root can be told apart then, and only while node-pty has not seen
   * it exit, and the console host stays until the daemon exits. (Even for a
   * scan that went unanswered, the helper is no longer attached to the
   * console by then: it attaches no later than ATTACH_MARGIN_MS before the
   * scan's bound.)
   */
  private async conptyTeardown(live: Live): Promise<void> {
    const state = live.conpty!;
    const held = await this.heldConsole(state);
    try {
      if (!state.killing && !state.spareGui) {
        if (state.closed) await this.closeGrace(state, held);
        else if (state.exitedAtMs === undefined) await this.rootGrace(state);
      }
      // A root that outstayed its grace goes first, whatever the helper does.
      await this.endRoot(live);
      let answered = false;
      if (held) {
        ({ answered } = await endConsole(live.proc.pid, held, {
          root: true,
          host: true,
          // Its own list only while it is open (no stop closes it once the
          // teardown has begun): a close would end the helper attached to it.
          attach: !state.closed,
        }));
      }
      // Nothing named what is attached (no helper, no answer, or no host told
      // apart, its root gone): hang the console up, unless that would end a
      // GUI programme attached to it.
      const told = held !== null && held.host !== null && answered;
      if (!told && !state.closed && !state.spareGui) hangUpConsole(live.proc);
    } finally {
      state.released = true;
      // (A hold that came after the teardown gave up waiting for it, too.)
      held?.release();
      state.held?.release();
    }
  }

  /** How long a grace may last: until `from + CLOSE_GRACE_MS`, and shortly before the deadline. */
  private graceEnds(state: ConptyState, from: number): number {
    return Math.min(from + CLOSE_GRACE_MS, state.deadline.ms - END_MARGIN_MS);
  }

  /** After the console's close: until everything attached to it has gone, with its host. */
  private async closeGrace(state: ConptyState, held: ConptyConsole | null): Promise<void> {
    while (!state.killing && Date.now() < this.graceEnds(state, state.closedAtMs)) {
      const alive = held ? await held.alive() : null;
      if (alive ? !alive.root && !alive.host : state.exitedAtMs !== undefined) return;
      await sleep(50);
    }
  }

  /** Output closed while the root may still run: until it exits on its own. */
  private async rootGrace(state: ConptyState): Promise<void> {
    const from = Date.now();
    while (!state.killing && state.exitedAtMs === undefined) {
      const left = this.graceEnds(state, from) - Date.now();
      if (left <= 0) return;
      await Promise.race([state.rootExited.promise, sleep(Math.min(left, 50))]);
    }
  }

  /**
   * Ends the root by its pid, only while node-pty has not seen it exit,
   * once the event loop has polled (endRootByPid): until then its pid is
   * its own (the helper holds it, or else node-pty does, but for a moment
   * as its thread closes its handle and calls back).
   */
  private endRoot(live: Live): Promise<boolean> {
    const state = live.conpty!;
    return endRootByPid(live.proc.pid, () => state.exitedAtMs !== undefined);
  }

  private exited(live: Live, exitCode: number | undefined): void {
    // A lifecycle rebind may be freezing the old segment when the process
    // exits. Flush every held byte against whichever placement currently
    // owns the runtime before closing its log/screen.
    const held = live.quiesced;
    live.quiesced = null;
    for (const raw of held ?? []) this.handleData(live, raw);
    const currentStream = live.stream;
    const currentTerm = live.term;
    if (live.record) this.logs.close(currentStream, currentTerm);
    this.live.delete(this.key(currentStream, currentTerm));
    this.recordRoots();
    this.emit('exit', {
      stream: currentStream,
      term: currentTerm,
      // ConPTY reports the exit when its output pipe closes, which can come
      // before the native exit code is known.
      exitCode: exitCode ?? -1,
    } satisfies PtyExitEvent);
    void this.screens.release(currentStream, currentTerm);
  }

  /**
   * The first ConPTY output: node-pty has started running queued calls. Apply
   * the newest size once its listener has returned, so a failure stays ours.
   */
  private conptyReady(live: Live): void {
    const state = live.conpty!;
    state.ready = true;
    setImmediate(() => {
      if (!this.callable(live) || this.live.get(this.key(live.stream, live.term)) !== live) return;
      const size = this.sizes.get(this.key(live.stream, live.term));
      if (size) this.resizeConpty(live, size.cols, size.rows);
    });
  }

  /** Size a ready ConPTY, unless it already has that size (see ConptyState). */
  private resizeConpty(live: Live, cols: number, rows: number): void {
    const state = live.conpty!;
    if (state.size.cols === cols && state.size.rows === rows) return;
    try {
      live.proc.resize(cols, rows);
      state.size = { cols, rows };
    } catch {
      // The process exited in between.
    }
  }

  /**
   * Whether calls on this PTY run now rather than in node-pty's deferred
   * queue, on a console that is neither closed nor torn down.
   */
  private callable(live: Live): boolean {
    const state = live.conpty;
    return state === null || (state.ready && !state.closed && !state.settling);
  }

  notificationOutput(stream: string): Promise<string> {
    return this.screens.textTail(stream, 'agent');
  }

  private handleData(live: Live, raw: string): void {
    const { stream, term, record, filter, proc } = live;
    const { data, deltas } = filter.push(raw);
    for (const delta of deltas) {
      if (delta.op === 'cwd') {
        this.emit('cwd', { stream, term, cwd: delta.path } satisfies PtyCwdEvent);
      } else {
        this.emit('env-delta', { stream, term, delta } satisfies PtyEnvDeltaEvent);
      }
    }
    if (data === '') return; // chunk fully swallowed by the side-channel
    // Answer dynamic-colour queries the moment they appear in the output —
    // passive detection, the bytes still flow to logs and viewers untouched.
    if (this.theme) {
      for (const code of findColourQueries(live.queryTail, data)) {
        const report = this.theme.report(code);
        if (report !== null) proc.write(report);
      }
      live.queryTail = data.slice(-QUERY_CARRY);
    }
    if (record) this.logs.append(stream, term, data);
    this.screens.write(stream, term, data);
    this.emit('data', { stream, term, data } satisfies PtyDataEvent);
  }

  /**
   * Freeze every terminal segment under `source`, then make the same runtime
   * continue under `target`. Processes, descriptors, environment, and PTY
   * sizes are retained; only the durable placement address changes.
   */
  async rebindStream(source: string, target: string): Promise<string[]> {
    if (source === target) return this.liveTerms(source);
    const entries = [...this.live.values()].filter((live) => live.stream === source);
    for (const live of entries) {
      if (this.has(target, live.term)) throw new Error(`pty ${target} ${live.term} already live`);
      live.quiesced = [];
    }
    const sidecars = this.sidecars.get(source);
    if (sidecars) {
      this.sidecars.delete(source);
      this.sidecars.set(target, sidecars);
    }
    for (const live of entries) {
      const sourceKey = this.key(source, live.term);
      const targetKey = this.key(target, live.term);
      if (live.record) this.logs.close(source, live.term);
      this.live.delete(sourceKey);
      const size = this.sizes.get(sourceKey) ?? DEFAULT_SIZE;
      this.sizes.set(targetKey, size);
      this.screens.resize(target, live.term, size.cols, size.rows);
      live.stream = target;
      this.live.set(targetKey, live);
      // State cleanup is best-effort and must not leave a moved process under
      // two session identities if its persisted screen cannot be released.
      await this.screens.release(source, live.term).catch(() => undefined);
      // The process may have exited during the await; its exit callback has
      // already flushed held output and removed the target key in that case.
      if (this.live.get(targetKey) !== live) continue;
      const held = live.quiesced;
      live.quiesced = null;
      for (const raw of held ?? []) this.handleData(live, raw);
    }
    return entries.map((live) => live.term);
  }

  /** Make a full-screen TUI repaint after a lifecycle stream switch. */
  redraw(stream: string, term: string): void {
    const key = this.key(stream, term);
    const live = this.live.get(key);
    // A ConPTY that has not drawn yet needs no repaint, and a queued resize
    // would run where its failure cannot be caught.
    if (!live || !this.callable(live)) return;
    const size = this.sizes.get(key) ?? DEFAULT_SIZE;
    try {
      live.proc.resize(size.cols + 1, size.rows);
      live.proc.resize(size.cols, size.rows);
      if (live.conpty) live.conpty.size = { cols: size.cols, rows: size.rows };
    } catch {
      // The process may exit between the two resize calls.
    }
  }

  write(stream: string, term: string, data: string, source: 'human' | 'script' = 'human'): void {
    if (source === 'human' && data) this.emit('input', { stream, term });
    this.live.get(this.key(stream, term))?.proc.write(data);
  }

  /**
   * Size a PTY, remembering the size for whatever PTY takes this (stream, term)
   * next — a resize that arrives while nothing is live (a viewer attached to an
   * exited session) is therefore not lost, it just applies to the resume.
   */
  resize(stream: string, term: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sizes.set(this.key(stream, term), { cols, rows });
    this.screens.resize(stream, term, cols, rows);
    const live = this.live.get(this.key(stream, term));
    // A ConPTY not yet ready picks the remembered size up in conptyReady.
    if (!live || !this.callable(live)) return;
    if (live.conpty) {
      this.resizeConpty(live, cols, rows);
      return;
    }
    try {
      live.proc.resize(cols, rows);
    } catch {
      // Resizing a PTY that exited between lookup and call is harmless.
    }
  }

  /**
   * Drop the remembered sizes for a stream — its session is gone for good, so no
   * later PTY can want them (an archive is NOT gone: it resumes at its size).
   */
  forget(stream: string): void {
    const prefix = `${stream} `;
    for (const key of [...this.sizes.keys()]) if (key.startsWith(prefix)) this.sizes.delete(key);
    void this.screens.forget(stream);
    this.sidecars.delete(stream);
  }

  /**
   * A self-contained terminal snapshot for viewer attachment. Older terminals
   * have only a raw log, so import that once as a compatibility seed; all new
   * output is parsed continuously and persisted by TerminalScreenStateStore.
   */
  async snapshot(stream: string, term: string, cols: number, rows: number): Promise<string> {
    // Reflow the saved screen to the attaching viewer before serialising it.
    // The real PTY is resized only after replay, so its resulting redraw is
    // unambiguously live output after the snapshot boundary.
    this.screens.resize(stream, term, cols, rows);
    try {
      let snapshot = await this.screens.snapshot(stream, term);
      if (snapshot !== null) return snapshot;
      const legacyTail = this.logs.readTail(stream, term);
      if (legacyTail === '') return '';
      this.screens.write(stream, term, legacyTail);
      snapshot = await this.screens.snapshot(stream, term);
      return snapshot ?? '';
    } finally {
      if (!this.has(stream, term)) void this.screens.release(stream, term);
    }
  }

  async closeTerminalStates(): Promise<void> {
    await this.screens.closeAll();
  }

  kill(stream: string, term: string, signal?: string): boolean {
    const rec = this.live.get(this.key(stream, term));
    if (!rec) return false;
    this.stop(rec, signal);
    return true;
  }

  killAll(stream?: string, signal?: string): void {
    for (const [key, rec] of this.live) {
      if (stream === undefined || key.startsWith(`${stream} `)) this.stop(rec, signal);
    }
  }

  /**
   * POSIX delivers `signal` (node-pty's default is SIGHUP). ConPTY has no
   * signals, and node-pty throws for any. Every signal but SIGKILL has the
   * helper hold what is attached to the console, then closes the
   * pseudoconsole, which sends them CTRL_CLOSE_EVENT and ends them once
   * their handlers return, the counterpart of a hang-up; what is left after
   * the grace (CLOSE_GRACE_MS, ending shortly before STOP_BOUND_MS) is
   * ended. When a GUI programme is attached to the console, which its close
   * would end, the console stays open and what else is attached is ended at
   * once. SIGKILL closes the pseudoconsole and ends the root at once, then
   * what is attached, and brings the deadline forward, also for a stop
   * already under way. Either way the exit is reported once what was
   * attached is ended too, or at the deadline.
   */
  private stop(rec: Live, signal: string | undefined): void {
    const state = rec.conpty;
    if (state === null) {
      rec.proc.kill(signal);
      return;
    }
    const kill = signal === 'SIGKILL';
    state.deadline.within(kill ? KILL_BOUND_MS : STOP_BOUND_MS);
    if (state.reported) return;
    if (kill) {
      if (!state.killing) {
        state.killing = true;
        this.killConpty(rec, state);
      }
      return;
    }
    // Once the teardown runs, the console is never closed under it.
    if (state.closing || state.settling) return;
    state.closing = true;
    void this.closeConptyGracefully(rec, state);
  }

  /**
   * A stop: what is attached is held, then the console closes, then its
   * grace (see stop). A GUI programme attached to it would end with its
   * close: the console is left open then, and the teardown ends the rest.
   */
  private async closeConptyGracefully(rec: Live, state: ConptyState): Promise<void> {
    const held = await this.heldConsole(state, SNAPSHOT_BOUND_MS);
    if (held && !state.settling && !state.killing) {
      // Held open now, what outstays the close's grace is ended by identity.
      // The helper attaches to the console no later than ATTACH_MARGIN_MS
      // before this stops waiting, so that it has let go of it by the close
      // below, however late it takes the request up.
      state.scanning = true;
      const attachByMs = Date.now() + SNAPSHOT_BOUND_MS - ATTACH_MARGIN_MS;
      const scan = await within(held.scan({ attach: true, attachByMs }), SNAPSHOT_BOUND_MS, null);
      state.scanning = false;
      if (scan && guiAttached(scan, { pid: rec.proc.pid, console: held })) state.spareGui = true;
    }
    // The root exited meanwhile: its teardown runs instead.
    if (state.settling) return;
    if (!state.spareGui) this.closeConsole(rec, state);
    this.settleConpty(rec);
  }

  /**
   * SIGKILL (see stop). The root goes first, by its pid, unless node-pty
   * has seen it exit once the event loop has polled (endRootByPid). The
   * console is closed too unless the helper may be attached to it, or a
   * stop found a GUI programme attached to it, so Windows ends what is
   * attached as the teardown does.
   */
  private killConpty(rec: Live, state: ConptyState): void {
    if (!state.settling && !state.scanning && !state.spareGui) this.closeConsole(rec, state);
    void this.endRoot(rec);
  }

  private closeConsole(rec: Live, state: ConptyState): void {
    if (state.closed || state.exitedAtMs !== undefined) return;
    state.closed = true;
    state.closedAtMs = Date.now();
    try {
      rec.proc.kill();
    } catch {
      // Already torn down by node-pty.
    }
  }

  has(stream: string, term: string): boolean {
    return this.live.has(this.key(stream, term));
  }

  /** Exact PTY root, excluding other shell tabs and lifecycle sidecars. */
  pidFor(stream: string, term: string): number | null {
    return this.live.get(this.key(stream, term))?.proc.pid ?? null;
  }

  liveCount(): number {
    return this.live.size;
  }

  liveTerms(stream: string): string[] {
    const prefix = `${stream} `;
    return [...this.live.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  /** OS pids of every live PTY on a stream (agent + shell-N terms). */
  pidsFor(stream: string): number[] {
    const prefix = `${stream} `;
    return [
      ...[...this.live.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, rec]) => rec.proc.pid),
      ...(this.sidecars.get(stream)?.pids ?? []),
    ];
  }

  registerSidecars(stream: string, pids: number[], hiddenPorts: number[]): void {
    this.sidecars.set(stream, {
      pids: new Set(pids),
      hiddenPorts: new Set(hiddenPorts),
    });
  }

  unregisterSidecars(stream: string): void {
    this.sidecars.delete(stream);
  }

  hiddenPortsFor(stream: string): ReadonlySet<number> {
    return this.sidecars.get(stream)?.hiddenPorts ?? new Set();
  }

  /**
   * Daemon-injected terminal line (e.g. "skip-permissions not permitted"):
   * recorded in the log and broadcast like PTY output, without touching stdin.
   */
  note(stream: string, term: string, text: string): void {
    const data = `\r\n[puddle] ${text}\r\n`;
    this.logs.append(stream, term, data);
    this.screens.write(stream, term, data);
    this.emit('data', { stream, term, data } satisfies PtyDataEvent);
  }

  private key(stream: string, term: string): string {
    return `${stream} ${term}`;
  }
}

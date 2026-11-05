import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import { killProcessTree, type WindowsProcess } from '@puddle/shared/node/platform';
import type { LogStore } from '../logs/log-store.js';
import { sharedConptyJobs, type ConptyJob, type ConptyJobs } from './conpty-jobs.js';
import {
  conptyTeardownDeps,
  ExitDeadline,
  reapConptyTree,
  snapshotConptyTree,
} from './conpty-teardown.js';
import { EnvOscFilter, type EnvDelta } from './env-osc.js';
import { conptyRootBounds, writePtyRoots } from './pty-roots.js';
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
 * pseudoconsole is closed at most once: a second `kill()` reaches a closed
 * native handle.
 *
 * `size` is the pseudoconsole's current size. ResizePseudoConsole repaints the
 * whole screen even when the size is unchanged, which would duplicate a
 * viewer's just-replayed snapshot as live output, so an unchanged size is
 * never re-applied.
 *
 * `startedAtMs` and `spawnedAtMs` bracket `pty.spawn`, which creates the
 * root and the console host: with them the process table tells this PTY's
 * root, its orphans and its host apart from other processes, and the job
 * host its root (conpty-teardown.ts, conpty-jobs.ts). `job` is the PTY's
 * kill-on-close job. `closing` is set once a stop has begun to close the
 * pseudoconsole, `killing` once a SIGKILL has, and `members` is the tree
 * read just before (at `membersAtMs`). `deadline` is when the exit is
 * reported at the latest, whatever the process table does.
 */
interface ConptyState {
  ready: boolean;
  closed: boolean;
  exited: boolean;
  size: { cols: number; rows: number };
  startedAtMs: number;
  spawnedAtMs: number;
  job: Promise<ConptyJob | null>;
  /** `job` once it has settled; undefined until then. */
  assigned: ConptyJob | null | undefined;
  closing: boolean;
  killing: boolean;
  members: WindowsProcess[];
  membersAtMs: number | undefined;
  deadline: ExitDeadline;
}

/**
 * Bounds on reporting a ConPTY's exit, the stopping going on after it: from
 * the first stop request, from a SIGKILL, and from the root's own exit when
 * nobody asked. SessionService.kill sends SIGKILL 4 s after its stop and
 * gives up 2 s later, so a stop answers within that even when the process
 * table is slow or wedged (a query may take its whole 8 s): by then the
 * PTY's job has ended, and only the table's own pass may still be running.
 */
const STOP_BOUND_MS = 4500;
const KILL_BOUND_MS = 250;
const CONPTY_TEARDOWN_MS = 5000;

/** A root still running has its grace until this long before the deadline, for its job's end. */
const JOB_END_MARGIN_MS = 300;

/** Bound on ending a job once the deadline has come (the host answers in milliseconds). */
const JOB_END_BOUND_MS = 750;

/** Bound on reading a ConPTY's tree before a kill closes its console (a cold table takes ~0.5 s). */
const SNAPSHOT_BOUND_MS = 1500;

/** Bound on the daemon's start waiting for its job host (it starts in ~0.5 s). */
const JOBS_READY_BOUND_MS = 5000;

const windows = process.platform === 'win32';

/** Between this process's clock and the creation times Windows records (measured within 10 ms). */
const CLOCK_SLACK_MS = 100;

/** Resolves once `work` settles or `ms` passes, whichever is first; never rejects. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

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
     * Windows: `rootsFile` is where to record the live ConPTY roots for the
     * resident supervisor (pty-roots.ts; the daemon passes
     * `<home>\pty-roots.json`), and `jobs` the job host (conpty-jobs.ts),
     * this process's shared one by default; null runs without one.
     */
    conpty: { rootsFile?: string; jobs?: ConptyJobs | null } = {},
  ) {
    super();
    this.screens = new TerminalScreenStateStore(stateDir, onScreenHealth);
    this.rootsFile = conpty.rootsFile;
    this.jobs = windows ? (conpty.jobs === undefined ? sharedConptyJobs() : conpty.jobs) : null;
    // Started now, so that the first PTY's root is not kept waiting for its job.
    void this.jobs?.ready();
    this.recordRoots();
  }

  private readonly rootsFile: string | undefined;
  private readonly jobs: ConptyJobs | null;
  /** Windows: the process-table passes still stopping what exited PTYs left. */
  private readonly teardowns = new Set<Promise<unknown>>();

  /**
   * Windows: resolves once the job host can take this process's PTYs, or
   * cannot start, within a bound. A root assigned to its job before it
   * starts anything leaves nothing outside it.
   */
  async prepare(): Promise<void> {
    if (this.jobs) await within(this.jobs.ready(), JOBS_READY_BOUND_MS);
  }

  /**
   * Windows: waits, up to `ms`, for every process-table pass still stopping
   * what exited PTYs left (their exits were reported at their deadlines).
   */
  async settled(ms: number): Promise<void> {
    if (this.teardowns.size > 0) await within(Promise.allSettled([...this.teardowns]), ms);
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined);
    this.teardowns.add(tracked);
    void tracked.finally(() => this.teardowns.delete(tracked));
  }

  /** Replaces the supervisor's record of this process's live ConPTY roots. */
  private recordRoots(): void {
    if (!windows || this.rootsFile === undefined) return;
    writePtyRoots(
      this.rootsFile,
      process.pid,
      [...this.live.values()].map((live) => ({
        pid: live.proc.pid,
        startedAtMs: live.conpty!.startedAtMs,
        spawnedAtMs: live.conpty!.spawnedAtMs,
      })),
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
            exited: false,
            size,
            startedAtMs,
            spawnedAtMs,
            job: Promise.resolve(null),
            assigned: undefined,
            closing: false,
            killing: false,
            members: [],
            membersAtMs: undefined,
            deadline: new ExitDeadline(),
          }
        : null,
    };
    if (live.conpty) {
      const state = live.conpty;
      state.job = this.assignJob(proc.pid, startedAtMs, spawnedAtMs).then((job) => {
        state.assigned = job;
        return job;
      });
    }
    this.live.set(key, live);
    this.recordRoots();
    proc.onData((raw) => {
      if (live.conpty && !live.conpty.ready) this.conptyReady(live);
      if (live.quiesced !== null) {
        live.quiesced.push(raw);
        return;
      }
      this.handleData(live, raw);
    });
    proc.onExit(({ exitCode }) => {
      if (live.conpty) {
        live.conpty.exited = true;
        live.conpty.deadline.within(CONPTY_TEARDOWN_MS);
        // Windows has no hang-up: the PTY stays live, and its exit
        // unreported, until what its root left running is stopped, so a
        // session's kill and the daemon's shutdown wait for that too.
        void this.reapConpty(live, exitCode).then(() => this.exited(live, exitCode));
        return;
      }
      this.exited(live, exitCode);
    });
  }

  /** The PTY's job, waiting for its assignment no later than the deadline. */
  private jobOf(state: ConptyState): Promise<ConptyJob | null> {
    return state.assigned !== undefined
      ? Promise.resolve(state.assigned)
      : state.deadline.race(state.job, null);
  }

  /** The root's kill-on-close job (conpty-jobs.ts); null when it has none. */
  private assignJob(pid: number, startedAtMs: number, spawnedAtMs: number) {
    if (!this.jobs) return Promise.resolve(null);
    const bounds = conptyRootBounds({ startedAtMs, spawnedAtMs });
    return this.jobs.assign(pid, {
      fromMs: bounds.startedAtMs - CLOCK_SLACK_MS,
      toMs: bounds.createdBeforeMs + CLOCK_SLACK_MS,
    });
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
   * Stops what a ConPTY root left running and its console host
   * (conpty-teardown.ts), by the PTY's deadline: should the deadline come
   * first, the job is ended if it was not yet and the exit reported, while
   * the process table's pass goes on (`settled`). Never rejects. When the
   * table cannot be read that pass stops nothing: the root's pid may name
   * another process by now, so `taskkill /T` on it is no fallback.
   */
  private async reapConpty(live: Live, exitCode: number | undefined): Promise<void> {
    const state = live.conpty!;
    const job = await this.jobOf(state);
    const reaped = reapConptyTree(
      {
        pid: live.proc.pid,
        startedAtMs: state.startedAtMs,
        spawnedAtMs: state.spawnedAtMs,
        exited: exitCode !== undefined,
      },
      conptyTeardownDeps,
      {
        known: state.members,
        knownAtMs: state.membersAtMs,
        job,
        graceEndsBy: () => state.deadline.ms - JOB_END_MARGIN_MS,
      },
    ).then(
      () => true,
      () => true,
    );
    this.track(reaped);
    if (!(await state.deadline.race(reaped, false)) && job) {
      await within(job.end(), JOB_END_BOUND_MS);
    }
  }

  /**
   * The first ConPTY output: node-pty has started running queued calls. Apply
   * the newest size once its listener has returned, so a failure stays ours.
   */
  private conptyReady(live: Live): void {
    const state = live.conpty!;
    state.ready = true;
    setImmediate(() => {
      if (state.exited || this.live.get(this.key(live.stream, live.term)) !== live) return;
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

  /** Whether calls on this PTY run now rather than in node-pty's deferred queue. */
  private callable(live: Live): boolean {
    return live.conpty === null || (live.conpty.ready && !live.conpty.exited);
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
   * signals, and node-pty throws for any. Every signal but SIGKILL reads the
   * process table's tree, then closes the pseudoconsole, which sends
   * CTRL_CLOSE_EVENT to its processes and then terminates them, the
   * counterpart of a hang-up; a root that outlives that has until shortly
   * before STOP_BOUND_MS. SIGKILL closes the pseudoconsole and ends the
   * PTY's job at once (without a job, it stops the table's tree first), and
   * brings the deadline forward, also for a stop already under way. Either
   * way the exit is reported once whatever is left is stopped too, or at the
   * deadline.
   */
  private stop(rec: Live, signal: string | undefined): void {
    const state = rec.conpty;
    if (state === null) {
      rec.proc.kill(signal);
      return;
    }
    const kill = signal === 'SIGKILL';
    state.deadline.within(kill ? KILL_BOUND_MS : STOP_BOUND_MS);
    // Once the root has exited its pid may name another process; the
    // teardown of what it left is already running, by the deadline.
    if (state.exited) return;
    if (kill) {
      if (!state.killing) {
        state.killing = true;
        void this.killConpty(rec, state);
      }
      return;
    }
    if (state.closed || state.closing) return;
    state.closing = true;
    const snapshot = snapshotConptyTree(
      { pid: rec.proc.pid, startedAtMs: state.startedAtMs, spawnedAtMs: state.spawnedAtMs },
      conptyTeardownDeps,
    ).then((members) => {
      state.members = members;
      state.membersAtMs = Date.now();
    });
    // A slow table must not hold the console open: the root is what counts.
    void within(snapshot, SNAPSHOT_BOUND_MS).then(() => this.closeConsole(rec, state));
  }

  /** SIGKILL on a ConPTY whose root runs (see stop). */
  private async killConpty(rec: Live, state: ConptyState): Promise<void> {
    const job = await this.jobOf(state);
    if (job) {
      this.closeConsole(rec, state);
      await job.end();
      return;
    }
    const killed = killProcessTree(rec.proc.pid, {
      platform: 'win32',
      processes: conptyTeardownDeps.processes,
      root: conptyRootBounds(state),
    });
    this.track(killed);
    // A slow table must not hold the console open past the deadline.
    await state.deadline.race(
      killed.catch(() => undefined),
      undefined,
    );
    this.closeConsole(rec, state);
  }

  private closeConsole(rec: Live, state: ConptyState): void {
    if (state.closed || state.exited) return;
    state.closed = true;
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

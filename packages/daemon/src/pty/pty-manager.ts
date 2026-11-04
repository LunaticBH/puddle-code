import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import { killProcessTree } from '@puddle/shared/node/platform';
import type { LogStore } from '../logs/log-store.js';
import { EnvOscFilter, type EnvDelta } from './env-osc.js';
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
 */
interface ConptyState {
  ready: boolean;
  closed: boolean;
  exited: boolean;
  size: { cols: number; rows: number };
}

const windows = process.platform === 'win32';

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
  ) {
    super();
    this.screens = new TerminalScreenStateStore(stateDir, onScreenHealth);
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
    const proc = pty.spawn(plan.file, plan.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: opts.cwd,
      env: plan.env,
    });
    const filter = new EnvOscFilter();
    const live: Live = {
      proc,
      record,
      filter,
      stream,
      term,
      quiesced: null,
      queryTail: '',
      conpty: windows ? { ready: false, closed: false, exited: false, size } : null,
    };
    this.live.set(key, live);
    proc.onData((raw) => {
      if (live.conpty && !live.conpty.ready) this.conptyReady(live);
      if (live.quiesced !== null) {
        live.quiesced.push(raw);
        return;
      }
      this.handleData(live, raw);
    });
    proc.onExit(({ exitCode }) => {
      if (live.conpty) live.conpty.exited = true;
      // A lifecycle rebind may be freezing the old segment when the process
      // exits. Flush every held byte against whichever placement currently
      // owns the runtime before closing its log/screen.
      const held = live.quiesced;
      live.quiesced = null;
      for (const raw of held ?? []) this.handleData(live, raw);
      const currentStream = live.stream;
      const currentTerm = live.term;
      if (record) this.logs.close(currentStream, currentTerm);
      this.live.delete(this.key(currentStream, currentTerm));
      this.emit('exit', {
        stream: currentStream,
        term: currentTerm,
        // ConPTY reports the exit when its output pipe closes, which can come
        // before the native exit code is known.
        exitCode: exitCode ?? -1,
      } satisfies PtyExitEvent);
      void this.screens.release(currentStream, currentTerm);
    });
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
   * signals, and node-pty throws for any: SIGKILL stops the process tree with
   * `taskkill /T /F` and then closes the pseudoconsole; every other signal
   * just closes it, which sends CTRL_CLOSE_EVENT to its processes and then
   * terminates them, the counterpart of a hang-up.
   */
  private stop(rec: Live, signal: string | undefined): void {
    const state = rec.conpty;
    if (state === null) {
      rec.proc.kill(signal);
      return;
    }
    if (signal === 'SIGKILL') {
      void killProcessTree(rec.proc.pid, { platform: 'win32' })
        .catch(() => undefined)
        .then(() => this.closeConsole(rec, state));
      return;
    }
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

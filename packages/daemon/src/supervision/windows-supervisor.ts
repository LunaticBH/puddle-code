import type { Server, Socket } from 'node:net';
import { supervisorRequestSchema, type SupervisorResponse } from '@puddle/shared';
import { jsonLines } from '@puddle/shared/node';
import {
  DAEMON_ALREADY_ACTIVE_EXIT,
  type ControlPipeState,
  type ShutdownOutcome,
  type SupervisorAnswer,
} from '@puddle/shared/node/platform';

/**
 * The resident Windows supervisor (docs/windows.md, decision 6): what
 * systemd's units do on Linux. It runs the daemon and, while remote access
 * is supervised, the connector as its children, restarting either after an
 * abnormal exit with backoff (1 s doubling to 60 s), and gives up after ten
 * failures in ten minutes. A daemon that exits 0 was asked to stop, so the
 * supervisor stops the connector and exits 0. One that found its control
 * pipe served exits DAEMON_ALREADY_ACTIVE_EXIT, and a restart that finds
 * the pipe served starts none: another daemon serves the home, so the
 * supervisor stops the connector and exits 0 too, never lingering beside a
 * daemon it does not run (a launch would take it for the one starting its
 * daemon). Once that daemon exits, the next launch starts the task again.
 * Whenever its daemon exits, the supervisor stops whatever that daemon left
 * running before it restarts one or exits itself, as systemd stops a unit's
 * control group. The supervisor's own private pipe makes it single-instance
 * per home and takes `status`, `reconcile`, `restart_connector` and
 * `shutdown`.
 */

/** A supervised process: the daemon or the connector. */
export interface SupervisedChild {
  readonly pid: number;
  /** The clock just before it was started. */
  readonly startedAtMs?: number;
  /** The exit status; null for a process ended by a signal or that could not run. */
  readonly exited: Promise<number | null>;
  /** Ask the process to stop (the connector closes when its IPC channel does). */
  stop(): void;
  /**
   * Terminate it: the daemon alone (its exit's reap then ends what it left,
   * by the rule its PTYs' teardown follows), the connector with its
   * descendants.
   */
  kill(): Promise<void>;
}

export interface SupervisorDeps {
  pid: number;
  log(line: string): void;
  /** Serve the control pipe; rejects with "already active" while another server holds it. */
  listen(onConnection: (socket: Socket) => void): Promise<Server>;
  /** Who answers on the control pipe that `listen` found served. */
  holder(): Promise<SupervisorAnswer['kind']>;
  spawnDaemon(): SupervisedChild;
  spawnConnector(): SupervisedChild;
  /** Remote access is supervised and the installed release ships the connector. */
  connectorWanted(): boolean;
  /** Who holds the daemon's control pipe. */
  hostPipe(): Promise<ControlPipeState>;
  requestDaemonShutdown(): Promise<ShutdownOutcome>;
  /**
   * Stop whatever an exited daemon left running, resolving with how many
   * processes that was. Windows ends no process's descendants with it: a
   * daemon that crashed or was terminated leaves its agents, shells and
   * their children (systemd stops a unit's whole control group instead).
   */
  reapDaemon?(daemon: SupervisedChild, exitedAtMs: number): Promise<number>;
  /** Who holds the connector manager's lock pipe. */
  connectorManager(): Promise<'absent' | 'proven' | 'foreign' | 'unknown'>;
  writePid(pid: number | null): void;
  proof(challenge: string): string;
  now(): number;
  /** Shorter delays for tests. */
  timing?: Partial<SupervisorTiming>;
}

export interface SupervisorTiming {
  failureWindowMs: number;
  firstBackoffMs: number;
  maxBackoffMs: number;
  /** How long a stopping daemon may take to close its database. */
  daemonStopGraceMs: number;
  connectorStopGraceMs: number;
  /** How often to look again while another connector holds this home's lock. */
  connectorRecheckMs: number;
}

const TIMING: SupervisorTiming = {
  failureWindowMs: 10 * 60_000,
  firstBackoffMs: 1000,
  maxBackoffMs: 60_000,
  daemonStopGraceMs: 20_000,
  connectorStopGraceMs: 10_000,
  connectorRecheckMs: 30_000,
};
const FAILURE_LIMIT = 10;

/** Failures in the last ten minutes decide both the backoff and giving up. */
class Restarts {
  private failures: number[] = [];
  constructor(
    private readonly now: () => number,
    private readonly timing: SupervisorTiming,
  ) {}
  /** Records a failure: the delay before the next start, or null to give up. */
  fail(): number | null {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < this.timing.failureWindowMs);
    this.failures.push(now);
    if (this.failures.length >= FAILURE_LIMIT) return null;
    return Math.min(
      this.timing.maxBackoffMs,
      this.timing.firstBackoffMs * 2 ** (this.failures.length - 1),
    );
  }
  reset(): void {
    this.failures = [];
  }
}

const settleWithin = <T>(promise: Promise<T>, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });

export class WindowsSupervisor {
  private server: Server | undefined;
  private stopping = false;
  private finished = false;
  private resolveDone!: (code: number) => void;
  private readonly done = new Promise<number>((resolve) => (this.resolveDone = resolve));
  private readonly daemon = {
    child: undefined as SupervisedChild | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    restarts: undefined as unknown as Restarts,
    /** Stopping what the last daemon left running; settles, never rejects. */
    reaped: Promise.resolve(),
  };
  private readonly connector = {
    child: undefined as SupervisedChild | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    restarts: undefined as unknown as Restarts,
    stopping: new Set<SupervisedChild>(),
    gaveUp: false,
    starting: false,
    deferred: false,
  };

  private readonly timing: SupervisorTiming;

  constructor(private readonly deps: SupervisorDeps) {
    this.timing = { ...TIMING, ...deps.timing };
    this.daemon.restarts = new Restarts(deps.now, this.timing);
    this.connector.restarts = new Restarts(deps.now, this.timing);
  }

  /** Resolves with the supervisor's exit status. */
  async run(): Promise<number> {
    try {
      this.server = await this.deps.listen((socket) => this.serve(socket));
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('already active')) throw err;
      const holder = await this.deps.holder();
      if (holder === 'answered') {
        this.deps.log('another supervisor already runs for this home');
        return 0;
      }
      if (holder === 'unavailable') {
        // No squatter: one that answered without the proof would be. A pipe
        // this process cannot open is typically an elevated supervisor's,
        // which WMI started from an administrator's SSH session; renaming
        // the pipes would only leave it running beside this one. An elevated
        // upgrade stops it, then starts this task again.
        this.deps.log(
          'another supervisor holds this home’s pipe, but this process cannot reach it: it may ' +
            'run elevated, started from an administrator’s session; leaving the home to it ' +
            '(to run it without elevation, run puddle upgrade daemon from an elevated session ' +
            'while logged on, or restart the machine)',
        );
        return 0;
      }
      this.deps.log(
        'the supervisor pipe is held by a process that cannot prove it reads this home — ' +
          'run puddle upgrade daemon to rename the home’s pipes',
      );
      return 1;
    }
    this.deps.log(`supervisor started (pid ${this.deps.pid})`);
    this.startDaemon();
    this.reconcileConnector();
    return this.done;
  }

  /** Stop the daemon and the connector, then exit with `code`. */
  shutdown(reason: string, code = 0): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.stopping = true;
    this.deps.log(reason);
    clearTimeout(this.daemon.timer);
    clearTimeout(this.connector.timer);
    const daemon = this.daemon.child;
    return Promise.all([daemon ? this.stopDaemon(daemon) : undefined, this.stopConnector()])
      .then(() => this.daemon.reaped)
      .then(() => this.finish(code));
  }

  private finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.log(`supervisor exits (${code})`);
    this.server?.close();
    this.resolveDone(code);
  }

  private state(challenge: string): SupervisorResponse {
    return {
      t: 'supervisor',
      proof: this.deps.proof(challenge),
      pid: this.deps.pid,
      daemon: this.daemon.child?.pid ?? null,
      connector: this.connector.child?.pid ?? null,
      stopping: this.stopping,
    };
  }

  /** One request per connection; a malformed one gets no answer. */
  private serve(socket: Socket): void {
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let used = false;
    const stop = jsonLines(
      socket,
      (value) => {
        if (used) return socket.destroy();
        used = true;
        const request = supervisorRequestSchema.safeParse(value);
        if (!request.success) return socket.destroy();
        const { t, challenge } = request.data;
        const answer = () => socket.end(JSON.stringify(this.state(challenge)) + '\n');
        if (t === 'shutdown') {
          void this.shutdown('shutdown requested over the supervisor pipe');
          return answer();
        }
        // Only `remote enable` asks: a fresh start for a connector given up on.
        if (t === 'reconcile') this.reconcileConnector(true);
        if (t === 'restart_connector') return void this.restartConnector().then(answer);
        answer();
      },
      () => socket.destroy(),
    );
    socket.on('close', stop);
  }

  private startDaemon(): void {
    if (this.stopping || this.daemon.child) return;
    let child: SupervisedChild;
    try {
      child = this.deps.spawnDaemon();
    } catch (err) {
      this.deps.log(`could not start puddled: ${(err as Error).message}`);
      return this.daemonFailed(null);
    }
    this.daemon.child = child;
    this.deps.writePid(child.pid);
    this.deps.log(`started puddled (pid ${child.pid})`);
    void child.exited.then((code) => this.daemonExited(child, code));
  }

  private daemonExited(child: SupervisedChild, code: number | null): void {
    if (this.daemon.child !== child) return;
    this.daemon.child = undefined;
    // Before anything else: a restart or the supervisor's own exit waits for it.
    this.daemon.reaped = this.reapDaemon(child);
    if (this.stopping) return;
    if (code === 0) {
      this.deps.writePid(null);
      void this.shutdown('puddled stopped');
      return;
    }
    if (code === DAEMON_ALREADY_ACTIVE_EXIT)
      return this.retireDaemon('another puddled serves this home');
    this.deps.log(`puddled (pid ${child.pid}) exited with status ${String(code)}`);
    this.daemonFailed(code);
  }

  private daemonFailed(code: number | null): void {
    const delay = this.daemon.restarts.fail();
    if (delay === null) {
      void this.shutdown(`puddled failed ${FAILURE_LIMIT} times in ten minutes — giving up`, 1);
      return;
    }
    this.deps.log(`restarting puddled in ${delay / 1000} s (last status ${String(code)})`);
    this.daemon.timer = setTimeout(() => {
      this.daemon.timer = undefined;
      // Never start one beside a daemon another launcher started meanwhile,
      // nor beside what the last one left running.
      void this.daemon.reaped
        .then(() => this.deps.hostPipe())
        .then((state) => {
          if (state === 'daemon' || state === 'unknown') {
            return this.retireDaemon('another puddled took over this home');
          }
          this.startDaemon();
        });
    }, delay);
  }

  /** Stops what `child` left running (SupervisorDeps.reapDaemon); never rejects. */
  private reapDaemon(child: SupervisedChild): Promise<void> {
    const reap = this.deps.reapDaemon;
    if (!reap) return Promise.resolve();
    const exitedAtMs = this.deps.now();
    return reap(child, exitedAtMs).then(
      (count) => {
        if (count > 0) {
          this.deps.log(
            `stopped ${count} process${count === 1 ? '' : 'es'} puddled (pid ${child.pid}) left running`,
          );
        }
      },
      (err: unknown) =>
        this.deps.log(
          `could not stop what puddled (pid ${child.pid}) left running: ${(err as Error).message}`,
        ),
    );
  }

  /** Never start a daemon beside the one that serves the home: leave the home to it. */
  private retireDaemon(reason: string): void {
    this.deps.writePid(null);
    void this.shutdown(`${reason}; leaving the home to it`);
  }

  private async stopDaemon(child: SupervisedChild): Promise<void> {
    const deadline = this.deps.now() + this.timing.daemonStopGraceMs;
    let gone = false;
    // A daemon still starting cannot answer yet: ask again until it can.
    while (!gone && this.deps.now() < deadline) {
      const outcome = await this.deps.requestDaemonShutdown();
      if (outcome === 'stopping') {
        gone = await settleWithin(child.exited, Math.max(0, deadline - this.deps.now()));
        break;
      }
      gone = await settleWithin(child.exited, 500);
    }
    if (!gone) {
      this.deps.log(`puddled (pid ${child.pid}) did not stop cleanly — terminating it`);
      await child.kill();
      await settleWithin(child.exited, 5000);
    }
    this.deps.writePid(null);
  }

  /**
   * Start or stop the connector as its supervision says. `requested`: remote
   * access was enabled again (a `reconcile` request), which ends a give-up,
   * as the give-up's log line says; restarts and backoff timers do not.
   */
  private reconcileConnector(requested = false): void {
    if (this.stopping) return;
    if (!this.deps.connectorWanted()) {
      this.connector.gaveUp = false;
      this.connector.restarts.reset();
      clearTimeout(this.connector.timer);
      this.connector.timer = undefined;
      void this.stopConnector();
      return;
    }
    if (requested && this.connector.gaveUp) {
      this.connector.gaveUp = false;
      this.connector.restarts.reset();
      this.deps.log('remote access was enabled again — starting the connector afresh');
    }
    if (this.connector.stopping.size > 0) {
      this.connector.deferred = true;
      return;
    }
    if (this.connector.child || this.connector.timer || this.connector.gaveUp) return;
    void this.startConnector();
  }

  private async startConnector(): Promise<void> {
    if (this.stopping || this.connector.child || this.connector.starting) return;
    this.connector.starting = true;
    try {
      // `puddle remote run` may already serve the home: never start a second manager.
      const holder = await this.deps.connectorManager();
      // A reconcile meanwhile may have ended supervision; it had no child to stop.
      if (this.stopping || this.connector.child || !this.deps.connectorWanted()) return;
      if (holder !== 'absent') {
        this.deps.log(
          holder === 'foreign'
            ? 'the connector lock pipe is held by a process that cannot prove it reads this home — ' +
                'run puddle upgrade daemon to rename the home’s pipes; looking again later'
            : 'another connector serves this home; looking again later',
        );
        this.connector.timer = setTimeout(() => {
          this.connector.timer = undefined;
          this.reconcileConnector();
        }, this.timing.connectorRecheckMs);
        return;
      }
      let child: SupervisedChild;
      try {
        child = this.deps.spawnConnector();
      } catch (err) {
        this.deps.log(`could not start the connector: ${(err as Error).message}`);
        return this.connectorFailed(null);
      }
      this.connector.child = child;
      this.deps.log(`started the connector (pid ${child.pid})`);
      void child.exited.then((code) => this.connectorExited(child, code));
    } finally {
      this.connector.starting = false;
    }
  }

  private connectorExited(child: SupervisedChild, code: number | null): void {
    if (this.connector.child === child) this.connector.child = undefined;
    if (this.connector.stopping.has(child) || this.stopping) return;
    // As systemd's Restart=on-failure: a clean exit is not restarted.
    if (code === 0) return this.deps.log('the connector stopped');
    this.deps.log(`the connector (pid ${child.pid}) exited with status ${String(code)}`);
    this.connectorFailed(code);
  }

  private connectorFailed(code: number | null): void {
    const delay = this.connector.restarts.fail();
    if (delay === null) {
      this.connector.gaveUp = true;
      this.deps.log(
        `the connector failed ${FAILURE_LIMIT} times in ten minutes — ` +
          'not restarting it until remote access is enabled again',
      );
      return;
    }
    this.deps.log(`restarting the connector in ${delay / 1000} s (last status ${String(code)})`);
    this.connector.timer = setTimeout(() => {
      this.connector.timer = undefined;
      this.reconcileConnector();
    }, delay);
  }

  private async stopConnector(): Promise<void> {
    clearTimeout(this.connector.timer);
    this.connector.timer = undefined;
    const child = this.connector.child;
    if (!child) {
      await Promise.all([...this.connector.stopping].map((each) => each.exited));
      return;
    }
    this.connector.child = undefined;
    this.connector.stopping.add(child);
    try {
      child.stop();
      if (!(await settleWithin(child.exited, this.timing.connectorStopGraceMs))) {
        this.deps.log(`the connector (pid ${child.pid}) did not stop — terminating it`);
        await child.kill();
        await settleWithin(child.exited, 5000);
      }
    } finally {
      this.connector.stopping.delete(child);
    }
    if (this.connector.deferred && this.connector.stopping.size === 0) {
      this.connector.deferred = false;
      this.reconcileConnector();
    }
  }

  /** A new release, or a fresh start after remote access was enabled again. */
  private async restartConnector(): Promise<void> {
    if (this.stopping) return;
    this.connector.restarts.reset();
    this.connector.gaveUp = false;
    await this.stopConnector();
    this.reconcileConnector();
  }
}

import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { puddlangRunnerMessageSchema, type PuddlangStart } from '@puddle/shared';
import { PuddlangStore } from './store.js';
import { PuddlangOperations, type PuddlangDeps } from './operations.js';
import { ApiError } from '../http/errors.js';

interface ActiveRun {
  child: ChildProcess;
  abort: AbortController;
  operations: PuddlangOperations;
  pending: Set<Promise<void>>;
  timer: ReturnType<typeof setTimeout>;
  logged: number;
  operationCount: number;
  finishing?: Promise<void>;
}

/** Programs run in child processes; only validated operations enter the daemon. */
export class PuddlangService {
  private readonly active = new Map<string, ActiveRun>();
  private closing = false;
  constructor(
    readonly store: PuddlangStore,
    private readonly deps: PuddlangDeps,
    private readonly runner = fileURLToPath(new URL('./runner.js', import.meta.url)),
  ) {
    store.reconcile();
  }

  context(profile: string) {
    const owner = this.deps.profiles.get(profile);
    return {
      profile: { id: owner.id, name: owner.name },
      projects: this.deps.projects
        .list(profile)
        .filter((p) => !p.archived)
        .map((p) => ({ id: p.id, name: p.name, path: this.deps.repos.get(p.repo_id).path })),
      accounts: this.deps.accounts
        .list(profile)
        .map((a) => ({ id: a.id, label: a.label, agent: a.agent_type, logged_in: a.logged_in })),
      agents: this.deps.adapters.list().map((a) => ({
        id: a.id,
        scripted_turns: a.scriptedTurns === true,
        modes: [
          ...(a.scriptedTurns ? ['interactive' as const] : []),
          ...(a.prepareHeadlessLaunch ? ['headless' as const] : []),
        ],
      })),
    };
  }

  start(profile: string, input: PuddlangStart) {
    if (this.closing) throw new Error('Daemon is shutting down');
    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    if (major! < 22 || (major === 22 && (minor! < 21 || (minor === 21 && patch! < 1))))
      throw ApiError.conflict(
        'node_version',
        'Puddlang requires Node 22.21.1 or newer on the host; upgrade the daemon runtime',
      );
    this.deps.profiles.get(profile);
    if (this.active.size >= 16 && !this.store.has(input.id))
      throw new Error('At most 16 puddlang runs may execute at once');
    const { run, fresh } = this.store.create(profile, input);
    if (!fresh) return run;
    const abort = new AbortController();
    const operations = new PuddlangOperations(this.deps, profile, input, abort.signal);
    let child: ChildProcess;
    try {
      // fork hands its options to spawn, which honours windowsHide although
      // ForkOptions does not declare it: the detached Windows daemon has no
      // console, so each run would otherwise flash one.
      const options: ForkOptions & { windowsHide: boolean } = {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: [],
        env: { ...process.env, PUDDLE_PROFILE_ID: profile },
        windowsHide: true,
      };
      child = fork(this.runner, [], options);
    } catch (error) {
      this.store.finish(run.id, 'failed', null, String(error));
      return this.store.get(profile, run.id);
    }
    const active: ActiveRun = {
      child,
      abort,
      operations,
      pending: new Set(),
      logged: 0,
      operationCount: 0,
      timer: setTimeout(() => {
        void this.cancel(profile, run.id, 'Run deadline exceeded');
      }, input.timeout_ms),
    };
    this.active.set(run.id, active);
    this.store.event(run.id, 'started', { profile });
    const log = (type: string, data: Buffer) => {
      if (!this.active.has(run.id) || active.logged >= 1024 * 1024) return;
      const text = data.toString('utf8').slice(0, Math.min(8192, 1024 * 1024 - active.logged));
      active.logged += text.length;
      this.store.event(run.id, type, text);
    };
    child.stdout?.on('data', (chunk: Buffer) => log('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => log('stderr', chunk));
    child.on('message', (raw: unknown) => {
      if (!this.active.has(run.id) || abort.signal.aborted) return;
      const parsed = puddlangRunnerMessageSchema.safeParse(raw);
      if (!parsed.success) {
        void this.cancel(profile, run.id, 'Invalid runner message');
        return;
      }
      const message = parsed.data;
      if (message.type === 'finished') {
        if (active.pending.size) {
          void this.cancel(profile, run.id, 'Program ended with unawaited operations');
          return;
        }
        if (Buffer.byteLength(JSON.stringify(message)) > 256 * 1024) {
          void this.cancel(profile, run.id, 'Program result exceeds 256 KiB');
          return;
        }
        this.store.finish(
          run.id,
          message.error ? 'failed' : 'completed',
          message.result,
          message.error ?? null,
        );
        this.store.event(run.id, 'finished', { error: message.error ?? null });
        this.release(run.id, active);
        return;
      }
      if (active.pending.size >= 64 || ++active.operationCount > 4096) {
        void this.cancel(profile, run.id, 'Run operation limit exceeded');
        return;
      }
      const task = operations
        .execute(message.operation)
        .then(
          (value) => {
            if (!abort.signal.aborted && child.connected)
              child.send({ type: 'reply', id: message.id, value }, () => {});
            if (!abort.signal.aborted)
              this.store.event(
                run.id,
                message.operation.op,
                message.operation.op === 'ask'
                  ? { runtime_id: message.operation.handle.runtime_id }
                  : value,
              );
          },
          (error: unknown) => {
            if (!abort.signal.aborted && child.connected)
              child.send(
                {
                  type: 'reply',
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                },
                () => {},
              );
          },
        )
        .finally(() => active.pending.delete(task));
      active.pending.add(task);
    });
    child.once('error', (error) => {
      void this.cancel(profile, run.id, error.message);
    });
    child.once('exit', () => {
      if (this.active.has(run.id))
        void this.cancel(profile, run.id, 'Runner exited without a result');
    });
    child.send({ type: 'start', source: input.source, input: input.input }, (error) => {
      if (error) void this.cancel(profile, run.id, error.message);
    });
    return run;
  }

  async cancel(profile: string, id: string, error?: string) {
    const run = this.store.get(profile, id);
    const active = this.active.get(id);
    if (active) await this.stop(id, active, error ? 'failed' : 'cancelled', error ?? 'Cancelled');
    return active ? this.store.get(profile, id) : run;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    for (const [id, active] of this.active) {
      await this.stop(id, active, 'interrupted', 'Daemon stopped; instructions were not replayed');
    }
  }

  private stop(
    id: string,
    active: ActiveRun,
    status: 'failed' | 'cancelled' | 'interrupted',
    error: string,
  ): Promise<void> {
    if (active.finishing) return active.finishing;
    active.abort.abort();
    const exited =
      active.child.exitCode !== null ||
      active.child.signalCode !== null ||
      active.child.pid === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            // A programme may have launched a server inheriting stdout. Its
            // open pipe must not prevent the runner itself from being reaped.
            active.child.once('exit', () => resolve());
          });
    active.child.kill('SIGKILL');
    active.finishing = (async () => {
      await Promise.allSettled([...active.pending]);
      if (status !== 'interrupted') await active.operations.stopOwned();
      await exited;
      this.store.finish(id, status, null, error);
      this.store.event(id, 'finished', { error });
      this.release(id, active);
    })();
    return active.finishing;
  }

  private release(id: string, active: ActiveRun): void {
    clearTimeout(active.timer);
    this.active.delete(id);
  }
}

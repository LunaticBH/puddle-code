import { StatusDetector } from '../pty/status-detector.js';
import type { AgentAdapter } from '../agents/adapter.js';
import {
  foregroundProcesses,
  readProcessSnapshot,
  type ProcessEntry,
} from '../pty/foreground-process.js';

export interface TerminalAgentTarget {
  session: string;
  runtime: string;
  pid: number;
}

interface Options {
  targets(): TerminalAgentTarget[];
  adapters: Pick<AgentAdapter, 'id' | 'matchesProcess' | 'statusPatterns'>[];
  changed(session: string): void;
  notify?(session: string, reason: 'waiting_input' | 'exited'): void;
  quietMs?: number;
  snapshot?: () => ReturnType<typeof readProcessSnapshot>;
  intervalMs?: number;
  /** How snapshots are read and interpreted; `process.platform` by default. */
  platform?: NodeJS.Platform;
}

interface ObservedAgent {
  runtime: string;
  agent: string;
  pid: number;
  /** The agent process's creation time where known (Windows), so a reused pid is an exit. */
  createdAtMs: number | null;
  detector: StatusDetector | null;
  armed: boolean;
}

/** Transient observations: never adopts conversations or changes session kind/status. */
export class TerminalAgentMonitor {
  private readonly detected = new Map<string, { runtime: string; agent: string }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly observed = new Map<string, ObservedAgent>();
  private pending = false;
  private disposed = false;

  constructor(private readonly options: Options) {
    this.timer = setInterval(() => void this.refresh(), options.intervalMs ?? 3000);
    this.timer.unref?.();
  }

  get(session: string, runtime: string): string | null {
    const value = this.detected.get(session);
    return value?.runtime === runtime ? value.agent : null;
  }

  feed(session: string, data: string): void {
    this.observed.get(session)?.detector?.feed(data);
  }

  exited(session: string): void {
    if (this.observed.has(session)) this.options.notify?.(session, 'exited');
    this.forget(session);
  }

  forget(session: string): void {
    this.observed.get(session)?.detector?.dispose();
    this.observed.delete(session);
    if (this.detected.delete(session)) this.options.changed(session);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.detected.clear();
    for (const observed of this.observed.values()) observed.detector?.dispose();
    this.observed.clear();
  }

  async refresh(): Promise<void> {
    if (this.pending || this.disposed) return;
    const targets = this.options.targets();
    if (!targets.length) return;
    this.pending = true;
    try {
      // Inspection failure removes hints; an unavailable ps must never leave
      // a stale agent mark or interfere with the shell itself.
      let succeeded = true;
      const platform = this.options.platform ?? process.platform;
      const snapshot = this.options.snapshot ?? (() => readProcessSnapshot(platform));
      const entries = await snapshot().catch(() => {
        succeeded = false;
        return new Map();
      });
      if (this.disposed) return;
      const current = new Map(this.options.targets().map((target) => [target.session, target]));
      for (const target of targets) {
        const now = current.get(target.session);
        if (now?.runtime !== target.runtime || now.pid !== target.pid) continue;
        const matches = new Set<string>();
        const pids = new Set<number>();
        for (const path of foregroundProcesses(target.pid, entries, platform)) {
          for (const entry of path) {
            let recognised = false;
            for (const adapter of this.options.adapters) {
              if (!adapter.matchesProcess?.(entry.command)) continue;
              matches.add(adapter.id);
              pids.add(entry.pid);
              recognised = true;
            }
            if (recognised) break;
          }
        }
        // The outermost recognised agent owns its tools/subagents. Ambiguous
        // pipelines retain the ordinary terminal glyph, even through wrappers.
        const agent = matches.size === 1 ? [...matches][0]! : null;
        const previous = this.get(target.session, target.runtime);
        if (agent) this.detected.set(target.session, { runtime: target.runtime, agent });
        else this.detected.delete(target.session);
        if (agent !== previous) this.options.changed(target.session);
        let observed = this.observed.get(target.session);
        if (observed && observed.runtime !== target.runtime) {
          observed.detector?.dispose();
          this.observed.delete(target.session);
          observed = undefined;
        }
        // Only a successful process snapshot with a live shell can establish
        // child exit. Suspension, backgrounding and failed ps are not exits.
        if (observed && succeeded && entries.has(target.pid) && !this.alive(observed, entries)) {
          observed.detector?.dispose();
          this.observed.delete(target.session);
          this.options.notify?.(target.session, 'exited');
          observed = undefined;
        }
        const pid = pids.size === 1 ? [...pids][0] : undefined;
        if (!agent || pid === undefined) {
          observed?.detector?.dispose();
          if (observed) {
            observed.detector = null;
            observed.armed = false;
          }
          continue;
        }
        const createdAtMs = entries.get(pid)?.createdAtMs ?? null;
        if (
          observed?.pid !== pid ||
          observed.createdAtMs !== createdAtMs ||
          observed.agent !== agent
        ) {
          observed?.detector?.dispose();
          observed = {
            runtime: target.runtime,
            agent,
            pid,
            createdAtMs,
            detector: null,
            armed: false,
          };
          this.observed.set(target.session, observed);
        }
        if (!observed.detector) {
          const current = observed;
          const adapter = this.options.adapters.find((item) => item.id === agent)!;
          current.detector = new StatusDetector(
            adapter.statusPatterns,
            {
              onBusy: () => {
                current.armed = true;
              },
              onStatus: (status) => {
                if (status !== 'waiting_input' || !current.armed || this.disposed) return;
                current.armed = false;
                this.options.notify?.(target.session, 'waiting_input');
              },
            },
            this.options.quietMs,
          );
        }
      }
    } finally {
      this.pending = false;
    }
  }

  /** The observed agent is still in the snapshot, and not a newer process on its pid. */
  private alive(observed: ObservedAgent, entries: ReadonlyMap<number, ProcessEntry>): boolean {
    const entry = entries.get(observed.pid);
    return entry !== undefined && (entry.createdAtMs ?? null) === observed.createdAtMs;
  }
}

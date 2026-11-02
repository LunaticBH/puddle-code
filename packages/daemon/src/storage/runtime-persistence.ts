import type { SessionStatus } from '@puddle/shared';
import type { SessionStore } from '../db/stores/sessions.js';
import type { EventStore } from '../db/stores/events.js';
import { isStorageFull } from './errors.js';
import type { StorageMonitor } from './monitor.js';

interface PendingState {
  status: SessionStatus;
  exitCode?: number;
}
const MAX_PENDING = 4096;

/** Only coalesced observations are retried. User actions and native switches never are. */
export class RuntimePersistence {
  private readonly pending = new Map<string, PendingState>();
  constructor(
    private readonly sessions: SessionStore,
    private readonly events: EventStore,
    private readonly storage?: StorageMonitor,
  ) {}

  observe(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!isStorageFull(error)) throw error;
      this.storage?.noteFailure(error);
    }
  }

  forget(id: string): void {
    this.pending.delete(id);
    this.storage?.setPendingRuntimeCount(this.pending.size);
  }

  state(id: string): PendingState | undefined {
    return this.pending.get(id);
  }

  save(id: string, state: PendingState): boolean {
    try {
      this.sessions.setStatus(id, state.status);
      if (state.exitCode !== undefined) this.events.record(id, 'exited', { code: state.exitCode });
      this.pending.delete(id);
      this.storage?.setPendingRuntimeCount(this.pending.size);
      return true;
    } catch (error) {
      if (!isStorageFull(error)) throw error;
      this.storage?.noteFailure(error);
      if (this.pending.has(id) || this.pending.size < MAX_PENDING) this.pending.set(id, state);
      this.storage?.setPendingRuntimeCount(this.pending.size);
      // Admission is stopped on database exhaustion, so normally only already-live
      // runtimes can enter this map. The hard cap also bounds pathological hosts.
      return false;
    }
  }

  retry(): string[] {
    const saved: string[] = [];
    for (const [id, state] of this.pending) {
      if (!this.save(id, state)) break;
      saved.push(id);
    }
    return saved;
  }
}

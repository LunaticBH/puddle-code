import type { HostInfo, Session, VersionResponse } from '@puddle/shared';
import type { DaemonClient } from './daemon-client.js';

export interface StatusReport {
  daemon: VersionResponse;
  host: HostInfo;
  sessions: Session[];
}

const LIVE_FIRST: Record<string, number> = {
  running: 0,
  waiting_input: 1,
  starting: 2,
  interrupted: 3,
  exited: 4,
  archived: 5,
};

/** Structured status data; the bin renders it (lib returns rows, not text). */
export async function statusReport(client: DaemonClient): Promise<StatusReport> {
  const [daemon, host, sessions] = await Promise.all([
    client.version(),
    client.host(),
    client.sessions(),
  ]);
  sessions.sort(
    (a, b) =>
      (LIVE_FIRST[a.status] ?? 9) - (LIVE_FIRST[b.status] ?? 9) ||
      (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''),
  );
  return { daemon, host, sessions: sessions.filter((s) => s.status !== 'archived') };
}

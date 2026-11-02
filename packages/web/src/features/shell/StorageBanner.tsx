import { useQuery } from '@tanstack/react-query';
import type { StorageStatus } from '@puddle/shared';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import { browserTransport } from '../../lib/browser-transport';
import { useDaemonVersion } from '../../lib/queries';

/** Persistent until recovery; a toast is too easy to miss during a storage outage. */
export function StorageBanner() {
  const version = useDaemonVersion().data?.protocol;
  const supported =
    version !== undefined && (version.major > 25 || (version.major === 25 && version.minor >= 5));
  const { data } = useQuery({
    queryKey: ['storage'],
    queryFn: () => api<StorageStatus>('GET', '/api/storage'),
    enabled: supported && !browserTransport(),
    refetchInterval: 10_000,
    retry: false,
  });
  if (!data) return null;
  const volumes = data.volumes.filter((volume) => volume.level !== 'ok');
  if (!data.logs_degraded && !data.database_degraded && volumes.length === 0) return null;
  const critical = volumes.some((volume) => volume.level === 'critical');
  return (
    <div role="status" className="flex shrink-0 items-start gap-2 px-3 py-2 text-xs text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {data.database_degraded && (
          <p>Storage is full. Changes cannot be saved. Live session status may be unsaved.</p>
        )}
        {data.logs_degraded && (
          <p>Terminal history is temporarily not being saved. Live terminals remain connected.</p>
        )}
        {critical && (
          <p>
            Storage is critically low. Free space or inodes before starting new sessions or
            worktrees.
          </p>
        )}
        {volumes.map((volume) => (
          <p key={volume.path} className="break-all text-fg-secondary">
            {volume.level === 'unknown' ? 'Could not check storage' : 'Low storage'} at{' '}
            {volume.path}
            {volume.available_bytes !== null &&
              ` · ${Math.round(volume.available_bytes / 1024 ** 2).toLocaleString()} MiB available`}
            {volume.available_inodes !== null &&
              ` · ${volume.available_inodes.toLocaleString()} inodes available`}
          </p>
        ))}
      </div>
    </div>
  );
}

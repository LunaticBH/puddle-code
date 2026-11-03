import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CompilationFailure,
  CompilationRunResponse,
  CompilationTargetRequest,
} from '@puddle/shared';
import { setCompilationMode, useCompilationStatus } from '../../../lib/queries/compilation-queries';
import { failureFrom } from './compilation-errors';

/**
 * Browser bridge for one persisted eager source. The daemon owns filesystem
 * observation and build coalescing; this lightweight poll only delivers the
 * newest completed revision to the already-authenticated cockpit.
 * Status revisions advance when a build starts, while the retained result
 * still describes the last successful build. Deduplicate by result revision
 * so observing an in-flight build cannot consume its eventual PDF refresh.
 */
export function CompilationWatcher({
  target,
  sourceKey,
  leafId,
  onResult,
  onError,
  onRunningChange,
}: {
  target: CompilationTargetRequest;
  sourceKey: string;
  leafId: string;
  onResult: (sourceKey: string, leafId: string, result: CompilationRunResponse) => void;
  onError: (sourceKey: string, failure: CompilationFailure) => void;
  onRunningChange: (sourceKey: string, running: boolean) => void;
}) {
  const [registered, setRegistered] = useState(false);
  const deliveredRevision = useRef(-1);
  const deliveredErrorRevision = useRef(-1);
  const stableTarget = useMemo(
    () => ({
      source: {
        session: target.source.session,
        path: target.source.path,
        ...(target.source.root !== undefined ? { root: target.source.root } : {}),
      },
      ...(target.provider !== undefined ? { provider: target.provider } : {}),
      ...(target.profile_id !== undefined ? { profile_id: target.profile_id } : {}),
      ...(target.project_id !== undefined ? { project_id: target.project_id } : {}),
    }),
    [
      target.provider,
      target.profile_id,
      target.project_id,
      target.source.session,
      target.source.path,
      target.source.root,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    setRegistered(false);
    onRunningChange(sourceKey, true);
    void setCompilationMode({ ...stableTarget, mode: 'eager' })
      .then((snapshot) => {
        if (cancelled) return;
        onRunningChange(sourceKey, snapshot.state === 'running');
        setRegistered(true);
        if (snapshot.result && snapshot.result.revision > deliveredRevision.current) {
          deliveredRevision.current = snapshot.result.revision;
          onResult(sourceKey, leafId, snapshot.result);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          onRunningChange(sourceKey, false);
          // A provider may have installed its source watcher before the first
          // build failed. Keep polling so fixing the file on disk can deliver
          // the later successful eager revision without toggling the mode.
          setRegistered(true);
          onError(sourceKey, failureFrom(error));
        }
      });
    return () => {
      cancelled = true;
      onRunningChange(sourceKey, false);
      void setCompilationMode({ ...stableTarget, mode: 'on_demand' }).catch(() => undefined);
    };
  }, [stableTarget, sourceKey, leafId, onResult, onError, onRunningChange]);

  const status = useCompilationStatus(stableTarget, registered);
  const snapshot = status.data;
  useEffect(() => {
    if (!snapshot) return;
    onRunningChange(sourceKey, snapshot.state === 'running');
    if (snapshot.result && snapshot.result.revision > deliveredRevision.current) {
      deliveredRevision.current = snapshot.result.revision;
      onResult(sourceKey, leafId, snapshot.result);
    }
    if (
      snapshot.state === 'failed' &&
      snapshot.error &&
      snapshot.revision > deliveredErrorRevision.current
    ) {
      deliveredErrorRevision.current = snapshot.revision;
      onError(sourceKey, snapshot.error);
    }
  }, [snapshot, sourceKey, leafId, onResult, onError, onRunningChange]);

  return null;
}

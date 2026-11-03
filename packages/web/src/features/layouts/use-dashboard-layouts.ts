import { useEffect, useMemo, useState } from 'react';
import { uiStateSnapshotSchema, type SavedLayout, type UiStateSnapshot } from '@puddle/shared';
import { clientSettings, updateClientSettings } from '../../lib/settings/client-settings';
import {
  fetchProfileState,
  putProfileState,
  useAllSessions,
  useProjects,
} from '../../lib/queries/queries';
import { layoutSignature } from '../workspace/layout/layout-signature';
import { loadLayoutPatch } from '../workspace/layout/project-layout';
import { parseWorkingSet, workingSetKey } from '../workspace/use-ui-state';
import type { LayoutBridge } from './layouts-store';

const EMPTY: UiStateSnapshot = uiStateSnapshotSchema.parse({});

/**
 * The dashboard's stand-in for the workspace layout bridge (SPEC §11
 * Layouts): no workspace is mounted, but the profile's layout state still
 * exists — the per-window working set over the profile row — so saved layouts
 * load into it and the next workspace open restores them. Reads mirror
 * `useUiState`'s load order (sessionStorage first, server row as the seed);
 * the write is immediate rather than debounced — a load is one deliberate
 * action with no editing session to batch behind. Safe to drive the snapshot
 * directly because `enabled` guarantees no workspace `useUiState` handle is
 * alive in this window to race with.
 *
 * Under project-based layout there is no single live layout for a head to
 * describe (every project keeps its own), so the bridge turns `headless` and
 * reports per-slice state for the popover's current-marks and load confirms.
 */
export function useDashboardLayouts(
  profileId: string | null,
  enabled: boolean,
): LayoutBridge | null {
  const [snap, setSnap] = useState<UiStateSnapshot | null>(null);
  const sessions = useAllSessions(enabled).data;
  const projects = useProjects(profileId ?? undefined, enabled && profileId !== null).data;

  useEffect(() => {
    if (!enabled || profileId === null) {
      setSnap(null);
      return;
    }
    let cancelled = false;
    let stored: ReturnType<typeof parseWorkingSet>;
    try {
      stored = parseWorkingSet(sessionStorage.getItem(workingSetKey(profileId)));
    } catch {
      stored = { kind: 'absent' };
    }
    if (stored.kind === 'present') {
      setSnap(stored.snapshot);
      return;
    }
    fetchProfileState(profileId)
      .then((state) => {
        if (!cancelled) setSnap(state ? state.ui_state : EMPTY);
      })
      .catch(() => {
        if (!cancelled) setSnap(EMPTY); // degrade like useUiState: fresh workspace
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, profileId]);

  return useMemo<LayoutBridge | null>(() => {
    if (!enabled || profileId === null || snap === null) return null;

    const apply = (saved: SavedLayout): boolean => {
      if (!sessions || !projects) return false;
      const { patch, projectBased } = loadLayoutPatch(snap, saved, {
        alive: new Set(sessions.filter((s) => s.status !== 'archived').map((s) => s.id)),
        sessionProject: new Map(sessions.map((s) => [s.id, s.project_id])),
        projectIds: projects.map((p) => p.id),
        currentProject: null,
      });
      const next = { ...snap, ...patch };
      setSnap(next);
      // Same write pair as `useUiState.update`, without the debounce; the
      // server PUT first so a sessionStorage throw cannot skip it.
      void putProfileState(profileId, next).catch((e) =>
        console.warn(`ui-state save failed: ${(e as Error).message}`),
      );
      try {
        sessionStorage.setItem(workingSetKey(profileId), JSON.stringify(next));
      } catch (e) {
        console.warn(`ui-state write failed: ${(e as Error).message}`);
      }
      if (clientSettings().projectBasedLayout !== projectBased) {
        updateClientSettings({ projectBasedLayout: projectBased });
      }
      return true;
    };

    // Slices in BOTH modes: every project's own current layout under
    // project-based layout, or slices preserved through an earlier
    // profile-load — either way, what a project-scoped load would replace.
    const slices = Object.fromEntries(
      Object.entries(snap.project_layouts).map(([pid, slice]) => [
        pid,
        { layoutRef: slice.layout_ref, signature: layoutSignature(slice.layout_tree) },
      ]),
    );
    if ((snap.layout_mode ?? 'profile') === 'project') {
      return {
        headless: true,
        scope: 'project',
        projectId: '',
        layoutRef: null,
        signature: layoutSignature(null),
        slices,
        capture: () => ({ layout_tree: null, active_session: null }),
        apply,
      };
    }
    return {
      scope: 'profile',
      projectId: '',
      layoutRef: snap.layout_ref,
      signature: layoutSignature(snap.layout_tree),
      slices,
      capture: () => ({ layout_tree: snap.layout_tree, active_session: snap.active_session }),
      apply,
    };
  }, [enabled, profileId, snap, sessions, projects]);
}

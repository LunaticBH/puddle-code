import { useEffect, useReducer, useRef } from 'react';
import {
  updateClientSettings,
  useClientSettings,
  type ClientSettings,
} from '../../lib/settings/client-settings';
import { effectiveSyncEntry, useLocalSync, usePutLocalSync } from '../../lib/settings/local-sync';
import {
  useCreateScratchpad,
  usePatchProfile,
  usePatchProfileSettings,
  useProfileSettings,
  useProfiles,
  useScratchpad,
} from '../../lib/queries/queries';
import {
  applyImport,
  collectExport,
  type SyncSinks,
  type SyncSources,
} from '../../lib/settings/settings-sync-manifest';
import {
  applyTheme,
  onThemeChange,
  storedPreference,
  type ThemePreference,
} from '../../lib/appearance/theme';
import { useCurrentProfileId } from '../profile/profile-store';

/**
 * The "Sync locally" engine (SPEC §11), mounted once per window. While the
 * current profile's entry in the machine-shared store is enabled, this keeps
 * the two in step, both ways, restricted to the entry's selected groups:
 *
 *  - store changed (another window wrote it; refetched on focus) → apply it
 *    here through the same `applyImport` path as a paste-import — scratchpad
 *    entries merge additively, never overriding;
 *  - local sources changed → collect and PUT, so other windows pick it up.
 *
 * Loop discipline: the import pass runs first and remembers what it applied;
 * the export pass is skipped while the import's own patches are still in
 * flight (their refetch delivers fresh sources, after which collect equals
 * the store and nothing writes).
 */
export function useLocalSyncEngine(): void {
  const profileId = useCurrentProfileId();
  const profile = useProfiles().data?.find((p) => p.id === profileId);
  const settings = useProfileSettings(profileId ?? undefined);
  // No project param → exactly the profile-scoped entries (the only ones that sync).
  const scratchpad = useScratchpad(profileId ?? undefined, undefined);
  const client = useClientSettings();
  const sync = useLocalSync();
  const put = usePutLocalSync();
  const patchSettings = usePatchProfileSettings(profileId ?? '');
  const patchProfile = usePatchProfile();
  const createScratchpad = useCreateScratchpad();

  // Theme changes bypass react state (a module store) — subscribe explicitly.
  const [themeTick, bumpTheme] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onThemeChange(() => bumpTheme()), []);

  /** JSON of the store doc this window last applied (or itself wrote). */
  const lastAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    lastAppliedRef.current = null; // a different profile starts from scratch
  }, [profile?.name]);

  const store = sync.data?.available === true ? sync.data.file : undefined;
  const ready =
    profile !== undefined &&
    profileId !== null &&
    settings.data !== undefined &&
    scratchpad.data !== undefined &&
    store !== undefined;
  // Default-enabled when the store has no entry yet (sync locally is on by
  // default): the first export pass persists the entry.
  const entry = profile && store ? effectiveSyncEntry(store, profile.name) : undefined;
  const busy =
    patchSettings.isPending ||
    patchProfile.isPending ||
    createScratchpad.isPending ||
    put.isPending ||
    settings.isFetching ||
    scratchpad.isFetching;

  useEffect(() => {
    void themeTick; // re-runs the passes after a theme change (module store, no react state)
    if (!ready || !entry?.enabled || busy) return;
    const sources: SyncSources = {
      client: client as unknown as Record<string, unknown>,
      theme: storedPreference(),
      profileSettings: settings.data as Record<string, unknown>,
      profile: profile as unknown as Record<string, unknown>,
      scratchpad: scratchpad.data,
    };
    const sinks: SyncSinks = {
      setClient: (p) => updateClientSettings(p as Partial<ClientSettings>),
      setTheme: (v) => {
        if (typeof v === 'string') applyTheme(v as ThemePreference);
      },
      patchProfileSettings: (p) => patchSettings.mutate(p),
      patchProfileColumns: (p) => patchProfile.mutate({ id: profileId, ...p }),
      createScratchpad: (entries) => {
        for (const e of entries) {
          createScratchpad.mutate({
            profile_id: profileId,
            scope: 'profile',
            title: e.title ?? undefined,
            body: e.body,
            tags: e.tags,
            agent_type: e.agent_type ?? undefined,
          });
        }
      },
    };

    // Import pass: the store holds something this window hasn't applied yet.
    const incoming = JSON.stringify(entry.doc);
    if (lastAppliedRef.current !== incoming) {
      lastAppliedRef.current = incoming;
      applyImport(entry.doc, sinks, sources, entry.groups);
      return; // the patches' refetch re-runs this effect with fresh sources
    }

    // Export pass: local state drifted from the store — mirror it out.
    const doc = collectExport(entry.groups, sources);
    const current = JSON.stringify(doc);
    if (current !== incoming) {
      lastAppliedRef.current = current;
      put.mutate({
        profile: profile.name,
        entry: { ...entry, doc, updatedAt: new Date().toISOString() },
      });
    }
  });
}

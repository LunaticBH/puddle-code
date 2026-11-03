import { useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '../../../lib/transport/errors';
import { Button } from '../../../components/ui/button';
import { Textarea } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { Disclosure } from '../../../components/ui/disclosure';
import {
  clientSettings,
  updateClientSettings,
  type ClientSettings,
} from '../../../lib/settings/client-settings';
import {
  effectiveSyncEntry,
  useLocalSync,
  usePutLocalSync,
  type LocalSyncEntry,
} from '../../../lib/settings/local-sync';
import {
  useCreateScratchpad,
  usePatchProfile,
  usePatchProfileSettings,
  useProfileSettings,
  useProfiles,
  useScratchpad,
} from '../../../lib/queries/queries';
import { decodeSettings, encodeSettings } from '../../../lib/settings/settings-sync';
import {
  applyImport,
  collectExport,
  SYNC_GROUPS,
  type SyncSinks,
  type SyncSources,
} from '../../../lib/settings/settings-sync-manifest';
import { applyTheme, storedPreference, type ThemePreference } from '../../../lib/appearance/theme';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle } from '../parts';

/** The browser's remembered checklist, used until (and unless) local sync owns it. */
const SELECTION_KEY = 'puddle.sync-selection';
function storedSelection(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as unknown;
    if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  } catch {
    // Corrupt → default below.
  }
  return SYNC_GROUPS.map((g) => g.id);
}

/** One checklist drives everything: the string export AND both local-sync directions. */
function GroupChecklist({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 pl-1">
      {SYNC_GROUPS.map((g) => (
        <label key={g.id} className="flex items-center gap-2 text-sm text-fg">
          <Switch checked={selected.includes(g.id)} onCheckedChange={(on) => onToggle(g.id, on)} />
          {g.label}
        </label>
      ))}
    </div>
  );
}

/**
 * Settings → Remote & Sync (SPEC §11). Three sync blocks:
 *  - "Sync locally": mirror the selected groups through the machine-shared
 *    cockpit store, so every Puddle window (any port, any daemon) follows —
 *    the checklist then governs BOTH directions;
 *  - Export: one click encodes, shows, and copies the string.
 *  - Import: paste an exported string.
 * All three route through the same manifest; scratchpad entries always merge
 * additively on import, never overriding.
 */
export function SyncSection() {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const profile = useProfiles().data?.find((p) => p.id === profileId);
  const scratchpad = useScratchpad(profileId ?? undefined, undefined);
  const patchSettings = usePatchProfileSettings(profileId ?? '');
  const patchProfile = usePatchProfile();
  const createScratchpad = useCreateScratchpad();
  const localSync = useLocalSync();
  const putLocalSync = usePutLocalSync();

  const [importText, setImportText] = useState('');
  const [exported, setExported] = useState('');
  const [busy, setBusy] = useState(false);
  const [localSelection, setLocalSelection] = useState<string[]>(storedSelection);

  // Default-enabled when the profile has no stored entry (on by default).
  const entry =
    profile && localSync.data ? effectiveSyncEntry(localSync.data.file, profile.name) : undefined;
  const enabled = entry?.enabled === true;
  // Once local sync owns a selection, it is THE selection everywhere.
  const selected = enabled && entry ? entry.groups : localSelection;

  const sources = (): SyncSources => ({
    client: clientSettings() as unknown as Record<string, unknown>,
    theme: storedPreference(),
    profileSettings: (settings.data ?? {}) as Record<string, unknown>,
    profile: (profile ?? {}) as unknown as Record<string, unknown>,
    scratchpad: scratchpad.data ?? [],
  });

  const sinks: SyncSinks = {
    setClient: (p) => updateClientSettings(p as Partial<ClientSettings>),
    setTheme: (v) => {
      if (typeof v === 'string') applyTheme(v as ThemePreference);
    },
    patchProfileSettings: (p) => patchSettings.mutate(p, { onError: (e) => toastError(e) }),
    patchProfileColumns: (p) => {
      if (profileId)
        patchProfile.mutate({ id: profileId, ...p }, { onError: (e) => toastError(e) });
    },
    createScratchpad: (entries) => {
      if (!profileId) return;
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

  const writeEntry = (next: Partial<LocalSyncEntry>, groups: string[]) => {
    if (!profile) return;
    putLocalSync.mutate(
      {
        profile: profile.name,
        entry: {
          enabled: next.enabled ?? enabled,
          groups,
          doc: collectExport(groups, sources()),
          updatedAt: new Date().toISOString(),
        },
      },
      { onError: (e) => toastError(e) },
    );
  };

  const onToggleGroup = (id: string, on: boolean) => {
    const next = on ? [...selected, id] : selected.filter((g) => g !== id);
    setLocalSelection(next);
    localStorage.setItem(SELECTION_KEY, JSON.stringify(next));
    if (enabled) writeEntry({}, next);
  };

  const onImport = async () => {
    setBusy(true);
    try {
      const doc = await decodeSettings(importText.trim());
      // Import data is loosely typed; each store validates its own writes
      // (the daemon zod-checks profile settings; applyTheme guards the value).
      const applied = applyImport(doc, sinks, {
        profileSettings: (settings.data ?? {}) as Record<string, unknown>,
        scratchpad: scratchpad.data ?? [],
      });
      if (applied.length === 0) toast.error('Nothing recognised to import.');
      else {
        toast.success(`Imported ${applied.join(', ')}.`);
        setImportText('');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** One click: encode, show, and copy — no second button to hunt for. */
  const onExport = async () => {
    setBusy(true);
    try {
      const blob = await encodeSettings(collectExport(selected, sources()));
      setExported(blob);
      await navigator.clipboard?.writeText(blob);
      toast.success('Copied to clipboard');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionTitle>Sync</SectionTitle>
      <p className="mb-5 text-xs text-fg-muted">
        Carry your settings between machines. Accounts, repositories, and anything host-specific are
        never included. Applies to this profile.
      </p>

      <div className="mb-6">
        <h3 className="text-sm font-medium text-fg">Sync locally</h3>
        {localSync.data?.available === false ? (
          <p className="mt-1 text-xs text-fg-muted">
            Not available in this cockpit — start the UI with the Puddle CLI to sync across windows.
          </p>
        ) : (
          <>
            <p className="mb-2 mt-1 text-xs text-fg-muted">
              Sync selected groups through this machine’s{' '}
              <span className="text-fg-secondary">~/.puddle</span>, so every Puddle window stays in
              step for profiles named{' '}
              <span className="text-fg-secondary">{profile?.name ?? '…'}</span>.
            </p>
            <label className="flex items-center gap-2 text-sm text-fg">
              <Switch
                checked={enabled}
                disabled={!profile || localSync.isLoading || putLocalSync.isPending}
                onCheckedChange={(on) => writeEntry({ enabled: on }, selected)}
              />
              Sync locally
            </label>
          </>
        )}
      </div>

      <Disclosure className="mb-6" summary="Choose what to sync" summaryClassName="text-xs">
        <div className="mt-2">
          <GroupChecklist selected={selected} onToggle={onToggleGroup} />
        </div>
      </Disclosure>

      <div className="mb-6">
        <h3 className="text-sm font-medium text-fg">Export</h3>
        <p className="mb-2 mt-1 text-xs text-fg-muted">
          Builds a Puddle magic string that encodes settings from the checklist above.
        </p>
        <Button size="sm" disabled={busy} onClick={() => void onExport()}>
          Export &amp; copy
        </Button>
        {exported && (
          <Textarea
            readOnly
            value={exported}
            rows={3}
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-2 resize-y font-mono text-xs"
          />
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium text-fg">Import</h3>
        <p className="mb-2 text-xs text-fg-muted">
          Paste a Puddle magic string to import its settings.
        </p>
        <Textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Paste a settings export…"
          rows={3}
          spellCheck={false}
          className="resize-y font-mono text-xs"
        />
        <div className="mt-2">
          <Button size="sm" disabled={!importText.trim() || busy} onClick={() => void onImport()}>
            Import
          </Button>
        </div>
      </div>
    </div>
  );
}

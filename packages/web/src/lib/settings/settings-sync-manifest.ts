/**
 * What Settings Sync carries (SPEC §11): the machine-agnostic preferences,
 * grouped by header for the sync checklist. The same manifest drives the
 * string export/import AND the machine-local sync mirror, so "what syncs" is
 * decided in exactly one place. Deliberately EXCLUDES anything that can't map
 * 1:1 onto another machine — accounts, repositories, project order, default
 * account, the daemon's agent search path, worktree paths, per-project mutes.
 *
 * Each field names the store it lives in so import can route it back:
 * `client` (localStorage clientSettings), `theme` (the theme preference),
 * `profileSettings` (the profile's settings JSON), `profileColumn` (a column on
 * the profile row, patched via PATCH /api/profiles/:id), `scratchpad` (the
 * profile's scratchpad entries, merged additively — see below).
 */
export type SyncStore = 'client' | 'theme' | 'profileSettings' | 'profileColumn' | 'scratchpad';

export interface SyncField {
  key: string;
  store: SyncStore;
  /**
   * Optional projection applied on export — strip host-local sub-keys from an
   * object value (e.g. notification prefs travel without `muted_projects`).
   */
  pick?: (value: unknown) => unknown;
  /**
   * Optional merge applied on import: combine the incoming value with the
   * current one instead of replacing it (the counterpart of `pick`, so the
   * host-local sub-keys the projection dropped survive an import).
   */
  mergeInto?: (incoming: unknown, current: unknown) => unknown;
}
export interface SyncGroup {
  id: string;
  label: string;
  fields: SyncField[];
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

// Group order mirrors the settings sidebar's tab order (the non-portable
// tabs — Accounts, Repositories, Host, Sync — simply absent).
export const SYNC_GROUPS: SyncGroup[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    fields: [
      { key: 'theme', store: 'theme' },
      { key: 'cursorPackage', store: 'client' },
      { key: 'uiFontSize', store: 'client' },
      { key: 'terminalFontSize', store: 'client' },
      { key: 'editorFontSize', store: 'client' },
      { key: 'density', store: 'client' },
      { key: 'terminalScrollback', store: 'client' },
      { key: 'projectBasedLayout', store: 'client' },
      { key: 'showAllProjectSessions', store: 'client' },
    ],
  },
  {
    id: 'profile',
    label: 'Profile',
    fields: [
      { key: 'branch_prefix', store: 'profileColumn' },
      { key: 'icon', store: 'profileColumn' },
      { key: 'icon_colour', store: 'profileColumn' },
    ],
  },
  {
    id: 'sessions',
    label: 'Sessions',
    fields: [
      { key: 'onboardingTemplate', store: 'profileSettings' },
      { key: 'concurrentTemplate', store: 'profileSettings' },
      { key: 'restartTemplate', store: 'profileSettings' },
      { key: 'tabTitleTemplate', store: 'profileSettings' },
      { key: 'sessionDefaults', store: 'profileSettings' },
      { key: 'allowSkipPermissions', store: 'profileSettings' },
      { key: 'captureSessionEnv', store: 'profileSettings' },
    ],
  },
  {
    id: 'editor',
    label: 'Editor',
    fields: [
      { key: 'editorTabSize', store: 'client' },
      { key: 'editorWordWrap', store: 'client' },
      { key: 'editorLinkSshHost', store: 'client' },
    ],
  },
  { id: 'hotkeys', label: 'Hotkeys', fields: [{ key: 'hotkeys', store: 'profileSettings' }] },
  {
    id: 'notifications',
    label: 'Notifications',
    fields: [
      {
        key: 'notifications',
        store: 'profileSettings',
        // Muted projects are host-local project ids — they never travel, and
        // an import must not wipe the ones this host already muted.
        pick: (v) => {
          const { desktop, sound, when_focused } = asObject(v);
          return { desktop, sound, ...(when_focused !== undefined ? { when_focused } : {}) };
        },
        mergeInto: (incoming, current) => ({ ...asObject(current), ...asObject(incoming) }),
      },
    ],
  },
  {
    id: 'scratchpad',
    label: 'Scratchpad (profile-wide entries)',
    fields: [{ key: 'entries', store: 'scratchpad' }],
  },
];

/**
 * A scratchpad entry as it travels: content only, no ids/positions/timestamps
 * (all host-local). Only profile-scoped entries sync — a project-scoped entry
 * names a project id that does not exist elsewhere.
 */
export interface PortableScratchpadEntry {
  title: string | null;
  body: string;
  tags: string[];
  agent_type: string | null;
}

/** The subset of a live entry the identity/travel shape cares about. */
interface ScratchpadLike {
  scope: string;
  title: string | null;
  body: string;
  tags: string[];
  agent_type: string | null;
}

export function portableScratchpad(entries: ScratchpadLike[]): PortableScratchpadEntry[] {
  return entries
    .filter((e) => e.scope === 'profile')
    .map((e) => ({ title: e.title, body: e.body, tags: e.tags, agent_type: e.agent_type }));
}

/**
 * Identity for the additive merge: title + body + tags (in order) + agent
 * association. Scratchpad sync must never override — an incoming entry is
 * skipped only when an existing profile-scoped entry matches on ALL of these;
 * any difference keeps both copies.
 */
function entryIdentity(e: PortableScratchpadEntry): string {
  return JSON.stringify([e.title ?? '', e.body, e.tags, e.agent_type ?? '']);
}

/** The incoming entries with no exactly-identical local counterpart — the ones to create. */
export function missingScratchpadEntries(
  incoming: unknown,
  existing: ScratchpadLike[],
): PortableScratchpadEntry[] {
  if (!Array.isArray(incoming)) return [];
  const have = new Set(portableScratchpad(existing).map(entryIdentity));
  const seen = new Set<string>(); // dedupe within the payload itself
  const out: PortableScratchpadEntry[] = [];
  for (const raw of incoming) {
    const o = asObject(raw);
    if (typeof o.body !== 'string' || o.body.length === 0) continue;
    const entry: PortableScratchpadEntry = {
      title: typeof o.title === 'string' && o.title !== '' ? o.title : null,
      body: o.body,
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
      agent_type: typeof o.agent_type === 'string' ? o.agent_type : null,
    };
    const id = entryIdentity(entry);
    if (have.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

/** Current values, per store, for `collectExport` to read. */
export interface SyncSources {
  client: Record<string, unknown>;
  theme: unknown;
  profileSettings: Record<string, unknown>;
  profile: Record<string, unknown>;
  /** The profile's live scratchpad entries (any scope; the projection filters). */
  scratchpad: ScratchpadLike[];
}

/** Live setters, per store, for `applyImport` to route into. */
export interface SyncSinks {
  setClient: (patch: Record<string, unknown>) => void;
  setTheme: (value: unknown) => void;
  patchProfileSettings: (patch: Record<string, unknown>) => void;
  patchProfileColumns: (patch: Record<string, unknown>) => void;
  /** Create the given profile-scoped entries (already merge-filtered). */
  createScratchpad: (entries: PortableScratchpadEntry[]) => void;
}

function readField(field: SyncField, s: SyncSources): unknown {
  switch (field.store) {
    case 'client':
      return s.client[field.key];
    case 'theme':
      return s.theme;
    case 'profileSettings':
      return s.profileSettings[field.key];
    case 'profileColumn':
      return s.profile[field.key];
    case 'scratchpad':
      return portableScratchpad(s.scratchpad);
  }
}

/** Build the export object for the chosen groups: `{ groupId: { key: value } }`. */
export function collectExport(
  selectedGroupIds: string[],
  sources: SyncSources,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const group of SYNC_GROUPS) {
    if (!selectedGroupIds.includes(group.id)) continue;
    const values: Record<string, unknown> = {};
    for (const field of group.fields) {
      const raw = readField(field, sources);
      if (raw === undefined) continue;
      values[field.key] = field.pick ? field.pick(raw) : raw;
    }
    if (Object.keys(values).length > 0) out[group.id] = values;
  }
  return out;
}

/**
 * Route an imported object's present fields into the live stores, restricted
 * to `selectedGroupIds` when given (local sync applies its checklist to both
 * directions; the paste-import applies everything the string carries).
 * `sources` provides the current values that `mergeInto` fields and the
 * scratchpad merge compare against. Returns the labels of the groups that had
 * something to apply.
 */
export function applyImport(
  imported: unknown,
  sinks: SyncSinks,
  sources: Pick<SyncSources, 'profileSettings' | 'scratchpad'>,
  selectedGroupIds?: string[],
): string[] {
  if (!imported || typeof imported !== 'object') return [];
  const doc = imported as Record<string, unknown>;
  const clientPatch: Record<string, unknown> = {};
  const settingsPatch: Record<string, unknown> = {};
  const columnPatch: Record<string, unknown> = {};
  const applied: string[] = [];

  for (const group of SYNC_GROUPS) {
    if (selectedGroupIds && !selectedGroupIds.includes(group.id)) continue;
    const values = doc[group.id];
    if (!values || typeof values !== 'object') continue;
    const bag = values as Record<string, unknown>;
    let any = false;
    for (const field of group.fields) {
      if (!(field.key in bag)) continue;
      const v = bag[field.key];
      if (field.store === 'scratchpad') {
        const create = missingScratchpadEntries(v, sources.scratchpad);
        if (create.length > 0) {
          sinks.createScratchpad(create);
          any = true;
        }
        continue;
      }
      any = true;
      const value = field.mergeInto
        ? field.mergeInto(
            v,
            field.store === 'profileSettings' ? sources.profileSettings[field.key] : undefined,
          )
        : v;
      if (field.store === 'client') clientPatch[field.key] = value;
      else if (field.store === 'theme') sinks.setTheme(value);
      else if (field.store === 'profileSettings') settingsPatch[field.key] = value;
      else columnPatch[field.key] = value;
    }
    if (any) applied.push(group.label);
  }

  if (Object.keys(clientPatch).length > 0) sinks.setClient(clientPatch);
  if (Object.keys(settingsPatch).length > 0) sinks.patchProfileSettings(settingsPatch);
  if (Object.keys(columnPatch).length > 0) sinks.patchProfileColumns(columnPatch);
  return applied;
}

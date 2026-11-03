import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Copy, LayoutTemplate, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SavedLayout } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { registerHotkey } from '../../lib/navigation/hotkeys';
import {
  useCreateLayout,
  useDeleteLayout,
  useLayouts,
  usePatchLayout,
  useProjects,
} from '../../lib/queries/queries';
import { toastError } from '../../lib/transport/errors';
import { cn } from '../../lib/utils';
import { useCurrentProfileId } from '../profile/profile-store';
import { layoutSignature } from '../workspace/layout/layout-signature';
import { setLayoutsOpen, toggleLayouts, useLayoutBridge, useLayoutsOpen } from './layouts-store';
import { useDashboardLayouts } from './use-dashboard-layouts';

const EMPTY_SIGNATURE = layoutSignature(null);

/**
 * The Layouts popover (SPEC §11): a top-bar popover between Settings and the
 * Scratchpad, in the Scratchpad's mould. It is a LIST, not a dashboard — the
 * live layout's own state is carried by its row (its name reads green/`Active`
 * when it matches what is saved, red/`Unsaved` when it has drifted), so nothing
 * above the list repeats it. What appears above it is only ever the name FIELD
 * for the live layout — permanently while it has no row of its own (never
 * saved), and on demand from the header's `+` (the Scratchpad's composer
 * gesture), which saves the live layout under a new name and adopts it.
 *
 * Under project-based layout the catalogue narrows to this project's layouts
 * plus the profile-wide ones (decision 2026-08-03): another project's layout is
 * neither visible nor affectable from here, and hiding them leaves exactly ONE
 * current layout in the list. A project name under a row is what marks its
 * scope — profile-wide rows carry no label, since that is the absence of one.
 *
 * Everything saved from here takes the provenance the CLIENT SETTING implies
 * right now (project-scoped under project-based layout, profile-wide
 * otherwise), never the provenance of the row it was invoked from: scope is
 * fixed at creation (SPEC §11), so a cross-scope save-as writes the current
 * scope's namesake rather than moving a layout between scopes. Loading a layout
 * whose scope disagrees with the setting flips the setting through the bridge,
 * which suppresses the union/shard transition so the loaded layout survives it.
 */
export function LayoutsPopover() {
  const open = useLayoutsOpen();
  const navigate = useNavigate();
  const profileId = useCurrentProfileId();
  const workspaceBridge = useLayoutBridge();
  // Without a workspace the dashboard bridge drives the persisted snapshot
  // directly — loads work everywhere; it reads only while the popover is open
  // (and only when no workspace ui-state handle exists to race with).
  const dashboard = useDashboardLayouts(profileId, open && workspaceBridge === null);
  const bridge = workspaceBridge ?? dashboard;
  const layouts = useLayouts(profileId ?? undefined, undefined).data ?? [];
  const projects = useProjects(profileId ?? undefined, open && profileId !== null).data ?? [];
  const create = useCreateLayout();
  const patch = usePatchLayout();
  const remove = useDeleteLayout();

  const [nameDraft, setNameDraft] = useState('');
  // `+` opens the name form for the LIVE layout, exactly as an unnamed one
  // always shows it — the one way to save the live layout under a fresh name.
  const [composing, setComposing] = useState(false);
  // 'profile' filters to profile-wide layouts; a project id to that project's.
  const [filterProject, setFilterProject] = useState<string | 'profile' | null>(null);

  useEffect(() => registerHotkey('layouts.toggle', toggleLayouts), []);
  // A closed popover drops any in-progress naming/filter state.
  useEffect(() => {
    if (!open) {
      setNameDraft('');
      setComposing(false);
      setFilterProject(null);
    }
  }, [open]);

  const headless = bridge?.headless === true;
  const current =
    bridge === null || headless ? null : (layouts.find((l) => l.id === bridge.layoutRef) ?? null);
  const dirty =
    bridge !== null &&
    !headless &&
    (current === null
      ? bridge.signature !== EMPTY_SIGNATURE
      : layoutSignature(current.layout_tree) !== bridge.signature);

  // A stored slice's own unsaved state: unnamed with content, or drifted from
  // the saved layout it derives from.
  const sliceDirty = (pid: string): boolean => {
    const slice = bridge?.slices?.[pid];
    if (!slice) return false; // no stored slice — nothing to lose
    const named =
      slice.layoutRef === null ? null : (layouts.find((l) => l.id === slice.layoutRef) ?? null);
    return named
      ? layoutSignature(named.layout_tree) !== slice.signature
      : slice.signature !== EMPTY_SIGNATURE;
  };

  // Whether loading `layout` would discard unsaved layout state — checked
  // against what the load actually replaces, never the unrelated visible
  // layout. A profile-scoped load under project mode retains every slice
  // (SPEC §11 Layouts), so there is nothing to confirm; a project-scoped load
  // replaces its OWN project's slice (the head when that is the open project);
  // under profile mode it additionally shards the live profile layout away.
  const discards = (layout: SavedLayout): boolean => {
    if (bridge === null) return false;
    if (layout.scope === 'profile') return bridge.scope === 'profile' && dirty;
    if (layout.project_id === null) return false;
    if (bridge.scope === 'project') {
      return !headless && layout.project_id === bridge.projectId
        ? dirty
        : sliceDirty(layout.project_id);
    }
    return dirty || sliceDirty(layout.project_id);
  };

  // The layout the live state derives from. With other projects' layouts hidden
  // there is at most one in the list, so this is simply "is this THE current
  // layout" — slices of other projects can no longer claim the mark.
  const isCurrent = (layout: SavedLayout): boolean => current !== null && layout.id === current.id;

  const projectName = (id: string | null): string =>
    (id !== null ? projects.find((p) => p.id === id)?.name : undefined) ?? 'Project';

  // The catalogue this popover shows. Under project-based layout, in a
  // workspace, that is this project's layouts plus the profile-wide ones;
  // otherwise (profile-wide layout, or the dashboard, where no project is open)
  // the whole profile's — every row is loadable from there.
  const ownProject = bridge !== null && !headless && bridge.scope === 'project';
  const catalogue = ownProject
    ? layouts.filter((l) => l.scope === 'profile' || l.project_id === bridge.projectId)
    : layouts;

  // Filter chips (the Scratchpad's pattern): narrowing only, and only over what
  // the catalogue actually holds — one kind of layout has nothing to narrow.
  const chips: { key: string | 'profile'; name: string }[] = [
    ...(catalogue.some((l) => l.scope === 'profile')
      ? [{ key: 'profile' as const, name: 'Profile-wide' }]
      : []),
    ...[...new Set(catalogue.flatMap((l) => (l.project_id !== null ? [l.project_id] : [])))]
      .map((id) => ({ key: id, name: projectName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
  const visible =
    filterProject === null
      ? catalogue
      : filterProject === 'profile'
        ? catalogue.filter((l) => l.scope === 'profile')
        : catalogue.filter((l) => l.project_id === filterProject);

  /**
   * Whether a row can be written IN PLACE: its provenance is the one a save
   * captures right now. Scope is fixed at creation (SPEC §11), so a row from
   * another scope cannot be overwritten — it gets a namesake instead.
   */
  const inScope = (layout: SavedLayout): boolean =>
    bridge !== null &&
    layout.scope === bridge.scope &&
    (bridge.scope === 'profile' || layout.project_id === bridge.projectId);

  /**
   * A new saved layout under the CURRENT provenance — project-scoped under
   * project-based layout, profile-wide otherwise — whatever row (or none) asked
   * for it. `adopt` makes the live layout derive from the result, which is right
   * whenever the tree being saved IS the live one and wrong when duplicating
   * somebody else's.
   */
  const createUnder = (
    name: string,
    payload: ReturnType<NonNullable<typeof bridge>['capture']>,
    adopt: boolean,
  ) => {
    if (!bridge || !profileId) return;
    create.mutate(
      {
        profile_id: profileId,
        scope: bridge.scope,
        project_id: bridge.scope === 'project' ? bridge.projectId : undefined,
        name,
        ...payload,
      },
      {
        onSuccess: (created) => {
          if (adopt) bridge.apply(created);
        },
        onError: (e) => toastError(e),
      },
    );
  };

  /**
   * Write the LIVE layout (unsaved changes included) into `layout`, and adopt it
   * as the live layout's name. An in-scope row is patched — the row that was
   * clicked, not one resolved by name, since nothing stops two layouts sharing a
   * name. A row from another scope cannot be moved here, so the current scope's
   * namesake takes the layout instead, created when it does not exist yet.
   */
  const saveAs = (layout: SavedLayout) => {
    if (!bridge) return;
    const target = inScope(layout)
      ? layout
      : layouts.find((l) => l.name === layout.name && inScope(l));
    if (!target) {
      createUnder(layout.name, bridge.capture(), true);
      return;
    }
    patch.mutate(
      { id: target.id, ...bridge.capture() },
      { onSuccess: (saved) => bridge.apply(saved), onError: (e) => toastError(e) },
    );
  };

  /**
   * A copy of a row's SAVED tree under a new name — the same thing on every row,
   * the current layout included: duplicating it copies what is stored, NOT the
   * unsaved changes on top, and leaves the live layout where it was. (Saving the
   * live layout under a fresh name is the `+` above, which is a different act
   * and says so.) Provenance follows the current setting, so duplicating a
   * profile-wide layout under project-based layout gives this project its copy.
   */
  const duplicate = (layout: SavedLayout, name: string) =>
    createUnder(
      name,
      { layout_tree: layout.layout_tree, active_session: layout.active_session },
      false,
    );

  const load = (layout: SavedLayout) => {
    if (!bridge) return;
    if (!bridge.apply(layout)) {
      toast.error('Workspace is still loading — try again in a moment');
      return;
    }
    // A project-scoped layout makes its project the active one (decision
    // 2026-08-03). `apply` has already flipped the client setting to
    // project-based layout if it was not, and that layout lives in ITS project's
    // slice — so without following the URL there, loading it from profile-wide
    // layout (or from the dashboard) would land the workspace in a project whose
    // slice is not the one just loaded, and nothing visible would change.
    if (layout.project_id !== null && layout.project_id !== bridge.projectId) {
      void navigate(`/project/${layout.project_id}`);
    }
    setLayoutsOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setLayoutsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {/* compact: narrower box, so the top-bar cluster closes up (§12). */}
            <Button variant="ghost" size="icon" className="compact:h-7 compact:w-7">
              <LayoutTemplate />
              <span className="sr-only">Layouts</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Layouts</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-[26rem] max-w-[calc(100vw-1rem)] p-0">
        <div className="flex items-center gap-2 px-5 pb-2 pt-4">
          <span className="text-2xs font-medium uppercase tracking-wide text-fg-gold">Layouts</span>
          {bridge !== null && !headless && (
            <button
              type="button"
              onClick={() => setComposing((c) => !c)}
              className="ml-auto flex items-center rounded-md p-1 text-fg-gold transition-colors hover:bg-surface hover:text-fg"
            >
              <Plus className="size-4" />
              <span className="sr-only">Save the current layout as a new layout</span>
            </button>
          )}
        </div>

        {/* Only what the list cannot say for itself: the live layout, when it has
            no row of its own (never saved) or is being saved under a new name. */}
        {bridge === null ? (
          <p className="px-5 pb-3 text-sm text-fg-muted">Loading the profile’s layout state…</p>
        ) : headless ? (
          <p className="px-5 pb-3 text-sm text-fg-muted">
            Project-based layout is on — every project keeps its own layout. Open a project to name
            or save it; loading works from here.
          </p>
        ) : (
          (current === null || composing) && (
            <div className="flex flex-col gap-2 px-5 pb-3">
              {current === null && (
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-fg">Unnamed layout</span>
                  <span className="text-2xs uppercase tracking-wide text-fg-muted">
                    {bridge.scope === 'profile' ? 'Profile-wide' : 'Project'}
                  </span>
                  <span className="ml-auto text-2xs text-interrupted">Unsaved</span>
                </div>
              )}
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = nameDraft.trim();
                  if (!name) return;
                  createUnder(name, bridge.capture(), true);
                  setNameDraft('');
                  setComposing(false);
                }}
              >
                <Input
                  autoFocus={composing}
                  value={nameDraft}
                  placeholder={current === null ? 'Name this layout…' : 'Save as a new layout…'}
                  spellCheck={false}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') setComposing(false);
                  }}
                  className="h-8 flex-1 text-sm"
                />
                <Button size="sm" type="submit" disabled={!nameDraft.trim()}>
                  Save
                </Button>
                {current !== null && (
                  <Button variant="ghost" size="sm" onClick={() => setComposing(false)}>
                    Cancel
                  </Button>
                )}
              </form>
            </div>
          )
        )}

        {chips.length > 1 && (
          <div className="flex flex-wrap items-center gap-1 px-5 pb-2">
            {chips.map((chip) => (
              <FilterChip
                key={chip.key}
                active={filterProject === chip.key}
                onClick={() => setFilterProject((cur) => (cur === chip.key ? null : chip.key))}
              >
                {chip.name}
              </FilterChip>
            ))}
          </div>
        )}

        <div className="no-scrollbar max-h-[60vh] overflow-y-auto px-2 pb-3">
          {visible.length === 0 && (
            <p className="px-3 py-3 text-sm text-fg-muted">
              {filterProject !== null
                ? 'Nothing matches this filter.'
                : 'No layouts yet — name and save the current layout to keep it.'}
            </p>
          )}
          <ul className="flex flex-col">
            {visible.map((layout) => (
              <li key={layout.id}>
                <LayoutRow
                  layout={layout}
                  // Absence of a project name IS profile-wide (SPEC §11).
                  projectLabel={layout.scope === 'profile' ? null : projectName(layout.project_id)}
                  isCurrent={isCurrent(layout)}
                  dirty={dirty}
                  loadable={bridge !== null}
                  savable={bridge !== null && !headless}
                  confirmBeforeLoad={discards(layout)}
                  overwrites={inScope(layout)}
                  onLoad={() => load(layout)}
                  onRename={(name) => patch.mutate({ id: layout.id, name })}
                  onDelete={() => remove.mutate(layout.id)}
                  onSaveAs={() => saveAs(layout)}
                  onDuplicate={(name) => duplicate(layout, name)}
                />
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One saved layout, text first like a Scratchpad row: the name, then a
 * persistent meta+tools line. Clicking the row loads it; renaming, naming a
 * copy, and every confirm expand inline (HUMANS.md — no modal). The CURRENT
 * layout wears its state in its name: green/`Active` when it matches what is
 * saved, red/`Unsaved` when the live layout has drifted from it.
 *
 * Duplicate means the same thing on every row — a copy of what is SAVED there,
 * leaving the live layout alone. Only save-as reads the live layout, and only
 * `+` in the header creates from it.
 */
function LayoutRow({
  layout,
  projectLabel,
  isCurrent,
  dirty,
  loadable,
  savable,
  confirmBeforeLoad,
  overwrites,
  onLoad,
  onRename,
  onDelete,
  onSaveAs,
  onDuplicate,
}: {
  layout: SavedLayout;
  /** The owning project's name, or null for a profile-wide layout. */
  projectLabel: string | null;
  isCurrent: boolean;
  /** Whether the LIVE layout has drifted from the layout it derives from. */
  dirty: boolean;
  /** False while the layout state is still loading (nothing to load into yet). */
  loadable: boolean;
  /** False when there is no single live layout to save (the dashboard, project mode). */
  savable: boolean;
  /** Loading would discard unsaved layout changes — confirm first. */
  confirmBeforeLoad: boolean;
  /** True when a save-as from this row writes THIS row (rather than a namesake). */
  overwrites: boolean;
  onLoad: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSaveAs: () => void;
  onDuplicate: (name: string) => void;
}) {
  const [confirming, setConfirming] = useState<'load' | 'delete' | 'save' | null>(null);
  const [editing, setEditing] = useState<'rename' | 'duplicate' | null>(null);
  const [nameDraft, setNameDraft] = useState(layout.name);

  const requestLoad = () => {
    if (!loadable || editing !== null) return;
    if (confirmBeforeLoad && confirming !== 'load') {
      setConfirming('load');
      return;
    }
    setConfirming(null);
    onLoad();
  };
  const startEditing = (mode: 'rename' | 'duplicate') => {
    setConfirming(null);
    setNameDraft(mode === 'rename' ? layout.name : `${layout.name} copy`);
    setEditing(mode);
  };
  // Save-as on the current layout is just Save — there is nothing to weigh up.
  const requestSave = () => {
    if (isCurrent) {
      onSaveAs();
      return;
    }
    setConfirming('save');
  };

  const state = isCurrent ? (dirty ? 'unsaved' : 'active') : null;

  return (
    <div
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input')) return;
        requestLoad();
      }}
      className={cn(
        'rounded-md px-3 py-2.5 transition-colors',
        loadable && 'cursor-pointer hover:bg-surface',
      )}
    >
      {editing !== null ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const name = nameDraft.trim();
            if (name) {
              if (editing === 'rename') {
                if (name !== layout.name) onRename(name);
              } else onDuplicate(name);
            }
            setEditing(null);
          }}
        >
          <Input
            autoFocus
            value={nameDraft}
            spellCheck={false}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setEditing(null);
            }}
            className="h-7 flex-1 text-sm"
          />
          <Button size="sm" type="submit" disabled={!nameDraft.trim()}>
            {editing === 'rename' ? 'Rename' : 'Save'}
          </Button>
        </form>
      ) : (
        <p
          className={cn(
            'flex items-baseline gap-2 text-sm font-medium',
            state === 'active'
              ? 'text-success'
              : state === 'unsaved'
                ? 'text-interrupted'
                : 'text-fg',
          )}
        >
          {layout.name}
          {state !== null && (
            <span className="text-2xs font-normal">
              {state === 'active' ? 'Active' : 'Unsaved'}
            </span>
          )}
        </p>
      )}

      {confirming === 'save' ? (
        <InlineConfirm
          // A row from another scope cannot be written in place (scope is fixed
          // at creation), so say what will actually happen.
          question={
            overwrites
              ? `Overwrite “${layout.name}” with the current layout?`
              : `Save the current layout as “${layout.name}” here?`
          }
          verb={overwrites ? 'Overwrite' : 'Save'}
          onConfirm={() => {
            setConfirming(null);
            onSaveAs();
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : confirming === 'delete' ? (
        <InlineConfirm
          question="Delete this layout? This can’t be undone."
          verb="Delete"
          onConfirm={() => {
            setConfirming(null);
            onDelete();
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : confirming === 'load' ? (
        <InlineConfirm
          question="Loading discards unsaved layout changes."
          verb="Load"
          onConfirm={requestLoad}
          onCancel={() => setConfirming(null)}
        />
      ) : (
        <div className="mt-2 flex items-center gap-1.5">
          {projectLabel !== null && (
            <span className="text-2xs uppercase tracking-wide text-fg-muted">{projectLabel}</span>
          )}
          {/* Same order as a Scratchpad row's tools: act, copy, edit, delete. */}
          <div className="ml-auto flex items-center gap-1">
            {savable && (
              <>
                <RowAction
                  icon={Save}
                  label={isCurrent ? 'Save' : `Save the current layout as “${layout.name}”`}
                  onClick={requestSave}
                />
                <RowAction
                  icon={Copy}
                  label="Duplicate"
                  onClick={() => startEditing('duplicate')}
                />
              </>
            )}
            <RowAction icon={Pencil} label="Rename" onClick={() => startEditing('rename')} />
            <RowAction icon={Trash2} label="Delete" onClick={() => setConfirming('delete')} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The popover's one inline confirm shape (HUMANS.md: no modal, no boxes). */
function InlineConfirm({
  question,
  verb,
  onConfirm,
  onCancel,
}: {
  question: string;
  verb: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-3">
      <span className="text-2xs text-fg-muted">{question}</span>
      <button
        type="button"
        onClick={onConfirm}
        className="text-2xs font-medium text-interrupted transition-colors hover:underline"
      >
        {verb}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-2xs text-fg-muted transition-colors hover:text-fg"
      >
        Cancel
      </button>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full px-2 py-0.5 text-2xs transition-colors',
        active ? 'bg-action text-action-ink' : 'bg-surface text-fg-secondary hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function RowAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="rounded-md p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
        >
          <Icon className="size-3.5" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

import { z } from 'zod';
import { isoTimestamp, rowId, sessionId } from '../common.js';
import { compilationModeSchema, compilationProviderIdSchema } from '../compilation.js';

/**
 * An open tab in the centre editor zone. `kind` distinguishes a plain file
 * editor from a worktree diff or a commit-file diff; it is optional so
 * pre-existing snapshots (which only ever stored files) round-trip untouched
 * and read back as files. `sha` is set only for `commit` tabs (the commit the
 * file diff belongs to).
 */
/**
 * The `session` an `untitled` tab carries (protocol 10.3): untitled drafts
 * are worktree-agnostic, so no real session applies — the nil uuid keeps the
 * field valid while every session lookup misses on purpose. `path` holds the
 * draft's name in the profile's untitled store (SPEC §8).
 */
export const UNTITLED_SESSION = '00000000-0000-0000-0000-000000000000';

export const editorTabRefSchema = z.object({
  session: sessionId,
  path: z.string(),
  kind: z.enum(['file', 'diff', 'commit', 'external', 'untitled']).optional(),
  sha: z.string().optional(),
  /** Index comparison shown by a source-control diff tab (protocol 15.3). */
  git_area: z.enum(['staged', 'unstaged']).optional(),
  /**
   * The absolute root `path` is relative to, and part of the tab's identity.
   * Set for `external` tabs (protocol 10.2) — the browse root the explorer's
   * parent-navigation opened the file under; external tabs are full editors
   * since 10.4 — and, since 12.4, for `diff`/`commit`/`file` tabs opened
   * against a DIRECTORY target, where it is the `?root=` their requests carry
   * (SPEC §8). Absent for an ordinary worktree tab, whose session names the
   * root by itself.
   */
  root: z.string().optional(),
  /**
   * How a `file` tab renders: Monaco (`source`, the default when absent), a
   * rendered `preview`, or a following preview: `linked` retargets to the most
   * recently active renderable tab in its layout tree, while `locked` also
   * mirrors that driver's normalised vertical scroll position (SPEC §8).
   * Meaningful only for previewable types (markdown, HTML). The ordinary
   * source/preview choice is not part of tab identity; each following mode is
   * a distinct stable slot whose identity does not change when it retargets.
   */
  view: z.enum(['source', 'preview', 'linked', 'locked']).optional(),
  /** Compile mode for a provider-backed source; absent means on-demand. */
  compile_mode: compilationModeSchema.optional(),
  /** Provider that generated an otherwise ordinary file tab (for owned viewers/navigation). */
  generated_by: compilationProviderIdSchema.optional(),
});
export type EditorTabRef = z.infer<typeof editorTabRefSchema>;

/**
 * A tab in the tiling layout (SPEC §8): either an editor tab (the same
 * `editorTabRefSchema` the flat `editor_tabs` list uses) or a terminal bound to
 * a session. The discriminant `type` keeps the two apart in one array.
 */
export const tabRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('editor'), tab: editorTabRefSchema }),
  z.object({ type: z.literal('terminal'), session: sessionId }),
]);
export type TabRef = z.infer<typeof tabRefSchema>;

/** A leaf pane: an ordered list of tabs and the key of the active one. */
export interface LayoutLeaf {
  kind: 'leaf';
  id: string;
  tabs: TabRef[];
  /** `tabRefKey` of the active tab; null only for an empty leaf. */
  activeKey: string | null;
  /**
   * `tabRefKey` of this pane's single ephemeral "preview" tab (VSCode-style):
   * a single-click open lands here and the NEXT single-click replaces it, until
   * a double-click promotes it to a permanent tab (`previewKey` → null). Optional
   * so pre-existing snapshots round-trip as having no preview tab.
   */
  previewKey?: string | null;
}

/** A split: a row (side-by-side) or column (stacked) of child nodes with relative sizes. */
export interface LayoutSplit {
  kind: 'split';
  id: string;
  direction: 'row' | 'col';
  children: LayoutNode[];
  /** Relative weights, one per child (`sizes.length === children.length`). */
  sizes: number[];
}

/** The recursive tiling tree (SPEC §8): a `LayoutSplit` of nodes, or a `LayoutLeaf`. */
export type LayoutNode = LayoutLeaf | LayoutSplit;

const layoutLeafSchema = z.object({
  kind: z.literal('leaf'),
  id: z.string(),
  tabs: z.array(tabRefSchema).default([]),
  activeKey: z.string().nullable().default(null),
  previewKey: z.string().nullable().default(null),
});

// Recursive schema: the split branch references `layoutNodeSchema` inside a
// `z.lazy` callback (evaluated at parse time, after this const is assigned), so
// there is no initialisation-order hazard.
export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    layoutLeafSchema,
    z.object({
      kind: z.literal('split'),
      id: z.string(),
      direction: z.enum(['row', 'col']),
      children: z.array(layoutNodeSchema),
      sizes: z.array(z.number()),
    }),
  ]),
);

/**
 * One project's slice of the workspace when the client's project-based layout
 * is on (11.2, SPEC §11): its own tiling tree and URL-bound session, keyed by
 * project id in `project_layouts`. Loose for the same forward-compatibility
 * reason as the snapshot itself.
 */
export const projectLayoutSchema = z.looseObject({
  layout_tree: layoutNodeSchema.nullable().default(null),
  active_session: sessionId.nullable().default(null),
  /**
   * The saved layout (12.2, `/api/layouts` row id) this slice was last loaded
   * from or saved as — the popover shows the layout as named while it matches
   * and "unsaved changes" once the tree drifts. Null: an unnamed layout.
   */
  layout_ref: rowId.nullable().default(null),
});
export type ProjectLayout = z.infer<typeof projectLayoutSchema>;

/**
 * Per-profile workspace snapshot (SPEC §11 reload semantics): the editor area
 * is shared across a profile's projects, so the snapshot is keyed by profile
 * alone. Loose so later phases can extend the shape without a migration;
 * unknown keys round-trip untouched. `editor_tabs` is carried from day one
 * even though the editor itself arrives in Phase 3.
 */
export const uiStateSnapshotSchema = z.looseObject({
  session_tabs: z.array(sessionId).default([]),
  active_session: sessionId.nullable().default(null),
  editor_tabs: z.array(editorTabRefSchema).default([]),
  layout: z.looseObject({}).default({}),
  explorer_pin: sessionId.nullable().default(null),
  /** The editor tab focused when the client last had one open. */
  active_editor_tab: editorTabRefSchema.nullable().default(null),
  /** Whether the file explorer panel is expanded. */
  explorer_open: z.boolean().default(true),
  /**
   * Which navigator the left sidebar is showing. `changes` is the unified
   * diff+history view and `search` is content/filename search (SPEC §8); the
   * legacy `diff`/`history` values are still accepted so pre-unification
   * snapshots round-trip (the web maps them onto `changes`).
   */
  sidebar_mode: z
    .enum(['files', 'diff', 'history', 'changes', 'search', 'worktrees'])
    .default('files'),
  /** Whether the left navigator is collapsed to a slim rail. */
  sidebar_collapsed: z.boolean().default(false),
  /** Whether the right sessions sidebar is collapsed to a slim rail. */
  sessions_collapsed: z.boolean().default(false),
  /**
   * RETIRED (the Scratchpad moved to a top-bar popover — SPEC §11): nothing
   * reads or writes this any more. The key stays in the schema, optional and
   * defaultless, so snapshots from older clients round-trip byte-faithfully
   * without a major protocol bump (the old default-injection made every PUT
   * grow the field, which nothing wanted).
   */
  right_panel: z.enum(['sessions', 'scratchpad']).optional(),
  /**
   * User-chosen order of the sessions sidebar (session ids). Sessions not
   * listed here (newly created ones) sort to the top; the list is otherwise
   * drag-reorderable and this persists it (SPEC §8).
   */
  session_order: z.array(sessionId).default([]),
  /**
   * The tiling layout tree (SPEC §8): the source of truth for which tabs are
   * open and where. Null on legacy snapshots — the web rebuilds an equivalent
   * tree from `editor_tabs`/`session_tabs`/`layout` on first load.
   */
  layout_tree: layoutNodeSchema.nullable().default(null),
  /**
   * Which keying the snapshot's layouts were last maintained under (11.2,
   * SPEC §11): absent or `profile` means the top-level `layout_tree`/
   * `active_session` are live; `project` means `project_layouts` is. The web
   * transitions between the two when the client's project-based layout
   * setting flips (split on the way in, union on the way out) and stamps the
   * mode it left the snapshot in, so a snapshot toggled elsewhere converts
   * exactly once.
   */
  layout_mode: z.enum(['profile', 'project']).optional(),
  /**
   * Per-project layouts (11.2, SPEC §11), live only while `layout_mode` is
   * `project`: project id → that project's tiling tree and bound session.
   */
  project_layouts: z.record(z.string(), projectLayoutSchema).default({}),
  /**
   * The saved layout (12.2) the top-level profile-wide layout was last loaded
   * from or saved as, live only while `layout_mode` is absent or `profile` —
   * the per-project counterpart lives on each `project_layouts` slice.
   */
  layout_ref: rowId.nullable().default(null),
});
export type UiStateSnapshot = z.infer<typeof uiStateSnapshotSchema>;

export const putUiStateRequestSchema = z.object({
  ui_state: uiStateSnapshotSchema,
});

export const uiStateResponseSchema = z.object({
  ui_state: uiStateSnapshotSchema,
  updated_at: isoTimestamp,
});
export type UiStateResponse = z.infer<typeof uiStateResponseSchema>;

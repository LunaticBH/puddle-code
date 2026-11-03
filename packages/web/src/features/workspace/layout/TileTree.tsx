import { Fragment, useMemo } from 'react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import type {
  CompilationMode,
  CompilationProvider,
  CompilationFileTarget,
  LatexSynctexResponse,
  LayoutLeaf,
  LayoutNode,
  Session,
  TabRef,
} from '@puddle/shared';
import { LazyModelRefcount } from '../../editor/lazy-editor-parts';
import type { HeldBuffer } from '../../editor/buffers/ModelRefcount';
import { tabKind, type EditorTab, type EditorView } from '../../editor/tabs/editor-tabs';
import type { EditorPosition, RevealTarget } from '../editor-context';
import { flattenTabs, type DropEdge } from './layout-tree';
import { PaneLeaf } from '../panes/PaneLeaf';

const SEP = 'bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent';

export interface TileHandlers {
  sessions: Session[];
  reveal: RevealTarget | null;
  onActivateTab: (leafId: string, ref: TabRef) => void;
  onCloseTab: (leafId: string, ref: TabRef) => void;
  onPromoteTab: (ref: TabRef) => void;
  onArchived: (session: string) => void;
  onFocusLeaf: (leafId: string) => void;
  onScrollDrive: (leafId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  /** A sidebar drag (file row / session) dropped on a pane — open + position. */
  onDropTab: (leafId: string, ref: TabRef, edge: DropEdge) => void;
  /**
   * Set a previewable editor tab's source/preview/following view (SPEC §8) in
   * THAT pane only, so one file can be open as source and preview at once.
   */
  onSetTabView: (leafId: string, ref: TabRef, view: EditorView) => void;
  /** Extensions claimed by available daemon compilation providers. */
  compilableExtensions: ReadonlySet<string>;
  compilationProviders: readonly CompilationProvider[];
  /** Browser-local identity of the source currently running, when any. */
  compilationRunningKeys: ReadonlySet<string>;
  onRunCompilation: (leafId: string, tab: EditorTab, executedCopy?: boolean) => void;
  onSetCompilationMode: (tab: EditorTab, mode: CompilationMode) => void;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;
  onRevealPreviewSource: (leafId: string, tab: EditorTab, position: EditorPosition) => void;
  onRevealCompiledSource: (leafId: string, target: LatexSynctexResponse) => void;
  /** Double-click on a strip's blank tail: open a fresh untitled file there. */
  onNewUntitled: (leaf: LayoutLeaf) => void;
  /** Reveal a path-backed editor tab in Files. */
  onRevealFile: (tab: EditorTab) => void;
  /** Rename a path-backed editor tab through its inline chip editor. */
  onRenameFile: (tab: EditorTab, newName: string) => Promise<boolean>;
  focusedLeafId: string;
  scrollDriverLeafId: string;
  /** Browser-local scroll-following channel for this layout scope. */
  scrollChannel: string;
}

/**
 * Renders the tiling tree (SPEC §8): each `Split` becomes its own nested
 * react-resizable-panels `Group` carrying its own `sizes` (so the exact
 * key-count guard is satisfied natively — no flat layout map), each `Leaf` a
 * `PaneLeaf`. The `LazyModelRefcount` at the root keeps every open editor
 * model alive across the whole tree (lazy so a terminal-only workspace loads
 * no Monaco).
 */
export function TileTree({ tree, ...handlers }: { tree: LayoutNode } & TileHandlers) {
  const buffers = useMemo<HeldBuffer[]>(() => {
    const seen = new Set<string>();
    const out: HeldBuffer[] = [];
    for (const t of flattenTabs(tree)) {
      // Commit and untitled tabs use private/profile-owned models. External
      // files are full editors and therefore retain a root-qualified buffer,
      // exactly like file/diff tabs retain their worktree buffer.
      if (t.type !== 'editor' || !['file', 'diff', 'external'].includes(tabKind(t.tab))) continue;
      const k = `${t.tab.session}\0${t.tab.path}\0${t.tab.root ?? ''}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ session: t.tab.session, path: t.tab.path, root: t.tab.root });
      }
    }
    return out;
  }, [tree]);

  return (
    <>
      {buffers.length > 0 && <LazyModelRefcount buffers={buffers} />}
      <TileNode node={tree} {...handlers} />
    </>
  );
}

function TileNode({ node, ...handlers }: { node: LayoutNode } & TileHandlers) {
  if (node.kind === 'leaf') {
    return (
      <PaneLeaf
        leaf={node}
        sessions={handlers.sessions}
        reveal={handlers.reveal}
        onActivateTab={handlers.onActivateTab}
        onCloseTab={handlers.onCloseTab}
        onPromoteTab={handlers.onPromoteTab}
        onArchived={handlers.onArchived}
        onFocusLeaf={handlers.onFocusLeaf}
        onScrollDrive={handlers.onScrollDrive}
        onDropTab={handlers.onDropTab}
        onSetTabView={handlers.onSetTabView}
        compilableExtensions={handlers.compilableExtensions}
        compilationProviders={handlers.compilationProviders}
        compilationRunningKeys={handlers.compilationRunningKeys}
        onRunCompilation={handlers.onRunCompilation}
        onSetCompilationMode={handlers.onSetCompilationMode}
        onOpenCompilationSettings={handlers.onOpenCompilationSettings}
        onRevealPreviewSource={handlers.onRevealPreviewSource}
        onRevealCompiledSource={handlers.onRevealCompiledSource}
        onNewUntitled={handlers.onNewUntitled}
        onRevealFile={handlers.onRevealFile}
        onRenameFile={handlers.onRenameFile}
        focused={node.id === handlers.focusedLeafId}
        scrollDriver={node.id === handlers.scrollDriverLeafId}
        scrollChannel={handlers.scrollChannel}
      />
    );
  }

  const orientation = node.direction === 'row' ? 'horizontal' : 'vertical';
  const defaultLayout: Layout = Object.fromEntries(
    node.children.map((c, i) => [c.id, node.sizes[i] ?? 100 / node.children.length]),
  );

  return (
    <Group
      key={node.id}
      orientation={orientation}
      className="size-full"
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout) =>
        handlers.onResize(
          node.id,
          node.children.map((c) => layout[c.id] ?? 0),
        )
      }
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <Separator className={orientation === 'horizontal' ? `w-px ${SEP}` : `h-px ${SEP}`} />
          )}
          <Panel id={child.id} minSize={64}>
            <TileNode node={child} {...handlers} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

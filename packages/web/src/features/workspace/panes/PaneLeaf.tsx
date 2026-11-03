import { compilationSourceKey, sourceExtension } from '../../editor/compilation/compilation-kind';
import { useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type {
  CompilationMode,
  CompilationProvider,
  CompilationFileTarget,
  LatexSynctexResponse,
  LayoutLeaf,
  Session,
  TabRef,
} from '@puddle/shared';
import { PuddleGlyph } from '../../../components/puddle-glyph';
import { openCommandPalette } from '../../../lib/navigation/command-palette';
import { useHotkeyLabel } from '../../../lib/navigation/hotkeys';
import { cn } from '../../../lib/utils';
import { LazyPaneEditorBody } from '../../editor/lazy-editor-parts';
import type { EditorTab, EditorView } from '../../editor/tabs/editor-tabs';
import { tabKind } from '../../editor/tabs/editor-tabs';
import { TabViewStateContext } from '../../editor/tabs/view-state-context';
import { previewKind } from '../../editor/previews/preview-kind';
import type { EditorPosition, RevealTarget } from '../editor-context';
import { useKeepAliveSlot } from '../keep-alive';
import { EnvStrip } from '../../env/EnvStrip';
import { PortsStrip } from '../../ports/PortsStrip';
import { zoneForPointer } from '../layout/layout-dnd';
import { PaneSessionOverlay } from './PaneSessionOverlay';
import { PaneTabStrip } from './PaneTabStrip';
import { tabRefKey, type DropEdge } from '../layout/layout-tree';
import { decodeTabTransfer, hasTabTransfer, TAB_MIME } from '../tabs/tab-transfer';
import { useActiveDragRef, useDropIndicator } from '../layout/TilingDnd';
import { paneInteractionIntent } from './pane-interaction';

/**
 * One leaf pane (SPEC §8): its tab strip over a body that shows the active tab —
 * a terminal (its kept-alive DOM adopted into the slot) or an editor body (per
 * pane, sharing the refcounted model). Mousedown focuses the pane so opens and
 * keyboard actions target it. An empty leaf is the workspace's empty state.
 */
export function PaneLeaf({
  leaf,
  sessions,
  reveal,
  onActivateTab,
  onCloseTab,
  onPromoteTab,
  onArchived,
  onFocusLeaf,
  onScrollDrive,
  onDropTab,
  onSetTabView,
  compilableExtensions,
  compilationProviders,
  compilationRunningKeys,
  onRunCompilation,
  onSetCompilationMode,
  onOpenCompilationSettings,
  onRevealPreviewSource,
  onRevealCompiledSource,
  onNewUntitled,
  onRevealFile,
  onRenameFile,
  focused,
  scrollDriver,
  scrollChannel,
}: {
  leaf: LayoutLeaf;
  sessions: Session[];
  reveal: RevealTarget | null;
  onActivateTab: (leafId: string, ref: TabRef) => void;
  onCloseTab: (leafId: string, ref: TabRef) => void;
  onPromoteTab: (ref: TabRef) => void;
  onArchived: (session: string) => void;
  onFocusLeaf: (leafId: string) => void;
  /** Make this pane the scroll-following driver without changing pane focus. */
  onScrollDrive: (leafId: string) => void;
  /** A sidebar drag (file row / session) dropped on this pane — open + position. */
  onDropTab: (leafId: string, ref: TabRef, edge: DropEdge) => void;
  /** Set THIS pane's previewable editor tab's rendered/following mode (SPEC §8). */
  onSetTabView: (leafId: string, ref: TabRef, view: EditorView) => void;
  compilableExtensions: ReadonlySet<string>;
  compilationProviders: readonly CompilationProvider[];
  compilationRunningKeys: ReadonlySet<string>;
  onRunCompilation: (leafId: string, tab: EditorTab, executedCopy?: boolean) => void;
  onSetCompilationMode: (tab: EditorTab, mode: CompilationMode) => void;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;
  /** Reveal a following preview click in its associated ordinary source tab. */
  onRevealPreviewSource: (leafId: string, tab: EditorTab, position: EditorPosition) => void;
  /** Reveal an inverse SyncTeX result in an ordinary source tab. */
  onRevealCompiledSource: (leafId: string, target: LatexSynctexResponse) => void;
  /** Double-click on the strip's blank tail: open a fresh untitled file here. */
  onNewUntitled: (leaf: LayoutLeaf) => void;
  /** Reveal a path-backed editor tab in Files. */
  onRevealFile: (tab: EditorTab) => void;
  /** Rename a path-backed editor tab through its inline chip editor. */
  onRenameFile: (tab: EditorTab, newName: string) => Promise<boolean>;
  /** The workspace's logical focus, independent of DOM focus inside Monaco. */
  focused: boolean;
  /** Whether this pane currently owns the independent scroll-following focus. */
  scrollDriver: boolean;
  /** Browser-local scroll-following channel for this layout scope. */
  scrollChannel: string;
}) {
  const activeRef = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey) ?? null;
  const terminalKey = activeRef?.type === 'terminal' ? tabRefKey(activeRef) : null;
  const shownSession =
    activeRef?.type === 'terminal'
      ? (sessions.find((s) => s.id === activeRef.session) ?? null)
      : null;
  const slotRef = useKeepAliveSlot(terminalKey);
  const { setNodeRef } = useDroppable({ id: `leaf:${leaf.id}` });
  const indicator = useDropIndicator();
  const activeDragRef = useActiveDragRef();
  const paletteKey = useHotkeyLabel('palette.toggle');
  const activeEditor = activeRef?.type === 'editor' ? activeRef.tab : null;
  const activeView = activeEditor?.view ?? 'source';
  const renderableEditor =
    activeEditor !== null &&
    (tabKind(activeEditor) === 'file' || tabKind(activeEditor) === 'external') &&
    previewKind(activeEditor.path) !== null;
  // Scroll ownership is deliberately independent of logical pane focus: a
  // wheel gesture over a locked render may drive its source editor without
  // changing where the next tab opens. Other locked previews AND source tabs
  // receive the driver's proportional position without a feedback loop.
  const drivesScroll = scrollDriver && renderableEditor && activeView !== 'linked';
  const scrollReceiver =
    !drivesScroll && (activeView === 'locked' || (renderableEditor && activeView === 'source'));

  const interact = (kind: 'press' | 'scroll') => {
    const intent = paneInteractionIntent(kind, renderableEditor, activeView);
    if (intent.focus) onFocusLeaf(leaf.id);
    if (intent.driveScroll) onScrollDrive(leaf.id);
  };

  // Clicking INTO the pane body activates the shown tab, via a NATIVE capture
  // listener — not React's onMouseDownCapture. An adopted terminal's DOM was
  // rendered by the keep-alive host (a portal) and only MOVED here, so React's
  // synthetic events route through the HOST's component tree and never reach
  // this pane's React handlers; the editor is a normal child, which is why
  // editor clicks worked while terminal clicks did nothing. Native capture
  // follows the real DOM, adopted children included.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const activateShownRef = useRef<() => void>(() => undefined);
  activateShownRef.current = () => {
    if (activeRef) onActivateTab(leaf.id, activeRef);
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onDown = () => activateShownRef.current();
    el.addEventListener('mousedown', onDown, true);
    return () => el.removeEventListener('mousedown', onDown, true);
  }, []);

  // Native-DnD drop zone for sidebar drags (tab drags between panes ride
  // dnd-kit and the context indicator instead; the two never fire together).
  //
  // Bound as NATIVE CAPTURE listeners on the body element, not as React props:
  // both things a pane can show hid these events from React's synthetic tree.
  // An adopted terminal's DOM was rendered by the keep-alive host, so its drag
  // events route through THAT component tree (the same reason the mousedown
  // above is native), and Monaco stops `drop` on its own node before it can
  // reach React's root listener. Either way the highlight armed on the way in
  // had nothing left to disarm it and no tab ever opened — a blue overlay stuck
  // over the pane (fixed 2026-08-04). Capture on this element follows the real
  // DOM, adopted children included, and runs ahead of any descendant's handler.
  const [nativeZone, setNativeZone] = useState<DropEdge | null>(null);
  const dropTabRef = useRef(onDropTab);
  dropTabRef.current = onDropTab;
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const carriesTab = (e: DragEvent) =>
      e.dataTransfer !== null && hasTabTransfer(e.dataTransfer.types);
    const zoneOf = (e: DragEvent): DropEdge => {
      const r = el.getBoundingClientRect();
      return zoneForPointer(
        { width: r.width, height: r.height },
        { x: e.clientX - r.left, y: e.clientY - r.top },
      );
    };
    const onOver = (e: DragEvent) => {
      if (!carriesTab(e)) return;
      e.preventDefault();
      e.stopPropagation(); // the pane owns this gesture, not Monaco or xterm
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      setNativeZone(zoneOf(e));
    };
    const onLeave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setNativeZone(null);
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesTab(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setNativeZone(null);
      const ref = decodeTabTransfer(e.dataTransfer?.getData(TAB_MIME) ?? '');
      if (ref) dropTabRef.current(leaf.id, ref, zoneOf(e));
    };
    // Whatever ends the drag clears the highlight: released over another pane,
    // over no drop target at all, or cancelled with Esc, none of which reaches
    // the drop/leave handlers above. `dragend` fires on the source for every
    // outcome, so it is the one signal that always arrives.
    const onEnd = () => setNativeZone(null);
    el.addEventListener('dragenter', onOver, true);
    el.addEventListener('dragover', onOver, true);
    el.addEventListener('dragleave', onLeave, true);
    el.addEventListener('drop', onDrop, true);
    window.addEventListener('dragend', onEnd);
    return () => {
      el.removeEventListener('dragenter', onOver, true);
      el.removeEventListener('dragover', onOver, true);
      el.removeEventListener('dragleave', onLeave, true);
      el.removeEventListener('drop', onDrop, true);
      window.removeEventListener('dragend', onEnd);
    };
  }, [leaf.id]);

  return (
    <div
      className="flex h-full flex-col bg-ground"
      onMouseDownCapture={() => interact('press')}
      // A wheel/trackpad gesture need not be preceded by a click. Promote an
      // eligible receiver to scroll driver, but leave logical pane focus alone.
      onWheelCapture={() => interact('scroll')}
    >
      {/* No tabs → no strip: an empty pane reserves no blank bar (HUMANS.md). */}
      {leaf.tabs.length > 0 && (
        <PaneTabStrip
          leaf={leaf}
          sessions={sessions}
          onActivate={(ref) => onActivateTab(leaf.id, ref)}
          onClose={(ref) => onCloseTab(leaf.id, ref)}
          onPromote={onPromoteTab}
          onArchived={onArchived}
          onSetView={(ref, view) => onSetTabView(leaf.id, ref, view)}
          compilableExtensions={compilableExtensions}
          compilationProviders={compilationProviders}
          compilationRunningKeys={compilationRunningKeys}
          onRunCompilation={(tab) => onRunCompilation(leaf.id, tab)}
          onSetCompilationMode={onSetCompilationMode}
          onOpenCompilationSettings={onOpenCompilationSettings}
          onNewFile={() => onNewUntitled(leaf)}
          onRevealFile={onRevealFile}
          onRenameFile={onRenameFile}
        />
      )}
      <div
        ref={(el) => {
          bodyRef.current = el;
          setNodeRef(el);
        }}
        className="relative min-h-0 flex-1"
      >
        {activeRef?.type === 'editor' && (
          <div className="absolute inset-0">
            <TabViewStateContext.Provider
              value={JSON.stringify([scrollChannel, leaf.id, tabRefKey(activeRef)])}
            >
              <LazyPaneEditorBody
                tab={activeRef.tab}
                onRunCompilation={
                  compilableExtensions.has(sourceExtension(activeRef.tab.path) ?? '')
                    ? (copy) => onRunCompilation(leaf.id, activeRef.tab, copy)
                    : undefined
                }
                compilationRunning={compilationRunningKeys.has(
                  compilationSourceKey(
                    activeRef.tab.session,
                    activeRef.tab.path,
                    activeRef.tab.root,
                  ),
                )}
                reveal={reveal}
                focused={focused}
                scrollDriver={drivesScroll}
                scrollReceiver={scrollReceiver}
                scrollChannel={scrollChannel}
                onRevealSource={
                  activeEditor?.view === 'linked' || activeEditor?.view === 'locked'
                    ? (position) => onRevealPreviewSource(leaf.id, activeEditor, position)
                    : undefined
                }
                onRevealCompiledSource={(target) => onRevealCompiledSource(leaf.id, target)}
              />
            </TabViewStateContext.Provider>
          </div>
        )}
        {/* The keep-alive slot is always mounted (stable ref) so a terminal
            container can be adopted into it; hidden when no terminal is active. */}
        <div
          ref={slotRef}
          className={cn('absolute inset-0 py-1 pl-4 pr-2', !terminalKey && 'hidden')}
        />
        {/* Embedded browsing contexts consume pointer events before dnd-kit's
            document-level sensor can see them. Cover every pane body for the
            duration of a strip drag so HTML iframes remain
            ordinary move/split destinations. The registered leaf beneath this
            transparent shield still supplies collision geometry. */}
        {activeDragRef && (
          <div className="absolute inset-0 z-10 cursor-grabbing" aria-hidden="true" />
        )}
        {/* A strip insertion (index set) is marked by the strip's caret instead
            of the pane-body highlight. */}
        {indicator?.leafId === leaf.id && indicator.index === undefined && (
          <DropZoneOverlay zone={indicator.zone} />
        )}
        {nativeZone !== null && <DropZoneOverlay zone={nativeZone} />}
        {/* The shown session's resume control, inside ITS pane. */}
        {shownSession && <PaneSessionOverlay session={shownSession} />}
        {!activeRef && (
          <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
            <PuddleGlyph className="size-24 text-fg-muted/40" />
            <button
              type="button"
              onClick={openCommandPalette}
              className="rounded-md bg-elevated px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:bg-border hover:text-fg-secondary"
            >
              {paletteKey}
            </button>
          </div>
        )}
      </div>
      {/* The shown session's captured env and ports, IN FLOW below the body —
          never overlays, so nothing sits over the terminal; the body shrinks
          to make room and each strip vanishes (with its row's height) when
          it has nothing to show. The terminal slot supplies the top spacing;
          this wrapper matches it below and uses that same single gap between
          rows. An empty wrapper must reserve no space. */}
      <div className="flex flex-col gap-1 pb-1 empty:hidden">
        {shownSession && <EnvStrip sessionId={shownSession.id} status={shownSession.status} />}
        {shownSession && <PortsStrip sessionId={shownSession.id} status={shownSession.status} />}
      </div>
    </div>
  );
}

const ZONE_POS: Record<DropEdge, string> = {
  center: 'inset-0',
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  top: 'inset-x-0 top-0 h-1/2',
  bottom: 'inset-x-0 bottom-0 h-1/2',
};

/** Translucent highlight of the region a drop will land in (SPEC §8). */
function DropZoneOverlay({ zone }: { zone: DropEdge }) {
  return <div className={cn('pointer-events-none absolute z-20 bg-accent/20', ZONE_POS[zone])} />;
}

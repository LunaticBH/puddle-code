import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { LayoutNode } from '@puddle/shared';
// Type-only: keep-alive is eager chrome and must not pull the xterm chunk in.
import type { FileLinkTarget } from '../terminal/links/file-links';
import { LazyTerminal } from '../terminal/LazyTerminal';
import { allLeaves } from './layout/layout-tree';

/**
 * Terminal keep-alive for the tiling layout (SPEC §8), the one load-bearing
 * piece of the rewrite. A terminal's xterm + PTY attachment are bound to the
 * `Terminal` component's lifecycle, so moving it to a different React parent (a
 * different pane) would remount it and churn the attachment. Instead every open
 * terminal is rendered ONCE — via `createPortal` into a stable, manually-created
 * container `<div>` that lives in a hidden parking area — and a pane "adopts"
 * that container into its body with `appendChild` when the terminal is its
 * active tab. Moving the container relocates the DOM without React ever
 * reconciling a remount; React only manages the terminal's content INSIDE the
 * stable container, so its deletion always targets that container (never a
 * pane), sidestepping the adopt/unmount race a naive portal-with-changing-target
 * would hit. Do NOT "simplify" this to a portal whose target is a pane element.
 *
 * Which terminals are mounted is the union of the live tree's and `parked` — the
 * ones other projects' layouts hold open under project-based layout (SPEC §11).
 * A terminal only ever detaches from its PTY (`paused`); it unmounts when it is
 * closed everywhere, not when you look at another project.
 */

interface KeepAliveCtx {
  parkingRef: React.RefObject<HTMLDivElement | null>;
  containers: Map<string, HTMLDivElement>;
  /** A pane slot reporting that it adopted (or returned) a container. */
  setAdopted: (key: string, adopted: boolean) => void;
}

const Ctx = createContext<KeepAliveCtx | null>(null);

export function KeepAliveHost({
  tree,
  parked = [],
  onOpenFile,
  children,
}: {
  tree: LayoutNode;
  /**
   * Sessions to keep mounted although the LIVE tree has no tab for them — the
   * terminals other projects' layouts hold open under project-based layout
   * (SPEC §11). They are never adopted by a pane, so they stay paused; keeping
   * them spares a rebuild-and-replay on every project switch.
   */
  parked?: string[];
  /** A validated terminal link opened in `session`'s terminal (SPEC §7). */
  onOpenFile: (session: string, target: FileLinkTarget) => void;
  children: React.ReactNode;
}) {
  const parkingRef = useRef<HTMLDivElement>(null);
  const containers = useRef<Map<string, HTMLDivElement>>(new Map()).current;

  // Which containers a pane currently shows. A parked terminal stays mounted
  // (scrollback, addons, handlers all survive) but is told to pause via the
  // `paused` prop, so it detaches its PTY viewer and stops parsing output the
  // hidden DOM could never show. The daemon PTY is untouched by this — pausing
  // is purely a viewer-side economy (SPEC §6: viewers are ephemeral).
  const [adopted, setAdoptedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const setAdopted = useCallback((key: string, isAdopted: boolean) => {
    setAdoptedKeys((prev) => {
      if (prev.has(key) === isAdopted) return prev;
      const next = new Set(prev);
      if (isAdopted) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Sorted so the portal list's order — and therefore React's reconciliation of
  // it — doesn't depend on which tree a session came from: a project switch
  // moves sessions between the two sources, and an order that shuffled would
  // remount the very terminals this is keeping alive.
  const parkedKey = [...parked].sort().join(',');
  const sessions = useMemo(() => {
    const set = new Set<string>();
    for (const leaf of allLeaves(tree)) {
      for (const t of leaf.tabs) if (t.type === 'terminal') set.add(t.session);
    }
    for (const session of parkedKey === '' ? [] : parkedKey.split(',')) set.add(session);
    return [...set].sort();
  }, [tree, parkedKey]);

  // A stable container per open terminal, keyed by `term:<session>`. Created
  // detached; parented into the parking area (or left where a pane adopted it).
  const containerFor = (session: string): HTMLDivElement => {
    const key = `term:${session}`;
    let el = containers.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'size-full';
      containers.set(key, el);
    }
    return el;
  };

  useEffect(() => {
    const open = new Set(sessions.map((s) => `term:${s}`));
    for (const s of sessions) {
      const el = containers.get(`term:${s}`);
      if (el && !el.parentElement) parkingRef.current?.appendChild(el);
    }
    // Drop containers for terminals no longer open (their portal has already
    // unmounted its content; the container is now empty and safe to remove).
    for (const [key, el] of [...containers]) {
      if (!open.has(key)) {
        el.remove();
        containers.delete(key);
      }
    }
  }, [sessions, containers]);

  const ctx = useMemo<KeepAliveCtx>(
    () => ({ parkingRef, containers, setAdopted }),
    [containers, setAdopted],
  );

  return (
    <Ctx.Provider value={ctx}>
      <div ref={parkingRef} className="hidden" aria-hidden />
      {sessions.map((session) =>
        createPortal(
          <LazyTerminal
            stream={session}
            paused={!adopted.has(`term:${session}`)}
            onOpenFile={(target) => onOpenFile(session, target)}
          />,
          containerFor(session),
          session,
        ),
      )}
      {children}
    </Ctx.Provider>
  );
}

/**
 * A ref for a pane's body slot: when `key` (a `tabRefKey`) names a kept-alive
 * terminal, its container is `appendChild`-ed into the slot; on change/unmount
 * the container returns to parking (still mounted). Returns a stable ref even
 * when `key` is null or names an editor (nothing is adopted then).
 */
export function useKeepAliveSlot(key: string | null): React.RefObject<HTMLDivElement | null> {
  const ctx = useContext(Ctx);
  const slotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = slotRef.current;
    if (!ctx || !key || !slot) return;
    const container = ctx.containers.get(key);
    if (container) {
      slot.appendChild(container);
      ctx.setAdopted(key, true);
    }
    return () => {
      const parking = ctx.parkingRef.current;
      if (container && parking && container.parentElement === slot) parking.appendChild(container);
      if (container) ctx.setAdopted(key, false);
    };
  }, [ctx, key]);
  return slotRef;
}

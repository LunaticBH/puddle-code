import { useEffect, useState } from 'react';
import { HOME_STREAM } from '@puddle/shared';
import { LazyTerminal } from '../terminal/LazyTerminal';
import { wsManager } from '../../lib/transport/ws';

// The pane survives in-app navigation (module state, not storage): come back
// to the homescreen and it is still there. A reload starts closed — but the
// shell itself lives on the daemon, so the next open reattaches to it (with
// scrollback replay) rather than spawning a second one.
let restoreOpen = false;

/**
 * The homescreen terminal: one plain shell in the daemon host's home
 * directory, for cloning repositories before they become projects (SPEC §11).
 * `open` drives both the pane and the tile's Open/Close label; the daemon
 * reuses the live shell across opens, so toggling never stacks shells.
 */
export function useHomeTerminal(): {
  open: boolean;
  term: string | null;
  toggle: () => void;
  onExit: () => void;
} {
  const [open, setOpen] = useState(restoreOpen);
  const [term, setTerm] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Ask rather than assume: the reply is the live shell's term when one
    // exists (a reopen, another window) and a fresh one otherwise.
    void wsManager.spawnShell(HOME_STREAM).then((t) => {
      if (!cancelled) setTerm(t);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const close = () => {
    restoreOpen = false;
    setOpen(false);
    setTerm(null);
  };

  return {
    open,
    term,
    toggle: () => {
      if (open) {
        if (term) wsManager.killShell(HOME_STREAM, term);
        close();
      } else {
        restoreOpen = true;
        setOpen(true);
      }
    },
    // The shell ended on its own (`exit`, or killed from another window) —
    // just drop the pane; there is nothing left to kill.
    onExit: close,
  };
}

/** The bottom pane: the shell alone on the page ground — no tab heading, no box. */
export function HomeTerminalPane({ term, onExit }: { term: string | null; onExit: () => void }) {
  return (
    // The same column geometry as the projects grid above (`mx-auto max-w-4xl
    // p-6`): padding INSIDE the max-width, so the terminal's edges line up
    // with the tiles' — not with the column's outer edge.
    <div className="h-72 shrink-0 pb-6">
      <div className="mx-auto size-full max-w-4xl px-6">
        {term !== null && <LazyTerminal stream={HOME_STREAM} term={term} onExit={onExit} />}
      </div>
    </div>
  );
}

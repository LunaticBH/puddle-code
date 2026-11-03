import { Play } from 'lucide-react';
import { useNavigate } from 'react-router';
import { liveConversationTarget, toastError } from '../../../lib/transport/errors';
import type { Session } from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import { useSessionAction } from '../../../lib/queries/queries';

const RESUMABLE: Session['status'][] = ['interrupted', 'exited'];

/**
 * The per-pane resume control, overlaid INSIDE the pane at its bottom-right
 * (SPEC §8/§11): a plain Resume button for an interrupted/exited session — no
 * verbose banner, the status dot on the tab already tells the story. Rendered
 * by whichever pane's ACTIVE tab is the session's terminal (agent and
 * plain-terminal sessions alike), so the control sits on the session it
 * belongs to; the old placement at the bottom of the whole workspace read as
 * global and detached from its session. The session's PORTS are deliberately
 * NOT overlaid — they sit in flow below the pane body (PaneLeaf), so nothing
 * covers the terminal. The wrapper is click-transparent — only the button
 * takes the pointer.
 */
export function PaneSessionOverlay({ session }: { session: Session }) {
  const resume = useSessionAction('resume');
  const navigate = useNavigate();
  const resumable =
    RESUMABLE.includes(session.status) &&
    !session.worktree_missing &&
    !session.conversation_missing;
  if (!resumable) return null;
  return (
    <div className="pointer-events-none absolute bottom-2 right-3 z-10">
      <Button
        size="sm"
        className="pointer-events-auto"
        disabled={resume.isPending}
        onClick={() =>
          resume.mutate(session.id, {
            onError: (error) => {
              const target = liveConversationTarget(error);
              if (target) {
                void navigate(`/project/${target.projectId}/session/${target.sessionId}`);
              } else {
                toastError(error);
              }
            },
          })
        }
      >
        <Play />
        Resume
      </Button>
    </div>
  );
}

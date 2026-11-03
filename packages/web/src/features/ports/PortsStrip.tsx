import { toast } from 'sonner';
import type { Session, SessionPort } from '@puddle/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { useHostInfo, useSessionPorts } from '../../lib/queries/queries';
import { sshMode } from '../../lib/transport/ssh-mode';
import { sshForwardCommand } from './ssh-command';
import { openBrowserLink } from './forward-link';
import { toastError } from '../../lib/transport/errors';

const LIVE_STATUSES: Session['status'][] = ['running', 'waiting_input'];

/**
 * Slim mono row of detected listening ports for one session (SPEC §9),
 * rendered IN FLOW at the bottom of that session's pane (PaneLeaf) — never an
 * overlay, so it cannot sit over the terminal, and the pane only ever polls
 * for the session it is showing. Ports stay on one horizontally scrollable
 * line with its scrollbar hidden. Hidden entirely when the session isn't
 * live or has no ports; no refresh control, the hook's 5s poll is the refresh
 * (HUMANS.md minimalism). Each chip opens a menu with the access paths that
 * make sense for this window's mode (the CLI's `?host=` boot param — Phase
 * 6): local mode gets the direct localhost link, SSH mode the tier-2 proxy
 * link; `ssh -L` is always on offer as the manual fallback (SPEC §9).
 */
export function PortsStrip({
  sessionId,
  status,
}: {
  sessionId: string;
  status: Session['status'];
}) {
  const live = LIVE_STATUSES.includes(status);
  const { data } = useSessionPorts(sessionId, live);
  const ports = data?.ports ?? [];

  if (!live || ports.length === 0) return null;

  return (
    <div className="flex min-w-0 items-center gap-2 px-3 text-xs">
      <span className="shrink-0 text-fg-muted">ports</span>
      <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
        <div className="flex w-max items-center gap-1 whitespace-nowrap">
          {ports.map((port) => (
            <PortChip key={port.port} sessionId={sessionId} port={port} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PortChip({ sessionId, port }: { sessionId: string; port: SessionPort }) {
  const host = useHostInfo().data;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="cursor-pointer rounded px-1.5 py-0.5 tabular-nums text-fg-secondary outline-none transition-colors hover:bg-elevated hover:text-fg focus-visible:bg-elevated focus-visible:text-fg"
            >
              {port.port}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {port.command} · pid {port.pid}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {sshMode() === null ? (
          <DropdownMenuItem asChild>
            <a href={`http://localhost:${port.port}`} target="_blank" rel="noopener noreferrer">
              Open localhost
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => {
              void openBrowserLink(`/forward/${sessionId}/${port.port}`).catch(toastError);
            }}
          >
            Open via proxy
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => {
            if (!host) return;
            void navigator.clipboard
              .writeText(sshForwardCommand(port.port, host.username, host.hostname))
              .then(() => toast.success('Copied'));
          }}
        >
          Copy ssh -L
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import type { Session } from '@puddle/shared';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { useSessionEnv } from '../../lib/queries/queries';

const LIVE_STATUSES: Session['status'][] = ['running', 'waiting_input'];

/**
 * Slim mono row of the session's captured env var names (SPEC §4), rendered
 * IN FLOW below the pane body beside the ports strip (PaneLeaf), never an
 * overlay. A name copies its value when the daemon supplies protocol 16.2's
 * optional field. Names stay on one horizontally scrollable line with its
 * scrollbar hidden. Hidden entirely when the session isn't live or nothing
 * is captured; no refresh control, the hook's 5s poll is the refresh
 * (HUMANS.md minimalism). Clearing lives in the session menu, not here.
 */
export function EnvStrip({ sessionId, status }: { sessionId: string; status: Session['status'] }) {
  const live = LIVE_STATUSES.includes(status);
  const { data } = useSessionEnv(sessionId, live);
  const vars = data?.vars ?? [];

  if (!live || vars.length === 0) return null;

  const copyValue = async (name: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${name} value copied`);
    } catch {
      toast.error(`Couldn't copy ${name} value`);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2 px-3 font-mono text-xs">
      <span className="shrink-0 text-fg-muted">env</span>
      <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
        <div className="flex w-max items-center gap-1 whitespace-nowrap">
          {vars.map((v) => {
            const value = v.value;
            return (
              <Tooltip key={v.name}>
                <TooltipTrigger asChild>
                  {value === undefined ? (
                    <span className="rounded px-1.5 py-0.5 text-fg-secondary">{v.name}</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Copy ${v.name} environment variable value`}
                      onClick={() => void copyValue(v.name, value)}
                      className="cursor-pointer rounded px-1.5 py-0.5 text-fg-secondary transition-colors hover:bg-elevated hover:text-fg"
                    >
                      {v.name}
                    </button>
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  {v.bytes} B ·{' '}
                  {value === undefined
                    ? 'value unavailable from this daemon'
                    : 'click to copy value'}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}

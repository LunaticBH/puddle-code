import type { Session } from '@puddle/shared';
import { SquareTerminal } from 'lucide-react';
import { AgentIcon } from '../../../components/agent-icon';
import { useClientSettings } from '../../../lib/settings/client-settings';
import { useAccounts, useProjects } from '../../../lib/queries/queries';
import { useCurrentProfileId } from '../../profile/profile-store';

/**
 * What a tab chip says on hover (SPEC §8) — the collapsed session rail's tooltip,
 * for the centre strip, and for the same reason: a chip caps at `max-w-52` and
 * truncates, so this is often the only place the whole name can be read.
 *
 * Under it, the context the tab lives in:
 *
 * - **project · branch**, from the session the tab was opened from. The project
 *   is named only under a PROFILE-based layout, since only there does one tiling
 *   surface mix projects — under a project-based layout every tab in the window
 *   belongs to the project the window is already about.
 * - **agent · account**, for an agent session; **terminal** with its terminal
 *   glyph for a shell session. A file has neither line.
 *
 * A tab rooted outside its worktree (a browse-tree `external` file) or bound to
 * no worktree at all (an untitled draft) describes neither: the caller passes no
 * session for those, and the tooltip is the name alone.
 *
 * Radix mounts tooltip content only while it is open, so the queries here are
 * paid for on hover and not per chip.
 */
export function TabTooltipBody({
  name,
  session,
}: {
  name: string;
  /** The worktree session this tab belongs to; undefined when it belongs to none. */
  session: Session | undefined;
}) {
  const profileId = useCurrentProfileId() ?? undefined;
  const projectBased = useClientSettings().projectBasedLayout;
  const projects = useProjects(projectBased ? undefined : profileId);
  const isAgent = session?.kind === 'agent';
  const accounts = useAccounts(isAgent ? profileId : undefined);

  const projectName = projects.data?.find((p) => p.id === session?.project_id)?.name;
  const account =
    session?.account_id != null
      ? accounts.data?.find((a) => a.id === session.account_id)?.label
      : undefined;
  const context = [projectName, session?.branch].filter(Boolean).join(' · ');

  return (
    <span className="flex flex-col">
      <span>{name}</span>
      {context !== '' && <span className="text-2xs text-fg-muted">{context}</span>}
      {isAgent && (
        <span className="mt-0.5 flex items-center gap-1 text-2xs text-fg-muted">
          <AgentIcon type={session.agent_type ?? ''} className="size-3 shrink-0" />
          <span>{session.agent_type}</span>
          {account !== undefined && <span> · {account}</span>}
        </span>
      )}
      {session?.kind === 'terminal' && (
        <span className="mt-0.5 flex items-center gap-1 text-2xs text-fg-muted">
          {session.detected_agent_type ? (
            <AgentIcon type={session.detected_agent_type} className="size-3 shrink-0" />
          ) : (
            <SquareTerminal className="size-3 shrink-0" />
          )}
          <span>
            {session.detected_agent_type ? `${session.detected_agent_type} · terminal` : 'terminal'}
          </span>
        </span>
      )}
    </span>
  );
}

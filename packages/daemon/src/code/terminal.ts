import { basename, isAbsolute, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import type { CompilationFileTarget, Session } from '@puddle/shared';
import type { CompilationRunOptions } from '../compilation/provider.js';
import type { ProjectStore } from '../db/stores/projects.js';
import { ApiError } from '../http/errors.js';
import { NO_SESSION, type WorktreeDeps } from '../http/routes/worktrees/worktree-shared.js';
import type { PtyExitEvent, PtyManager } from '../pty/pty-manager.js';
import type { SessionService } from '../sessions/service.js';
import type { TerminalCommand } from '../sessions/terminal-command.js';

export type CodeTerminalLauncher = (
  source: CompilationFileTarget,
  options: CompilationRunOptions,
  command: TerminalCommand,
) => Promise<{ session: Session; exited: Promise<void> }>;

/** Keep programme terminals in the source placement's project and existing worktree. */
export function createCodeTerminalLauncher(
  deps: WorktreeDeps & {
    projects: ProjectStore;
    service: SessionService;
    ptys: PtyManager;
  },
): CodeTerminalLauncher {
  const pendingExits = new Map<string, () => void>();
  deps.ptys.on('exit', (event: PtyExitEvent) => {
    if (event.term !== 'agent') return;
    pendingExits.get(event.stream)?.();
    pendingExits.delete(event.stream);
  });
  return async (source, options, command) => {
    const owner = source.session === NO_SESSION ? null : deps.sessions.get(source.session);
    const projectId = options.projectId ?? owner?.project_id;
    if (!projectId)
      throw ApiError.badRequest(
        'terminal_project_required',
        'Running in a terminal requires a project',
      );
    const project = deps.projects.get(projectId);
    if (
      (owner && owner.project_id !== project.id) ||
      (options.profileId && options.profileId !== project.profile_id)
    ) {
      throw ApiError.badRequest(
        'compilation_scope_mismatch',
        'The source and terminal must belong to the selected project and profile',
      );
    }
    const worktree = owner?.worktree_path ?? deps.repos.get(project.repo_id).path;
    const cwd = relative(realpathSync(worktree), realpathSync(command.cwd));
    const session = await deps.service.createCommandTerminal(
      {
        project_id: project.id,
        title: `Run ${basename(source.path)}`.slice(0, 200),
        separate_branch: false,
        separate_worktree: false,
        join_worktree: worktree,
        // External source roots may lie outside the placement. Execute there
        // once, but retain the ordinary worktree-relative resume contract. On
        // Windows a root on another drive has no relative path at all.
        ...(cwd !== '..' && !cwd.startsWith(`..${sep}`) && !isAbsolute(cwd) ? { cwd } : {}),
      },
      command,
    );
    const exited = new Promise<void>((resolve) => {
      if (deps.ptys.has(session.id, 'agent')) pendingExits.set(session.id, resolve);
      else resolve();
    });
    return { session, exited };
  };
}

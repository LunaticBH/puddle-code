import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Bot,
  FolderOpen,
  Moon,
  MonitorCog,
  Plus,
  RefreshCw,
  Settings,
  Sun,
  TerminalSquare,
  UserRound,
} from 'lucide-react';
import type { SessionKind } from '@puddle/shared';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../../components/ui/command';
import { applyTheme } from '../../lib/appearance/theme';
import { triggerConnectionRefresh } from '../../lib/transport/cockpit-refresh';
import { registerCommandPalette } from '../../lib/navigation/command-palette';
import { registerHotkey } from '../../lib/navigation/hotkeys';
import { openSettings } from '../../lib/navigation/hash-route';
import { openPath } from '../../lib/navigation/path-open';
import { useProfileSettings, useProjects, useSessions } from '../../lib/queries/queries';
import { collectCommands, type PaletteCommand } from './commands';
import { useCurrentProfileId, profileStore } from '../profile/profile-store';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import { orderByDrag } from '../workspace/sessions/session-order';

/** ⌘K palette: switch project/session, new project/agent/terminal, theme, settings (Phase 2). */
export function CommandPalette({
  onNewSession,
  onNewProject,
}: {
  /** Opens the new-session modal; `kind` picks agent (default) or terminal. */
  onNewSession?: (opts?: { kind?: SessionKind }) => void;
  onNewProject?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'commands' | 'path'>('commands');
  const [input, setInput] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState(false);
  const navigate = useNavigate();
  const params = useParams();
  const profileId = useCurrentProfileId();
  const projectId = params['id'];
  const projects = useProjects(profileId ?? undefined);
  const profileSettings = useProfileSettings(profileId ?? undefined);
  const sessions = useSessions(projectId);
  const renderTitle = useSessionTitleRenderer();

  // The ⌘K binding is the `palette.toggle` hotkey (customisable, SPEC §11).
  useEffect(() => registerHotkey('palette.toggle', () => setOpen((o) => !o)), []);

  // Let any affordance (e.g. an empty pane's ⌘K button) open this one palette.
  useEffect(() => registerCommandPalette(() => setOpen(true)), []);

  // Every close returns to the ordinary command list, whether it came from a
  // successful open, Escape, the backdrop, or the palette hotkey.
  useEffect(() => {
    if (open) return;
    setMode('commands');
    setInput('');
    setPathError(null);
    setOpeningPath(false);
  }, [open]);

  const commands = useMemo(() => {
    const items: PaletteCommand[] = [];
    const orderedProjects = orderByDrag(
      (projects.data ?? []).filter((project) => !project.archived),
      profileSettings.data?.projectOrder ?? [],
    );
    for (const project of orderedProjects) {
      items.push({
        id: `project-${project.id}`,
        group: 'Projects',
        label: project.name,
        icon: FolderOpen,
        keywords: 'switch project open',
        run: () => void navigate(`/project/${project.id}`),
      });
    }
    for (const session of sessions.data ?? []) {
      if (session.status === 'archived') continue;
      items.push({
        id: `session-${session.id}`,
        group: 'Sessions',
        label: renderTitle(session),
        icon: TerminalSquare,
        keywords: `switch session ${session.branch}`,
        run: () => void navigate(`/project/${session.project_id}/session/${session.id}`),
      });
    }
    if (projectId !== undefined && onNewSession) {
      items.push(
        {
          id: 'new-agent',
          group: 'Actions',
          label: 'New agent',
          icon: Bot,
          keywords: 'new agent create start session',
          run: () => onNewSession(),
        },
        {
          id: 'new-terminal',
          group: 'Actions',
          label: 'New terminal',
          icon: TerminalSquare,
          keywords: 'new terminal create start shell session',
          run: () => onNewSession({ kind: 'terminal' }),
        },
      );
    }
    if (projectId !== undefined) {
      items.push({
        id: 'open-path',
        group: 'Actions',
        label: 'Open path',
        icon: FolderOpen,
        keywords: 'open path file directory folder editor tree browse absolute relative home',
        closeOnRun: false,
        run: () => {
          setInput('');
          setPathError(null);
          setMode('path');
        },
      });
    }
    if (onNewProject) {
      items.push({
        id: 'new-project',
        group: 'Actions',
        label: 'New project',
        icon: Plus,
        keywords: 'new project open create repository repo workspace',
        run: onNewProject,
      });
    }
    items.push(
      {
        id: 'theme-dark',
        group: 'Theme',
        label: 'Switch theme: dark',
        icon: Moon,
        keywords: 'switch theme dark appearance',
        run: () => void applyTheme('dark'),
      },
      {
        id: 'theme-light',
        group: 'Theme',
        label: 'Switch theme: light',
        icon: Sun,
        keywords: 'switch theme light appearance',
        run: () => void applyTheme('light'),
      },
      {
        id: 'theme-system',
        group: 'Theme',
        label: 'Switch theme: system',
        icon: MonitorCog,
        keywords: 'switch theme system appearance',
        run: () => void applyTheme('system'),
      },
      {
        id: 'open-settings',
        group: 'Actions',
        label: 'Settings',
        icon: Settings,
        keywords: 'open settings preferences options configure',
        run: () => openSettings(),
      },
      {
        id: 'switch-profile',
        group: 'Actions',
        label: 'Switch profile',
        icon: UserRound,
        keywords: 'switch profile identity user change',
        run: () => profileStore.set(null),
      },
      {
        id: 'refresh-connection',
        group: 'Actions',
        label: 'Refresh connection',
        icon: RefreshCw,
        keywords: 'refresh connection reconnect restart cockpit tunnel ssh daemon',
        run: () => triggerConnectionRefresh(),
      },
    );
    return [...items, ...collectCommands()];
  }, [
    projects.data,
    profileSettings.data?.projectOrder,
    sessions.data,
    projectId,
    navigate,
    onNewSession,
    onNewProject,
    renderTitle,
  ]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, PaletteCommand[]>();
    for (const command of commands) {
      const list = byGroup.get(command.group) ?? [];
      list.push(command);
      byGroup.set(command.group, list);
    }
    return [...byGroup.entries()];
  }, [commands]);

  const submitPath = async () => {
    const path = input.trim();
    if (path === '' || openingPath) return;
    setOpeningPath(true);
    setPathError(null);
    try {
      await openPath(path);
      setOpen(false);
    } catch (error) {
      setPathError(error instanceof Error ? error.message : 'Could not open that path.');
    } finally {
      setOpeningPath(false);
    }
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        value={input}
        onValueChange={(value) => {
          setInput(value);
          setPathError(null);
        }}
        placeholder={mode === 'path' ? 'Enter a path…' : 'Type a command or search…'}
        onKeyDown={(event) => {
          if (mode !== 'path') return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void submitPath();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setMode('commands');
            setInput('');
            setPathError(null);
          }
        }}
      />
      {mode === 'path' ? (
        <CommandList>
          <div className="px-3 py-3 text-xs text-fg-muted">
            <p>
              Relative paths start from the bound worktree or project. Absolute and ~ paths work
              too.
            </p>
            <p className={pathError ? 'mt-2 text-danger' : 'mt-2'} aria-live="polite">
              {pathError ?? (openingPath ? 'Opening…' : 'Press Enter to open.')}
            </p>
          </div>
        </CommandList>
      ) : (
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {groups.map(([group, items]) => (
            <CommandGroup key={group} heading={group}>
              {items.map((command) => {
                const Icon = command.icon;
                return (
                  <CommandItem
                    key={command.id}
                    value={`${command.label} ${command.keywords ?? ''}`}
                    onSelect={() => {
                      if (command.closeOnRun !== false) setOpen(false);
                      command.run();
                    }}
                  >
                    {Icon && <Icon />}
                    {command.label}
                    {command.shortcut && <CommandShortcut>{command.shortcut}</CommandShortcut>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      )}
    </CommandDialog>
  );
}

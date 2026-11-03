import {
  Bell,
  Code,
  FolderGit2,
  Keyboard,
  Palette,
  RefreshCw,
  Server,
  SlidersHorizontal,
  UserRound,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { closeSettings, openSettings, useSettingsSection } from '../../lib/navigation/hash-route';
import { cn } from '../../lib/utils';
import { AppearanceSection } from './sections/appearance';
import { ProfileSection } from './sections/profile';
import { AccountsSection } from './sections/accounts';
import { SessionsSection } from './sections/sessions';
import { NotificationsSection } from './sections/notifications';
import { EditorSection } from './sections/editor';
import { HotkeysSection } from './sections/hotkeys';
import { RemoteSyncSection } from './sections/remote-sync';
import { RepositoriesSection } from './sections/repositories';
import { HostSection } from './sections/host';

const SECTIONS: Array<{ id: string; label: string; icon: LucideIcon; render: () => ReactElement }> =
  [
    { id: 'appearance', label: 'Appearance', icon: Palette, render: () => <AppearanceSection /> },
    { id: 'profile', label: 'Profile', icon: UserRound, render: () => <ProfileSection /> },
    { id: 'accounts', label: 'Accounts', icon: Users, render: () => <AccountsSection /> },
    {
      id: 'sessions',
      label: 'Sessions',
      icon: SlidersHorizontal,
      render: () => <SessionsSection />,
    },
    { id: 'editor', label: 'Editor', icon: Code, render: () => <EditorSection /> },
    { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard, render: () => <HotkeysSection /> },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: Bell,
      render: () => <NotificationsSection />,
    },
    {
      id: 'projects',
      label: 'Projects',
      icon: FolderGit2,
      render: () => <RepositoriesSection />,
    },
    { id: 'host', label: 'Host', icon: Server, render: () => <HostSection /> },
    {
      id: 'remote-sync',
      label: 'Remote & Sync',
      icon: RefreshCw,
      render: () => <RemoteSyncSection />,
    },
  ];

/** Pre-split section ids still deep-linked from old bookmarks/docs. */
const LEGACY_SECTIONS: Record<string, string> = {
  // "Terminal & Editor" split: terminal knobs joined Sessions, the rest is Editor.
  terminal: 'sessions',
  // Renamed to Projects (decision 2026-08-03): the rows are per-repository
  // settings, but users reach them thinking in projects.
  repositories: 'projects',
  remote: 'remote-sync',
  sync: 'remote-sync',
};

/** Route-addressable settings dialog: `#settings/<section>` (SPEC §11). */
export function SettingsDialog() {
  const sectionId = useSettingsSection();
  const resolvedId = sectionId !== null ? (LEGACY_SECTIONS[sectionId] ?? sectionId) : null;
  const section = SECTIONS.find((s) => s.id === resolvedId) ?? SECTIONS[0]!;

  return (
    <Dialog open={sectionId !== null} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent
        wide
        className="grid h-[34rem] grid-cols-[14rem_1fr] gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav className="flex flex-col gap-1 bg-surface p-2.5 pr-6">
          <span className="px-2.5 py-2 text-2xs font-medium uppercase tracking-wide text-fg-muted">
            Settings
          </span>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => openSettings(id)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                id === section.id
                  ? 'bg-elevated text-fg'
                  : 'text-fg-secondary hover:bg-elevated hover:text-fg',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
        <div className="overflow-y-auto p-5">{section.render()}</div>
      </DialogContent>
    </Dialog>
  );
}

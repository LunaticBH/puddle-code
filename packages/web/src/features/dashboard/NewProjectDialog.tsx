import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CornerLeftUp, Folder, FolderGit2 } from 'lucide-react';
import type { ProjectColour } from '@puddle/shared';
import { ColourPicker } from '../../components/colour-picker';
import { appearanceColourClass } from '../../lib/appearance/appearance-colours';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { HintInput, type Hint } from '../../components/ui/hint-input';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  useCreateProject,
  useCreateRepo,
  useDaemonVersion,
  useDirSuggestions,
  useHostInfo,
  useRepos,
} from '../../lib/queries/queries';
import { ABBREV_MAX, deriveAbbrev, normaliseAbbrev } from '../../lib/project-abbrev';
import {
  dynamicBaseBranchSupported,
  projectColourSupported,
} from '../../lib/transport/protocol-support';
import { useDebouncedValue } from '../../lib/hooks/use-debounced-value';

/** '/a/b/' → '/a/b'; keeps the root slash. */
function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function isPathish(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~');
}

function parentDir(dir: string): string {
  const cut = dir.replace(/\/+$/, '');
  const idx = cut.lastIndexOf('/');
  return idx <= 0 ? '/' : cut.slice(0, idx);
}

/**
 * The graphical folder picker behind "browse…": walks the DAEMON host's
 * directories over the same `GET /api/fs/dirs` the path field's autocomplete
 * uses, so it works identically for local and SSH hosts — no OS file dialog
 * (which could only ever see the client machine). The path input above is the
 * single source of truth: every navigation writes the browsed directory into
 * it (no duplicate path line here). Clicking a row always descends — git
 * repositories included (monorepos nest further repos) — and a git row
 * carries its own "choose" action; the header steps up and can choose the
 * current directory itself. Choosing fills the project NAME from the
 * directory and closes the browser (the path is already in the field).
 */
function DirBrowser({
  dir,
  onNavigate,
  onChoose,
}: {
  dir: string;
  onNavigate: (dir: string) => void;
  onChoose: (dir: string) => void;
}) {
  const entries = useDirSuggestions(dir.endsWith('/') ? dir : `${dir}/`);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onNavigate(parentDir(dir))}
          disabled={dir === '/'}
          title="Parent directory"
          className="shrink-0 rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          <CornerLeftUp className="size-3.5" />
          <span className="sr-only">Parent directory</span>
        </button>
        <button
          type="button"
          onClick={() => onChoose(dir)}
          className="ml-auto shrink-0 text-2xs text-fg-muted transition-colors hover:text-fg"
        >
          choose this folder
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {(entries.data?.entries ?? []).map((entry) => (
          <div
            key={entry.path}
            className="flex items-center rounded-md transition-colors hover:bg-elevated"
          >
            <button
              type="button"
              onClick={() => onNavigate(entry.path)}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
            >
              {entry.is_git ? (
                <FolderGit2 className="size-3.5 shrink-0 text-success" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-fg-gold" />
              )}
              <span className="truncate text-xs text-fg">{entry.name}</span>
            </button>
            {entry.is_git && (
              <button
                type="button"
                onClick={() => onChoose(entry.path)}
                className="shrink-0 px-2 py-1 text-2xs text-fg-muted transition-colors hover:text-fg"
              >
                choose
              </button>
            )}
          </div>
        ))}
        {entries.data !== undefined && entries.data.entries.length === 0 && (
          <p className="px-2 py-1 text-xs text-fg-muted">No subdirectories.</p>
        )}
      </div>
    </div>
  );
}

/**
 * One path, one name: the path field autocompletes directories on the daemon
 * host (dotdirs included, git repos flagged); a path matching an already
 * registered repo simply reuses it.
 */
export function NewProjectDialog({
  profileId,
  open,
  onOpenChange,
}: {
  profileId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const repos = useRepos();
  const protocol = useDaemonVersion().data?.protocol;
  const dynamicBase = dynamicBaseBranchSupported(protocol);
  const colourSupported = projectColourSupported(protocol);
  const createRepo = useCreateRepo();
  const createProject = useCreateProject();
  const navigate = useNavigate();
  const host = useHostInfo();

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  // The collapsed-rail label (SPEC §12): follows the name until edited, so the
  // field always shows exactly what will be stored — never an empty field
  // reinterpreted later.
  const [abbrev, setAbbrev] = useState('');
  const [colour, setColour] = useState<ProjectColour | null>(null);
  const [abbrevTouched, setAbbrevTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picker's current directory; null while it is closed.
  const [browseDir, setBrowseDir] = useState<string | null>(null);

  const home = host.data?.home;
  const openBrowser = () => {
    // Seed from the typed path when there is one (~-expanded client-side so
    // parent stepping stays plain string maths), else the daemon user's home.
    const typed = path.trim();
    const seeded =
      isPathish(typed) && home !== undefined
        ? normalisePath(typed.replace(/^~(?=\/|$)/, home))
        : isPathish(typed) && typed.startsWith('/')
          ? normalisePath(typed)
          : (home ?? '/');
    navigateBrowser(seeded);
  };
  // Every name change keeps the (untouched) abbreviation in step, so the
  // abbrev field always displays the value that will actually be stored.
  const applyName = (next: string) => {
    setName(next);
    if (!abbrevTouched) setAbbrev(deriveAbbrev(next));
  };
  // Browsing keeps the path input in step (single source of truth): every
  // navigation writes the browsed directory into the field.
  const navigateBrowser = (dir: string) => {
    setBrowseDir(dir);
    setPath(dir);
  };
  // Choosing is an explicit act: it names the project after the directory
  // (overwriting a stale name) and closes the browser — the path is already
  // in the field from browsing there.
  const chooseDir = (dir: string) => {
    setPath(dir);
    setBrowseDir(null);
    applyName(dir.split('/').filter(Boolean).pop() ?? '');
    setNameTouched(true);
  };

  const debouncedPath = useDebouncedValue(path, 150);
  const suggestions = useDirSuggestions(debouncedPath);

  // Before any typing, offer the already-registered repos.
  const hints = useMemo<Array<Hint & { is_git: boolean }>>(() => {
    if (!isPathish(path)) {
      return (repos.data ?? []).map((repo) => ({
        value: repo.path,
        badge: 'registered',
        is_git: true,
      }));
    }
    const registered = new Set((repos.data ?? []).map((repo) => repo.path));
    return (suggestions.data?.entries ?? []).map((entry) => ({
      value: entry.path,
      label: entry.name,
      badge: registered.has(entry.path) ? 'registered' : entry.is_git ? 'git' : undefined,
      is_git: entry.is_git,
    }));
  }, [path, repos.data, suggestions.data]);

  const submit = async () => {
    setError(null);
    try {
      const repoPath = normalisePath(path);
      const existing = repos.data?.find((repo) => repo.path === repoPath);
      const repoId =
        existing?.id ??
        (
          await createRepo.mutateAsync({
            path: repoPath,
            // Older compatible hosts snapshot HEAD when the setting is omitted.
            ...(dynamicBase ? { default_base_branch: '' } : {}),
          })
        ).id;
      const project = await createProject.mutateAsync({
        profile_id: profileId,
        repo_id: repoId,
        name: name.trim(),
        ...(colourSupported ? { colour } : {}),
        // A cleared field falls back to deriving from the name — which is
        // exactly what the field showed before it was cleared.
        ...(normaliseAbbrev(abbrev) ? { abbrev: normaliseAbbrev(abbrev) } : {}),
      });
      onOpenChange(false);
      void navigate(`/project/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const ready = name.trim() !== '' && isPathish(path.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Point at a git repository on the daemon host — known repositories are reused.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="repo-path">Repository path</Label>
              <button
                type="button"
                onClick={() => (browseDir === null ? openBrowser() : setBrowseDir(null))}
                className="text-2xs text-fg-muted transition-colors hover:text-fg"
              >
                {browseDir === null ? 'browse…' : 'hide browser'}
              </button>
            </div>
            <HintInput
              id="repo-path"
              placeholder="~/src/my-repo"
              value={path}
              onValueChange={setPath}
              onChoose={(hint) => {
                const chosen = hint as Hint & { is_git: boolean };
                if (!nameTouched && chosen.is_git) {
                  applyName(hint.value.split('/').filter(Boolean).pop() ?? '');
                }
              }}
              hints={hints}
            />
            {browseDir !== null && (
              <DirBrowser dir={browseDir} onNavigate={navigateBrowser} onChoose={chooseDir} />
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              placeholder="e.g. checkout-rework"
              value={name}
              className={appearanceColourClass(colour)}
              onChange={(e) => {
                applyName(e.target.value);
                setNameTouched(true);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-abbrev">Abbreviation</Label>
            <Input
              id="project-abbrev"
              placeholder={name.trim() ? deriveAbbrev(name) : 'ABBRV'}
              maxLength={ABBREV_MAX}
              value={abbrev}
              onChange={(e) => {
                setAbbrev(normaliseAbbrev(e.target.value));
                setAbbrevTouched(true);
              }}
              className="w-24 uppercase"
            />
            <p className="text-2xs text-fg-muted">
              Up to {ABBREV_MAX} characters — the project's label on the collapsed sidebar rail.
            </p>
          </div>
          {colourSupported && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-fg-secondary">Colour</span>
              <ColourPicker value={colour} onChange={setColour} label="Project colour" />
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!ready || createRepo.isPending || createProject.isPending}
            >
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowUp,
  Eye,
  FolderOpen,
  GitCompareArrows,
  Monitor,
  RefreshCw,
} from 'lucide-react';
import { fileResponseSchema, treeResponseSchema } from '@puddle/shared';
import { useDaemonVersion } from '../../lib/queries/queries';
import { previewKind } from '../editor/previews/preview-kind';
import { mediaKind } from '../editor/previews/media-kind';
import { api } from '../../lib/transport/api';
import { Button } from '../../components/ui/button';
import { PhoneReview } from './PhoneReview';
import { PhonePathDialog } from './PhonePathDialog';
import { PhoneFileContent } from './PhoneFileContent';
import { PhoneFileRow } from './PhoneFileRow';

const NO_SESSION = '00000000-0000-0000-0000-000000000000';

/** Read-only source and desktop renderers, scoped to this host and browse root. */
export function PhoneFiles({
  session,
  worktree,
  terminals,
}: {
  session?: string;
  worktree?: string;
  terminals(): void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [directory, setDirectory] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const version = useDaemonVersion().data?.protocol;
  const canPreview =
    !!version && (version.major > 21 || (version.major === 21 && version.minor >= 1));
  const textKind = file ? previewKind(file) : null;
  const media = file ? mediaKind(file) : null;
  const showPreview = canPreview && preview && !!(textKind || media);
  const openFile = (path: string, rendered = false) => {
    setFile(path);
    setPreview(rendered);
  };
  const [selected, setSelected] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [changes, setChanges] = useState(false);
  const effectiveRoot = root ?? worktree;
  const relativePath = file ?? directory;
  const currentPath = relativePath
    ? `${effectiveRoot?.replace(/\/$/, '') ?? ''}/${relativePath}`
    : (effectiveRoot ?? '');
  const rootOverride = root ?? (session ? undefined : worktree);
  const target = session ?? NO_SESSION;
  const query = (path: string) =>
    new URLSearchParams({
      path: path || '.',
      ...(rootOverride ? { root: rootOverride } : {}),
    }).toString();
  const tree = useQuery({
    queryKey: ['phone-tree', target, effectiveRoot, directory],
    queryFn: async () =>
      treeResponseSchema.parse(
        await api('GET', `/api/worktrees/${target}/tree?${query(directory)}`),
      ),
    enabled: !!effectiveRoot && !changes,
  });
  const source = useQuery({
    queryKey: ['phone-source', target, effectiveRoot, file],
    queryFn: async () =>
      fileResponseSchema.parse(await api('GET', `/api/worktrees/${target}/file?${query(file!)}`)),
    enabled: file !== null && !(showPreview && media),
  });
  const reset = () => {
    setDirectory('');
    setFile(null);
    setPreview(false);
    setSelected('');
  };
  const entries = [...(tree.data?.entries ?? [])].sort(
    (a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name),
  );
  const terminalButton = (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Terminals"
      title="Terminals"
      onClick={terminals}
    >
      <Monitor />
    </Button>
  );
  return (
    <div className="phone-files">
      {changes ? (
        <>
          <nav className="phone-workspace-bar" aria-label="Workspace view">
            <Button variant="ghost" onClick={() => setChanges(false)}>
              <ArrowLeft />
              Back to files
            </Button>
            {terminalButton}
          </nav>
          <PhoneReview session={target} />
        </>
      ) : (
        <>
          <nav className="phone-workspace-bar phone-files-toolbar" aria-label="Workspace view">
            <Button
              variant="ghost"
              size="icon"
              aria-label={file ? 'Back to files' : 'Parent directory'}
              disabled={!file && !directory}
              onClick={() =>
                file ? setFile(null) : setDirectory(directory.split('/').slice(0, -1).join('/'))
              }
            >
              {file ? <ArrowLeft /> : <ArrowUp />}
            </Button>
            <button
              className="min-w-0 flex-1 truncate text-left font-mono text-xs text-fg-muted hover:text-fg"
              title={currentPath}
              aria-label="Open file or directory"
              onClick={() => setEditingPath(true)}
            >
              {file?.split('/').pop() ?? (directory || effectiveRoot || 'Choose a path')}
            </button>
            {file && canPreview && (textKind || media) && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Preview file"
                title={showPreview ? 'Show source' : 'Preview file'}
                aria-pressed={showPreview}
                className={showPreview ? 'text-accent' : undefined}
                onClick={() => setPreview(!showPreview)}
              >
                <Eye />
              </Button>
            )}
            {session && !file && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Review changes"
                onClick={() => setChanges(true)}
              >
                <GitCompareArrows />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh files"
              onClick={() => {
                setRefresh((value) => value + 1);
                void tree.refetch();
                if (file && !(showPreview && media)) void source.refetch();
              }}
            >
              <RefreshCw />
            </Button>
            {terminalButton}
          </nav>
          {root && !file && (
            <div className="px-3 pb-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRoot(null);
                  reset();
                }}
              >
                <FolderOpen />
                Back to worktree
              </Button>
            </div>
          )}
          {file ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pb-3">
              <p className="mb-3 break-all font-mono text-2xs text-fg-muted">{file} · read only</p>
              <PhoneFileContent
                session={target}
                file={file}
                root={rootOverride}
                preview={showPreview}
                textKind={textKind}
                media={media}
                refresh={refresh}
                source={source}
                openFile={(path) => {
                  openFile(path, !!previewKind(path) || !!mediaKind(path));
                  setSelected(path);
                  setDirectory(path.split('/').slice(0, -1).join('/'));
                }}
              />
            </div>
          ) : (
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
              aria-label="File tree"
            >
              {tree.isFetching && !tree.data && (
                <p className="p-2 text-sm text-fg-muted">Loading files…</p>
              )}
              {tree.error && (
                <p role="alert" className="p-2 text-sm text-danger">
                  {tree.error.message}
                </p>
              )}
              {entries.map((entry) => {
                const path = [directory, entry.name].filter(Boolean).join('/');
                return (
                  <PhoneFileRow
                    key={`${target}:${effectiveRoot}:${path}`}
                    entry={entry}
                    path={path}
                    session={target}
                    root={rootOverride}
                    selected={selected === path}
                    canDownload={canPreview}
                    select={() => setSelected(path)}
                    open={() => {
                      if (entry.type === 'dir') {
                        setDirectory(path);
                        setSelected('');
                      } else openFile(path);
                    }}
                  />
                );
              })}
              {tree.data && entries.length === 0 && (
                <p className="p-2 text-sm text-fg-muted">This directory is empty.</p>
              )}
              {!effectiveRoot && (
                <Button variant="secondary" onClick={() => setEditingPath(true)}>
                  Choose a path
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {editingPath && (
        <PhonePathDialog
          target={NO_SESSION}
          root={effectiveRoot}
          path={currentPath}
          close={() => setEditingPath(false)}
          open={(result) => {
            reset();
            if (result.kind === 'dir') {
              if (result.relative_path !== undefined) setDirectory(result.relative_path);
              else setRoot(result.path === worktree ? null : result.path);
            } else {
              if (result.root) setRoot(result.root);
              openFile(result.path);
              setSelected(result.path);
              setDirectory(result.path.split('/').slice(0, -1).join('/'));
            }
          }}
        />
      )}
    </div>
  );
}

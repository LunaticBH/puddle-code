import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Download, Folder } from 'lucide-react';
import { MAX_PREVIEW_ASSET_BYTES, type TreeEntry } from '@puddle/shared';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { browserTransport } from '../../lib/transport/browser-transport';
import { ApiError, apiFetchRaw } from '../../lib/transport/api';
import { downloadBlob } from '../../lib/download-blob';
import { rootParam } from '../../lib/queries/worktree-queries';
import { cn } from '../../lib/utils';
import { fetchPreviewAsset } from '../editor/previews/preview-assets';
import { FileTypeIcon } from '../explorer/file-icons';

/** The shared menu supplies touch holds, movement cancellation and right-click. */
export function PhoneFileRow({
  entry,
  path,
  session,
  root,
  selected,
  canDownload,
  select,
  open,
}: {
  entry: TreeEntry;
  path: string;
  session: string;
  root?: string;
  selected: boolean;
  canDownload: boolean;
  select(): void;
  open(): void;
}) {
  const tap = useRef(-Infinity);
  const held = useRef(false);
  const [downloading, setDownloading] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!selected) tap.current = -Infinity;
  }, [selected]);

  const download = async () => {
    const transport = browserTransport();
    const generation = transport?.generation;
    const current = () =>
      active.current && browserTransport() === transport && transport?.generation === generation;
    if (transport && entry.size !== null && entry.size > MAX_PREVIEW_ASSET_BYTES) {
      toast.error('Downloads must be 8 MiB or smaller.');
      return;
    }
    setDownloading(true);
    const notice = toast.loading(`Downloading ${entry.name}…`);
    try {
      const blob = transport
        ? await fetchPreviewAsset(session, path, root)
        : await (
            await apiFetchRaw(
              'GET',
              `/api/worktrees/${session}/download?path=${encodeURIComponent(path)}${rootParam(root)}`,
            )
          ).blob();
      if (current()) downloadBlob(blob, entry.name);
    } catch (cause) {
      if (current())
        toast.error(
          cause instanceof ApiError && cause.code === 'preview_too_large'
            ? 'Downloads must be 8 MiB or smaller.'
            : cause instanceof Error
              ? cause.message
              : 'Download failed',
        );
    } finally {
      toast.dismiss(notice);
      if (active.current) setDownloading(false);
    }
  };

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          held.current = true;
          tap.current = -Infinity;
          select();
        }
      }}
    >
      <div className={cn('flex items-center rounded-md', selected && 'bg-surface')}>
        <ContextMenuTrigger asChild disabled={entry.type !== 'file' || !canDownload}>
          <button
            className="phone-file-row"
            disabled={entry.type === 'symlink'}
            aria-label={`${entry.type === 'dir' ? 'Open folder' : 'Select file'} ${entry.name}`}
            onPointerDown={() => {
              held.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') held.current = false;
            }}
            onClick={(event) => {
              if (held.current) return;
              if (
                entry.type === 'dir' ||
                event.detail === 0 ||
                performance.now() - tap.current < 450
              )
                open();
              tap.current = performance.now();
              select();
            }}
            onDoubleClick={() => {
              if (entry.type === 'file' && !held.current) open();
            }}
          >
            {entry.type === 'dir' ? (
              <Folder className="size-4 shrink-0" />
            ) : (
              <FileTypeIcon name={entry.name} />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
        </ContextMenuTrigger>
        {entry.type === 'file' && selected && (
          <Button variant="ghost" size="icon" aria-label={`View ${entry.name}`} onClick={open}>
            <ChevronRight />
          </Button>
        )}
      </div>
      <ContextMenuContent>
        <ContextMenuItem
          className="min-h-11"
          disabled={downloading}
          onSelect={() => {
            void download();
          }}
        >
          <Download />
          {downloading ? 'Downloading…' : 'Download'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

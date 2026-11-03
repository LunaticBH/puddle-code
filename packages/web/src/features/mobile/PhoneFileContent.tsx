import { lazy, Suspense } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { FileResponse } from '@puddle/shared';
import type { PreviewKind } from '../editor/previews/preview-kind';
import type { MediaKind } from '../editor/previews/media-kind';
import { PhoneFileText } from './PhoneFileText';

const TextFilePreview = lazy(() =>
  import('../editor/previews/TextFilePreview').then((module) => ({
    default: module.TextFilePreview,
  })),
);
const MediaViewer = lazy(() =>
  import('../editor/previews/MediaViewer').then((module) => ({ default: module.MediaViewer })),
);

export function PhoneFileContent({
  session,
  file,
  root,
  preview,
  textKind,
  media,
  refresh,
  source,
  openFile,
}: {
  session: string;
  file: string;
  root?: string;
  preview: boolean;
  textKind: PreviewKind | null;
  media: MediaKind | null;
  refresh: number;
  source: UseQueryResult<FileResponse>;
  openFile(path: string): void;
}) {
  return (
    <>
      {preview && media ? (
        <div className="min-h-0 flex-1">
          <Suspense fallback={<p className="text-sm text-fg-muted">Loading preview…</p>}>
            <MediaViewer
              key={`${session}:${root}:${file}`}
              session={session}
              path={file}
              kind={media}
              root={root}
              refreshKey={refresh}
              readOnly
            />
          </Suspense>
        </div>
      ) : source.isPending ? (
        <p className="text-sm text-fg-muted">Loading file…</p>
      ) : source.error ? (
        <p role="alert" className="text-sm text-danger">
          {source.error.message}
        </p>
      ) : source.data.binary ? (
        <p className="text-sm text-fg-muted">Binary file; text view unavailable.</p>
      ) : preview && textKind ? (
        <div className="min-h-0 flex-1">
          <Suspense fallback={<p className="text-sm text-fg-muted">Loading preview…</p>}>
            <TextFilePreview
              key={`${session}:${root}:${file}:${refresh}`}
              session={session}
              path={file}
              kind={textKind}
              text={source.data.content ?? ''}
              root={root}
              mobile
              onOpenFile={openFile}
            />
          </Suspense>
        </div>
      ) : (
        <PhoneFileText target={[session, root, file]} content={source.data.content ?? ''} />
      )}
    </>
  );
}

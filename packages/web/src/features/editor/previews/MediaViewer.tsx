import { lazy, Suspense, useEffect, useState } from 'react';
import type { LatexSynctexResponse } from '@puddle/shared';
import { toast } from 'sonner';
import { fetchPreviewAsset } from './preview-assets';
import { downloadPath } from '../../../lib/queries/worktree-queries';
import type { MediaKind } from './media-kind';
import { useMediaRefresh } from './media-refresh-store';

const PdfDocumentViewer = lazy(() =>
  import('./pdf/PdfViewer').then((module) => ({ default: module.PdfViewer })),
);

/**
 * Inline preview for media editor tabs (SPEC §8): image / video / audio / PDF.
 * Fetches the file through the authed API (`GET /media`, the real content-type)
 * and hands media elements an object URL, or PDF.js the fetched Blob directly.
 * No bearer token rides in an element `src`; URLs are revoked on unmount or
 * path change. Falls back to a Download affordance on error.
 */
export function MediaViewer({
  session,
  path,
  kind,
  root,
  generatedBy,
  refreshKey,
  onRevealSource,
  readOnly = false,
}: {
  readOnly?: boolean;
  session: string;
  path: string;
  kind: MediaKind;
  /** Read-only browse root for `external` tabs (protocol 10.2). */
  root?: string;
  /** Compilation provider that produced this ordinary file tab, when known. */
  generatedBy?: string;
  /** Optional caller-owned invalidation in addition to the shared refresh store. */
  refreshKey?: string | number;
  onRevealSource?: (target: LatexSynctexResponse) => void;
}) {
  const refreshRevision = useMediaRefresh(session, path, root);
  const { asset, error } = useMediaAsset(session, path, root, refreshRevision, refreshKey);

  if (error) {
    return (
      <Centre>
        <p className="text-sm text-fg-secondary">{error}</p>
        {!readOnly && <DownloadButton session={session} path={path} root={root} />}
      </Centre>
    );
  }
  if (!asset) {
    return (
      <Centre>
        <span className="text-xs text-fg-muted">…</span>
      </Centre>
    );
  }
  const { url, blob } = asset;

  if (kind === 'image') {
    return (
      <Centre>
        <img src={url} alt={path} className="max-h-full max-w-full object-contain" />
      </Centre>
    );
  }
  if (kind === 'video') {
    return (
      <Centre>
        <video src={url} controls className="max-h-full max-w-full" />
      </Centre>
    );
  }
  if (kind === 'audio') {
    return (
      <Centre>
        <audio src={url} controls className="w-full max-w-xl" />
      </Centre>
    );
  }
  // Own the PDF scrollport: a browser's native PDF iframe exposes no position
  // to restore when a tab or project unmounts it.
  return (
    <Suspense
      fallback={
        <Centre>
          <span className="text-xs text-fg-muted">Loading PDF…</span>
        </Centre>
      }
    >
      <PdfDocumentViewer
        blob={blob}
        session={session}
        path={path}
        root={root}
        onRevealSource={
          !readOnly && isLatexGeneratedPdf(path, root, generatedBy) ? onRevealSource : undefined
        }
        onDownload={readOnly ? undefined : () => void startDownload(session, path, root)}
      />
    </Suspense>
  );
}

/** Centres its content over the tab's full height on the editor ground. */
function Centre({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto bg-ground p-4">
      {children}
    </div>
  );
}

function DownloadButton({ session, path, root }: { session: string; path: string; root?: string }) {
  return (
    <button
      type="button"
      onClick={() => void startDownload(session, path, root)}
      className="rounded-md bg-elevated px-3 py-1.5 text-sm text-fg transition-colors hover:bg-border/70"
    >
      Download
    </button>
  );
}

/** Retains fetched bytes alongside an object URL, revoking it on change/unmount. */
function useMediaAsset(
  session: string,
  path: string,
  root?: string,
  refreshRevision = 0,
  refreshKey?: string | number,
): { asset: { url: string; blob: Blob } | null; error: string | null } {
  const [asset, setAsset] = useState<{ url: string; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setAsset(null);
    setError(null);
    fetchPreviewAsset(session, path, root)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAsset({ url: objectUrl, blob });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : 'Couldn’t load this file.');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [session, path, root, refreshRevision, refreshKey]);

  return { asset, error };
}

function startDownload(session: string, path: string, root?: string): Promise<void> {
  return downloadPath(session, path, root).catch((cause: unknown) => {
    toast.error(cause instanceof Error ? cause.message : 'Download failed');
  });
}

/** Only daemon-owned LaTeX artefacts can request inverse source navigation. */
export function isLatexGeneratedPdf(path: string, root?: string, generatedBy?: string): boolean {
  if (!root || !path.toLowerCase().endsWith('.pdf')) return false;
  if (generatedBy === 'latex') return true;
  const normalisedRoot = root.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/');
  const address = `${normalisedRoot}/${path.replaceAll('\\', '/')}`;
  return (
    address.includes('/.puddle/latex/') ||
    // Managed directories use a 24-hex source hash. Retain recognition for a
    // rooted path supplied with platform-native separators.
    /(?:^|\/)latex\/[a-f\d]{24}\/current\/?$/i.test(normalisedRoot)
  );
}

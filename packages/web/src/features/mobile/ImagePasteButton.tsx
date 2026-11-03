import { useEffect, useRef, useState } from 'react';
import { ImagePlus, LoaderCircle, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { pasteImage, type ImagePasteProgress } from '../terminal/clipboard/paste-image';
import { IMAGE_ACCEPT } from '../terminal/clipboard/prepare-image';

export function ImagePasteButton({
  session,
  term,
  ready,
  insertTarget,
}: {
  session: string;
  term: string;
  ready: boolean;
  /** Resolved when an image is chosen; undefined inserts into the terminal. */
  insertTarget?: () => ((text: string) => void) | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<ImagePasteProgress | null>(null);
  const busy = progress !== null;
  useEffect(() => () => pending.current?.abort(), [session, term, ready]);
  const percentage =
    progress?.stage === 'uploading'
      ? Math.floor((progress.received / progress.total) * 100)
      : undefined;
  const label =
    progress?.stage === 'uploading'
      ? `${percentage}%`
      : progress?.stage === 'saving'
        ? 'Saving…'
        : progress?.stage === 'inserting'
          ? 'Inserting…'
          : 'Preparing…';
  const insert = async (file: File) => {
    if (!ready || pending.current) return;
    const abort = new AbortController();
    pending.current = abort;
    const insertInto = insertTarget?.();
    setProgress({ stage: 'preparing' });
    try {
      const { resized } = await pasteImage(file, session, term, {
        signal: abort.signal,
        onProgress: setProgress,
        insert: insertInto,
      });
      if (resized) toast('Image resized for remote access');
    } catch (error) {
      if (!abort.signal.aborted)
        toast.error(error instanceof Error ? error.message : 'Could not insert the image.');
    } finally {
      pending.current = null;
      setProgress(null);
    }
  };
  return (
    <>
      <input
        ref={input}
        className="hidden"
        type="file"
        accept={IMAGE_ACCEPT}
        aria-label="Choose image"
        disabled={!ready || busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = ''; // allow selecting the same image again
          if (file) void insert(file);
        }}
      />
      <Button
        variant="ghost"
        aria-label={busy ? 'Cancel image upload' : 'Insert image'}
        title={busy ? 'Cancel image upload' : 'Insert image'}
        aria-busy={busy}
        disabled={!ready || progress?.stage === 'inserting'}
        onClick={() => (busy ? pending.current?.abort() : input.current?.click())}
      >
        {busy ? (
          <>
            {progress.stage === 'inserting' ? <LoaderCircle className="animate-spin" /> : <X />}
            <span
              role="progressbar"
              aria-label="Image upload"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentage}
              aria-valuetext={label}
              className="text-xs"
            >
              {label}
            </span>
          </>
        ) : (
          <ImagePlus />
        )}
      </Button>
    </>
  );
}

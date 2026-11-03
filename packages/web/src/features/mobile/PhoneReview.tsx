import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { diffResponseSchema, fileAtResponseSchema, fileResponseSchema } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/transport/api';
import { PhoneDiff } from './PhoneDiff';
import { PhoneFileText } from './PhoneFileText';

/** Changes only: navigation and refresh belong to the Files workspace. */
export function PhoneReview({ session }: { session: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [view, setView] = useState<'diff' | 'before' | 'after'>('diff');
  const changes = useQuery({
    queryKey: ['phone-diff', session],
    queryFn: async () =>
      diffResponseSchema.parse(await api('GET', `/api/worktrees/${session}/diff?against=base`)),
  });
  const entry = changes.data?.entries.find((entry) => entry.path === path);
  const before = useQuery({
    queryKey: ['phone-before', session, path, entry?.old_path, changes.data?.against],
    queryFn: async () => {
      if (entry?.status === 'added') return { content: '', binary: false };
      return fileAtResponseSchema.parse(
        await api(
          'GET',
          `/api/worktrees/${session}/file-at?ref=${encodeURIComponent(changes.data!.against)}&path=${encodeURIComponent(entry?.old_path ?? path!)}`,
        ),
      );
    },
    enabled: path !== null && !!changes.data,
  });
  const after = useQuery({
    queryKey: ['phone-after', session, path, entry?.status],
    queryFn: async () => {
      if (entry?.status === 'deleted') return { content: '', binary: false };
      return fileResponseSchema.parse(
        await api('GET', `/api/worktrees/${session}/file?path=${encodeURIComponent(path!)}`),
      );
    },
    enabled: path !== null && !!changes.data,
  });
  const error = changes.error ?? (path ? (before.error ?? after.error) : null);
  const binary =
    view === 'diff'
      ? before.data?.binary || after.data?.binary
      : view === 'before'
        ? before.data?.binary
        : after.data?.binary;
  return (
    <section className="phone-review" aria-label="Changes">
      {path === null ? (
        <>
          <p className="mb-2 text-sm text-fg-muted">
            Changes against {changes.data?.base_ref ?? 'base'}
          </p>
          {changes.isPending && <p className="text-sm text-fg-muted">Loading changes…</p>}
          {changes.data?.entries.map((entry) => (
            <Button
              variant="ghost"
              className="phone-file"
              key={entry.path}
              onClick={() => {
                setPath(entry.path);
                setView('diff');
              }}
            >
              {entry.path} · {entry.status}
            </Button>
          ))}
          {changes.data?.entries.length === 0 && (
            <p className="text-sm text-fg-muted">No changes.</p>
          )}
        </>
      ) : (
        <>
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to changes"
              onClick={() => setPath(null)}
            >
              <ArrowLeft />
            </Button>
            <span className="min-w-0 break-all font-mono text-xs">{path} · read only</span>
          </div>
          <nav aria-label="Diff view">
            {(['diff', 'before', 'after'] as const).map((mode) => (
              <Button
                key={mode}
                variant="ghost"
                size="sm"
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
              >
                {mode === 'diff' ? 'Diff' : mode === 'before' ? 'Before' : 'After'}
              </Button>
            ))}
          </nav>
          {binary ? (
            <p className="text-sm text-fg-muted">Binary file; preview unavailable.</p>
          ) : view === 'diff' ? (
            before.data && after.data ? (
              <PhoneDiff before={before.data.content ?? ''} after={after.data.content ?? ''} />
            ) : (
              !error && <p className="text-sm text-fg-muted">Loading diff…</p>
            )
          ) : (view === 'before' ? before.data : after.data) ? (
            <PhoneFileText
              target={[session, path, changes.data?.against, view]}
              content={(view === 'before' ? before.data?.content : after.data?.content) ?? ''}
            />
          ) : (
            !error && <p className="text-sm text-fg-muted">Loading file…</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
    </section>
  );
}

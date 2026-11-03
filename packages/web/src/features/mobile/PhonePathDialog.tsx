import { useEffect, useRef, useState } from 'react';
import { resolvePathResponseSchema, type ResolvePathResponse } from '@puddle/shared';
import { api } from '../../lib/transport/api';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

/** Resolve against the current browse root, using the daemon's directory target. */
export function PhonePathDialog({
  target,
  root,
  path,
  close,
  open,
}: {
  target: string;
  root?: string;
  path: string;
  close(): void;
  open(result: ResolvePathResponse): void;
}) {
  const [draft, setDraft] = useState(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dismissed = useRef(false);
  useEffect(() => {
    dismissed.current = false;
    return () => {
      dismissed.current = true;
    };
  }, []);
  const dismiss = () => {
    dismissed.current = true;
    close();
  };
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) dismiss();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a path</DialogTitle>
          <DialogDescription>Open a file or directory on this host.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            try {
              const query = new URLSearchParams({ path: draft.trim(), root: root ?? '/' });
              const result = resolvePathResponseSchema.parse(
                await api('GET', `/api/worktrees/${target}/resolve?${query}`),
              );
              if (dismissed.current) return;
              open(result);
              dismiss();
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Could not open this path.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Label htmlFor="phone-path">File or directory path</Label>
          <Input
            id="phone-path"
            autoFocus
            value={draft}
            placeholder="/path/to/file or ~/directory"
            onChange={(event) => setDraft(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !draft.trim()}>
              {busy ? 'Opening…' : 'Open path'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import type { PutFileResponse, Session } from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { ApiError, api } from '../../../lib/transport/api';
import { hostNameProblem, typedRootRelativePath } from '../../../lib/host-path';
import { invalidNameMessage, windowsRefusalMessage } from '../../../lib/transport/windows-refusals';
import { useHostPathStyle } from '../../../lib/queries/queries';
import { deleteUntitled } from '../../../lib/queries/untitled-queries';
import { rootParam } from '../../../lib/queries/worktree-queries';
import {
  forgetUntitledContent,
  type UntitledSaveRequest,
} from '../../editor/buffers/untitled-save-store';
import { savedTabPath } from './untitled-save-path';

/**
 * The save-as step for an untitled draft (SPEC §8): pick a worktree-relative
 * path in the BOUND worktree, write the draft there, delete it from the
 * profile's untitled store, and let the Workspace swap the tab. Refuses to
 * overwrite — the target must not exist (the ordinary editor owns existing
 * files).
 */
export function UntitledSaveDialog({
  request,
  targetSession,
  targetRoot,
  targetLabel,
  profileId,
  onClose,
  onSaved,
}: {
  request: UntitledSaveRequest | null;
  /** The sidebar-bound worktree the draft saves into. */
  targetSession: Session | null;
  /**
   * `?root=` when the binding is a directory rather than a worktree (the
   * project's own repository, protocol 12.4) — a draft saves in there just the
   * same, and the tab that replaces it carries the root.
   */
  targetRoot?: string;
  /** What the description names as the destination: a branch, or a directory. */
  targetLabel: string;
  profileId: string | undefined;
  onClose: () => void;
  onSaved: (name: string, sessionId: string, path: string, root?: string) => void;
}) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const style = useHostPathStyle();
  useEffect(() => {
    if (request) {
      setPath(request.name);
      setError(null);
    }
  }, [request]);

  const submit = async () => {
    if (!request || !targetSession) return;
    const rel = typedRootRelativePath(path, style);
    if (rel === '') {
      setError('Give the file a path.');
      return;
    }
    const problem = hostNameProblem(rel, style);
    if (problem !== null) {
      setError(invalidNameMessage(rel, problem));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Never overwrite silently: the target must not already exist.
      let exists = true;
      try {
        await api(
          'GET',
          `/api/worktrees/${targetSession.id}/file?path=${encodeURIComponent(rel)}${rootParam(targetRoot)}`,
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) exists = false;
        else if (e instanceof ApiError && e.status === 413) exists = true;
        else throw e;
      }
      if (exists) {
        setError(`${rel} already exists in ${targetLabel}.`);
        return;
      }
      const saved = await api<PutFileResponse>(
        'PUT',
        `/api/worktrees/${targetSession.id}/file?path=${encodeURIComponent(rel)}${rootParam(targetRoot)}`,
        { content: request.content },
      );
      if (profileId !== undefined) {
        await deleteUntitled(profileId, request.name).catch(() => undefined);
      }
      forgetUntitledContent(request.name);
      onSaved(request.name, targetSession.id, savedTabPath(rel, saved, style), targetRoot);
    } catch (e) {
      setError(windowsRefusalMessage(e) ?? (e instanceof Error ? e.message : 'Save failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save draft into the worktree</DialogTitle>
          <DialogDescription>
            {targetSession ? (
              <>
                Saves into <span className="text-fg-secondary">{targetLabel}</span> — what the
                sidebar is bound to.
              </>
            ) : (
              'No worktree is bound — open or focus a session first.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="untitled-path">Worktree-relative path</Label>
            <Input
              id="untitled-path"
              placeholder="docs/notes.md"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              autoFocus
            />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !targetSession}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

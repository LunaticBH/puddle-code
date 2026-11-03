import { useState } from 'react';
import { Archive, ArchiveRestore, Play, Square } from 'lucide-react';
import type { Session } from '@puddle/shared';
import { api } from '../../lib/transport/api';
import { sessionDisplayName } from '../../lib/session-display';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { SessionGlyph } from '../status/SessionGlyph';

export function SessionActions({
  session,
  connected,
  close,
  changed,
}: {
  session: Session;
  connected: boolean;
  close(): void;
  changed(): Promise<void>;
}) {
  const [title, setTitle] = useState(session.title ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      await changed();
      close();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update this session.');
    } finally {
      setBusy(false);
    }
  };
  const live = ['starting', 'running', 'waiting_input'].includes(session.status);
  const archived = session.status === 'archived';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SessionGlyph
              status={session.status}
              kind={session.kind}
              agentType={session.agent_type}
              detectedAgentType={session.detected_agent_type}
            />
            {sessionDisplayName(session)}
          </DialogTitle>
          <DialogDescription>
            {session.status.replace('_', ' ')}
            {session.agent_type ? ` · ${session.agent_type}` : ' · terminal'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 overflow-hidden font-mono text-xs text-fg-muted">
          <p>{session.branch}</p>
          <p className="break-all">{session.worktree_path}</p>
        </div>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await api('PATCH', `/api/sessions/${session.id}`, { title });
            });
          }}
        >
          <Label htmlFor="session-title">Title</Label>
          <div className="flex gap-2">
            <Input
              id="session-title"
              value={title}
              placeholder="Use the agent’s title"
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Button variant="secondary" disabled={!connected || busy} type="submit">
              Save
            </Button>
          </div>
        </form>
        <div className="grid gap-1">
          {!archived && (
            <Button
              variant="ghost"
              className="justify-start"
              disabled={!connected || busy}
              onClick={() =>
                void action(async () => {
                  await api('POST', `/api/sessions/${session.id}/${live ? 'kill' : 'resume'}`);
                })
              }
            >
              {live ? <Square /> : <Play />}
              {live ? 'Stop session' : 'Resume'}
            </Button>
          )}
          <Button
            variant="ghost"
            className="justify-start"
            disabled={!connected || busy}
            onClick={() =>
              void action(async () => {
                await api(
                  'POST',
                  `/api/sessions/${session.id}/${archived ? 'unarchive' : 'archive'}`,
                );
              })
            }
          >
            {archived ? <ArchiveRestore /> : <Archive />}
            {archived ? 'Restore session' : 'Archive session'}
          </Button>
        </div>
        {message && (
          <p role="alert" className="text-sm text-danger">
            {message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

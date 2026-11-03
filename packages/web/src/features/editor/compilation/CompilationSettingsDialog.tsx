import { useQueryClient } from '@tanstack/react-query';
import type { CompilationSettingsRequest } from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import {
  updateCompilationSettings,
  useCompilationSettings,
} from '../../../lib/queries/compilation-queries';
import { basename } from '../../explorer/explorer-paths';
import { CompilationCommandForm } from './CompilationCommandForm';

export function CompilationSettingsDialog({
  request,
  onOpenChange,
}: {
  request: CompilationSettingsRequest | null;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useCompilationSettings(request);
  const queryClient = useQueryClient();

  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{settings.data?.display_name ?? 'Compilation'} settings</DialogTitle>
          <DialogDescription>
            {request ? basename(request.source.path) : 'This file'} · overrides the language
            defaults for this file in this project.
          </DialogDescription>
        </DialogHeader>
        {settings.isLoading ? (
          <p className="py-4 text-sm text-fg-muted">Loading commands…</p>
        ) : settings.isError ? (
          <p role="alert" className="py-4 text-sm text-danger">
            {settings.error instanceof Error ? settings.error.message : 'Couldn’t load commands'}
          </p>
        ) : settings.data && request ? (
          <CompilationCommandForm
            key={JSON.stringify(request)}
            settings={settings.data}
            onCancel={() => onOpenChange(false)}
            onSave={async (changes) => {
              for (const change of changes) {
                const latest = await updateCompilationSettings({ ...request, ...change });
                queryClient.setQueryData(['compilation-settings', request], latest);
              }
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

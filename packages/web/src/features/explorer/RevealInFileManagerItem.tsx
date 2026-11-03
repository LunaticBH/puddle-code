import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cockpitFileManagerSchema, type CockpitRevealRequest } from '@puddle/shared';
import { ContextMenuItem } from '../../components/ui/context-menu';
import { api } from '../../lib/transport/api';
import { browserTransport } from '../../lib/transport/browser-transport';

/** Mounted only in an open menu; capability discovery is shared across menus. */
export function RevealInFileManagerItem({ path }: { path: string }) {
  const remote = browserTransport();
  const manager = useQuery({
    queryKey: ['cockpit-file-manager'],
    queryFn: async () => cockpitFileManagerSchema.parse(await api('GET', '/cockpit/file-manager')),
    enabled: !remote,
    staleTime: Infinity,
    retry: false,
  });
  if (remote || !manager.data?.name || !path) return null;
  return (
    <ContextMenuItem
      onSelect={() => {
        if (browserTransport()) return;
        void api('POST', '/cockpit/file-manager', { path } satisfies CockpitRevealRequest).catch(
          (error: unknown) =>
            toast.error(error instanceof Error ? error.message : 'Could not reveal this path.'),
        );
      }}
    >
      Reveal in {manager.data.name}
    </ContextMenuItem>
  );
}

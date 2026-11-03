import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { PROTOCOL_VERSION, sessionSchema } from '@puddle/shared';
import { ExplorerProvider } from '../../src/features/explorer/explorer-context';
import { FileExplorer } from '../../src/features/explorer/FileExplorer';
import { FileTabContextMenu } from '../../src/features/explorer/FileTabContextMenu';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { installBrowserTransport } from '../../src/lib/transport/browser-transport';
import '../../src/styles/app.css';

const params = new URLSearchParams(location.search);
const root = params.has('browse') ? '/outside/library' : undefined;
const session = sessionSchema.parse({
  id: '20000000-0000-4000-8000-000000000001',
  project_id: '1000000001',
  worktree_path: '/work/project',
  base_branch: 'main',
  branch: 'main',
  separate_branch: false,
  kind: 'terminal',
  status: 'running',
  skip_permissions: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_activity_at: '2026-01-01T00:00:00Z',
  ended_at: null,
  account_id: null,
  agent_type: null,
  agent_session_ref: null,
  title: null,
});
const query = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
query.setQueryData(['host'], { hostname: 'local-host', home: '/home/example' });
query.setQueryData(['version'], { protocol: PROTOCOL_VERSION, version: 'fixture' });
query.setQueryData(root ? ['wt-tree', session.id, '', root] : ['wt-tree', session.id, ''], {
  entries: [
    { name: 'src', type: 'dir' },
    { name: 'read me.txt', type: 'file' },
  ],
});
query.setQueryData(root ? ['wt-git-status', session.id, root] : ['wt-git-status', session.id], {
  entries: [],
});
if (params.has('remote')) {
  // Even a stale local capability must never leak into a remote host's menus.
  query.setQueryData(['cockpit-file-manager'], { name: 'Finder' });
  installBrowserTransport({
    scope: 'remote-fixture',
    request: async () => {
      throw new Error('Remote fixture must not request local OS operations');
    },
    socket: () => {
      throw new Error('No sockets in this fixture');
    },
    input: async () => {},
  });
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={query}>
    <TooltipProvider>
      <div style={{ height: 300 }}>
        <ExplorerProvider
          session={session}
          root={root}
          activePath={null}
          compilableExtensions={new Set()}
        >
          <FileExplorer />
        </ExplorerProvider>
      </div>
      <FileTabContextMenu
        tab={{ session: session.id, path: 'read me.txt' }}
        directory={session.worktree_path}
        onReveal={() => {}}
        onRename={() => {}}
      >
        <button>Worktree file tab</button>
      </FileTabContextMenu>
      <FileTabContextMenu
        tab={{ kind: 'external', session: session.id, root: '/outside/library', path: 'notes.txt' }}
        directory="/outside/library"
        onReveal={() => {}}
        onRename={() => {}}
      >
        <button>External file tab</button>
      </FileTabContextMenu>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
);

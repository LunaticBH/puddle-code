import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { Switch } from '../../src/components/ui/switch';
import { PhoneFiles } from '../../src/features/mobile/PhoneFiles';
import { installBrowserTransport } from '../../src/lib/transport/browser-transport';
import '../../src/styles/app.css';
import '../../src/features/remote/remote.css';

declare global {
  interface Window {
    readMobileFile(path: string): Promise<{ status: number; body: unknown }>;
    leaveMobileHost(): void;
  }
}
window.leaveMobileHost = () => installBrowserTransport(null);

installBrowserTransport({
  scope: 'mobile-files-fixture',
  request: async (_method, path) => {
    const response = await window.readMobileFile(path);
    return Response.json(response.body, { status: response.status });
  },
  socket: () => {
    throw new Error('No socket in the file fixture');
  },
  input: async () => {},
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <div role="dialog" aria-label="Switches" className="flex items-center gap-2">
      <Switch id="branch" />
      <label htmlFor="branch">Use separate branch</label>
      <Switch aria-label="Disabled switch" disabled />
    </div>
    <div style={{ height: '75vh' }}>
      <PhoneFiles worktree="/project" terminals={() => {}} />
    </div>
    <Toaster />
  </QueryClientProvider>,
);

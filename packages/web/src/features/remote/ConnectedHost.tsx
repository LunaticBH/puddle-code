import { useEffect, useState } from 'react';
import { House, Monitor, Settings2, ShieldCheck } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { ErrorBoundary } from '../../components/error-boundary';
import { installBrowserTransport } from '../../lib/transport/browser-transport';
import { wsManager } from '../../lib/transport/ws';
import { DeviceAccess } from './DeviceAccess';
import { PhoneWorkspace } from '../mobile/PhoneWorkspace';
import { watchPushNotifications } from './push-notifications';
import type { RemoteClient } from './client';

export function ConnectedHost({
  client,
  initialProject,
  notificationTarget,
  hostName,
  leave,
  settings,
}: {
  client: RemoteClient;
  initialProject: string;
  notificationTarget?: import('@puddle/shared').NotificationTarget;
  hostName: string;
  leave(): void;
  settings(): void;
}) {
  const [state, setState] = useState(client.state);
  const [admitted, setAdmitted] = useState(false);
  const [devices, setDevices] = useState(false);
  useEffect(() => {
    if (notificationTarget) setDevices(false);
  }, [notificationTarget]);
  const [projectName, setProjectName] = useState('');
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 5_000 },
          mutations: { retry: false },
        },
      }),
  );
  useEffect(() => {
    installBrowserTransport(client);
    wsManager.switchHost();
    const off = client.onState(() => {
      setState(client.state);
      if (client.state === 'ready') {
        setAdmitted(true);
        void queryClient.invalidateQueries();
      }
    });
    const offPush = watchPushNotifications(client);
    client.start();
    return () => {
      off();
      offPush();
      client.close();
      wsManager.switchHost();
      installBrowserTransport(null);
      queryClient.clear();
    };
  }, [client, queryClient]);
  const status =
    state === 'ready'
      ? 'Connected'
      : state === 'pairing'
        ? 'Waiting for host approval'
        : state === 'rejected'
          ? 'Pairing required or access revoked'
          : 'Reconnecting…';
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary scope="remote host">
        <div className="remote-connected">
          <header className="remote-topbar">
            <Button variant="ghost" size="icon" aria-label="All projects" onClick={leave}>
              <House />
            </Button>
            <button
              className="min-w-0 flex-1 truncate text-left text-xs text-fg-muted hover:text-fg"
              aria-label="Back to all projects"
              title={projectName ? `${hostName}/${projectName}` : hostName}
              onClick={leave}
            >
              {hostName}
              {projectName && `/${projectName}`}
            </button>
            <span role="status" className={state === 'ready' ? 'sr-only' : 'text-xs text-fg-muted'}>
              {status}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Paired browsers"
              disabled={state !== 'ready'}
              onClick={() => setDevices(true)}
            >
              <ShieldCheck />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Settings" onClick={settings}>
              <Settings2 />
            </Button>
          </header>
          {!admitted && (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <div className="max-w-sm space-y-5 text-center">
                <Monitor className="mx-auto size-8 text-fg-muted" />
                <h1 className="text-lg font-semibold">
                  {state === 'pairing' ? 'Approve this browser' : status}
                </h1>
                {state === 'pairing' && client.pendingDevice && (
                  <>
                    <p className="text-sm text-fg-secondary">
                      Open Remote & Sync → Connected browsers on your host and approve this
                      browser’s identity.
                    </p>
                    <code className="block break-all rounded-md bg-surface p-3 text-xs">
                      {client.pendingDevice.peer}
                    </code>
                    <p className="text-xs text-fg-muted">Or run on the host:</p>
                    <code className="block break-all text-xs">{`puddle remote approve ${client.pendingDevice.id}`}</code>
                  </>
                )}
                <Button variant="ghost" onClick={leave}>
                  Back to projects
                </Button>
              </div>
            </div>
          )}
          {admitted && (
            <div className="remote-workspace">
              <PhoneWorkspace
                connected={state === 'ready' && !devices}
                initialProject={initialProject}
                notificationTarget={notificationTarget}
                hostName={hostName}
                onProjectName={setProjectName}
              />
            </div>
          )}
          <Dialog open={devices} onOpenChange={setDevices}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Paired browsers</DialogTitle>
                <DialogDescription>{hostName}</DialogDescription>
              </DialogHeader>
              {devices && <DeviceAccess client={client} leave={leave} />}
            </DialogContent>
          </Dialog>
        </div>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

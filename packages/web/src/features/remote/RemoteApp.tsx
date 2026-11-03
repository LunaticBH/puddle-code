import { useEffect, useRef, useState } from 'react';
import {
  remoteHostsSchema,
  remoteLoginStateSchema,
  remoteServiceInfoSchema,
  type RemoteHost,
  type RemoteInvitation,
  notificationTargetSchema,
  type NotificationTarget,
} from '@puddle/shared';
import { createIdentity } from '@puddle/remote-transport';
import { AccountAccess } from './AccountAccess';
import { GuideLink } from '../guide/GuideLink';
import { serviceOrigin, serviceRequest } from './service';
import { loadBrowserHost, saveBrowserHost } from './identity-store';
import { RemoteClient } from './client';
import { ConnectedHost } from './ConnectedHost';
import { Settings2, Laptop, ScanLine } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { TooltipProvider } from '../../components/ui/tooltip';
import { Toaster } from '../../components/ui/sonner';
import { ErrorBoundary } from '../../components/error-boundary';
import { usePhoneViewport } from '../mobile/use-phone-viewport';
import { HostProjects } from './HostProjects';
import { RemoteSettings } from './RemoteSettings';
import { RemoteBrand } from './RemoteBrand';
import { PairBrowserDialog } from './PairBrowserDialog';
import { PairDeviceDialog } from './PairDeviceDialog';
import { parsePairingInvitation, takePairingInvitation } from './pairing-invitation';
import { DesktopRegistrationPrompt, takeDesktopRegistration } from './DesktopRegistration';
import { onNotificationTarget } from '../../lib/notifications/notification-navigation';
import './remote.css';

const initialRegistration = takeDesktopRegistration();
const initialInvitation = takePairingInvitation(serviceOrigin);

export function RemoteApp() {
  const [login, setLogin] = useState<ReturnType<typeof remoteLoginStateSchema.parse> | null>(null);
  const [providers, setProviders] = useState<Array<'google' | 'github'>>([]);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [client, setClient] = useState<RemoteClient | null>(null);
  const connectionAttempt = useRef(0);
  const [projectId, setProjectId] = useState('');
  const [notificationTarget, setNotificationTarget] = useState<NotificationTarget>();
  const [settings, setSettings] = useState(false);
  const [pairingDevice, setPairingDevice] = useState(false);
  const [disconnected, setDisconnected] = useState<Set<string>>(new Set());
  const [desktopRegistration, setDesktopRegistration] = useState(initialRegistration.request);
  const [invitation, setInvitation] = useState(initialInvitation);
  const [message, setMessage] = useState(initialRegistration.error);
  const [notificationHost, setNotificationHost] = useState<{
    host: string;
    target?: NotificationTarget;
  } | null>(() => {
    const url = new URL(location.href);
    const host = url.searchParams.get('notificationHost');
    const target = notificationTargetSchema.safeParse({
      host,
      project: url.searchParams.get('notificationProject'),
      session: url.searchParams.get('notificationSession'),
    });
    // Keep the URL until consumed so OAuth/MFA and a reload retain the destination.
    return host ? { host, ...(target.success ? { target: target.data } : {}) } : null;
  });
  useEffect(
    () =>
      onNotificationTarget((target) => {
        if (target.host) {
          const url = new URL(location.href);
          url.searchParams.set('notificationHost', target.host);
          url.searchParams.set('notificationProject', target.project);
          url.searchParams.set('notificationSession', target.session);
          history.replaceState(null, '', url);
          setNotificationHost({ host: target.host, target });
        }
      }),
    [],
  );
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const click = (event: MessageEvent) => {
      if (
        event.data?.t === 'notification-click' &&
        !event.data.target &&
        typeof event.data.host === 'string'
      )
        setNotificationHost({ host: event.data.host });
    };
    navigator.serviceWorker.addEventListener('message', click);
    return () => navigator.serviceWorker.removeEventListener('message', click);
  }, []);
  const [busy, setBusy] = useState(false);
  usePhoneViewport();
  const refresh = async () => {
    const state = remoteLoginStateSchema.parse(await serviceRequest('/remote/me'));
    setLogin(state);
    if (state.user?.emailVerified && !state.mfaRequired)
      setHosts(remoteHostsSchema.parse(await serviceRequest('/remote/hosts')));
    else setHosts([]);
  };
  useEffect(() => {
    void Promise.all([
      refresh(),
      serviceRequest('/remote/config').then((value) =>
        setProviders(remoteServiceInfoSchema.parse(value).providers),
      ),
    ]).catch(() => setMessage('Could not reach the remote service. Reload to try again.'));
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (login && (!login.user || login.mfaRequired)) {
      connectionAttempt.current++;
      client?.close();
      setClient(null);
      setDisconnected(new Set());
    }
  }, [login, client]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  };
  const connect = async (host: string, project = '', pairing?: RemoteInvitation, label = '') => {
    if (!login?.user) return false;
    const attempt = ++connectionAttempt.current;
    if (pairing) parsePairingInvitation(JSON.stringify(pairing), serviceOrigin);
    let identity = await loadBrowserHost(serviceOrigin, login.user.id, host);
    if (pairing && identity && identity.peer !== pairing.peer)
      throw new Error(
        'The host identity has changed. Forget the old pairing in settings before accepting its replacement.',
      );
    if (!identity) {
      if (!pairing)
        throw new Error(
          'Pair this browser using a link from the host or an already paired browser.',
        );
      if (!label.trim()) throw new Error('Enter a name for this browser.');
      identity = {
        host,
        service: serviceOrigin,
        account: login.user.id,
        peer: pairing.peer,
        label: label.trim(),
        privateKey: [...(await createIdentity())],
      };
      await saveBrowserHost(identity);
    }
    if (connectionAttempt.current !== attempt) return false;
    client?.close();
    setProjectId(project);
    setNotificationTarget(undefined);
    setClient(new RemoteClient(identity, pairing?.invitation));
    setDisconnected((current) => {
      const next = new Set(current);
      next.delete(host);
      return next;
    });
    if (pairing) {
      sessionStorage.removeItem('puddle.pending-pair');
      setInvitation(null);
    }
    return true;
  };
  useEffect(() => {
    if (
      !notificationHost ||
      !login?.user ||
      login.mfaRequired ||
      !hosts.some((host) => host.id === notificationHost.host)
    )
      return;
    const target = notificationHost;
    setNotificationHost(null);
    setSettings(false);
    setPairingDevice(false);
    const open = async () => {
      if (
        client?.host.host !== target.host &&
        !(await connect(target.host, target.target?.project))
      )
        return;
      setNotificationTarget(target.target);
      const url = new URL(location.href);
      for (const key of ['notificationHost', 'notificationProject', 'notificationSession'])
        url.searchParams.delete(key);
      history.replaceState(null, '', url);
    };
    void open().catch((error: Error) => setMessage(error.message));
  }, [notificationHost, login, hosts]);
  const leave = () => {
    connectionAttempt.current++;
    client?.close();
    setClient(null);
  };
  const pairDevice = () => {
    setSettings(false);
    setMessage('');
    setPairingDevice(true);
  };
  return (
    <TooltipProvider>
      <Toaster />
      <ErrorBoundary scope="remote app">
        {!login ? (
          <main className="remote-account">
            <RemoteBrand />
            <p role="status" className="mt-4 text-sm text-fg-muted">
              {message || 'Connecting…'}
            </p>
          </main>
        ) : !login.user || login.mfaRequired ? (
          <AccountAccess providers={providers} mfa={login.mfaRequired} refresh={refresh} />
        ) : (
          <div className="remote-ui">
            {client ? (
              <ConnectedHost
                key={client.scope}
                client={client}
                initialProject={projectId}
                notificationTarget={notificationTarget}
                hostName={hosts.find((host) => host.id === client.host.host)?.label ?? 'Host'}
                leave={leave}
                settings={() => setSettings(true)}
              />
            ) : (
              <main className="remote-dashboard" aria-label="Hosts and projects">
                <header className="mb-3 flex items-center justify-between">
                  <RemoteBrand />
                  <div className="flex">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Pair this device"
                      onClick={pairDevice}
                    >
                      <ScanLine />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Settings"
                      onClick={() => setSettings(true)}
                    >
                      <Settings2 />
                    </Button>
                  </div>
                </header>
                <GuideLink className="mb-4" />
                {hosts.map((host) => (
                  <HostProjects
                    key={`${login.user!.id}:${host.id}`}
                    host={host}
                    account={login.user!.id}
                    disconnected={disconnected.has(host.id)}
                    pair={pairDevice}
                    reconnect={() =>
                      setDisconnected((current) => {
                        const next = new Set(current);
                        next.delete(host.id);
                        return next;
                      })
                    }
                    open={(project) => void action(() => connect(host.id, project.id))}
                  />
                ))}
                {hosts.length === 0 && (
                  <div className="py-12 text-center">
                    <Laptop className="mx-auto mb-4 size-8 text-fg-muted" />
                    <p className="text-sm text-fg-secondary">
                      Register a host in desktop Settings → Remote &amp; Sync, then pair this
                      device.
                    </p>
                    <Button className="mt-4" variant="secondary" onClick={pairDevice}>
                      Pair this device
                    </Button>
                  </div>
                )}
                {message && !invitation && (
                  <p role="status" className="mt-4 text-sm text-fg-secondary">
                    {message}
                  </p>
                )}
              </main>
            )}
            <RemoteSettings
              open={settings}
              onOpenChange={setSettings}
              hosts={hosts}
              account={login.user.id}
              email={login.user.email}
              mfa={login.user.twoFactorEnabled}
              disconnected={disconnected}
              disconnect={(id) => {
                setDisconnected((current) => new Set([...current, id]));
                if (client?.host.host === id) leave();
              }}
              reconnect={(id) =>
                setDisconnected((current) => {
                  const next = new Set(current);
                  next.delete(id);
                  return next;
                })
              }
              refresh={refresh}
              pair={pairDevice}
            />
            {pairingDevice && (
              <PairDeviceDialog
                dismiss={() => setPairingDevice(false)}
                accept={(invitation) => {
                  sessionStorage.setItem('puddle.pending-pair', JSON.stringify(invitation));
                  setMessage('');
                  setPairingDevice(false);
                  setInvitation(invitation);
                }}
              />
            )}
            {desktopRegistration && (
              <DesktopRegistrationPrompt
                request={desktopRegistration}
                dismiss={() => setDesktopRegistration(null)}
                complete={async () => {
                  setMessage('Host confirmed. Return to desktop to finish enabling remote access.');
                  await refresh();
                }}
              />
            )}
            {invitation && (
              <PairBrowserDialog
                invitation={invitation}
                hostName={hosts.find((host) => host.id === invitation.host)?.label}
                busy={busy}
                error={message}
                dismiss={() => {
                  setInvitation(null);
                  setMessage('');
                  sessionStorage.removeItem('puddle.pending-pair');
                }}
                pair={(label) => void action(() => connect(invitation.host, '', invitation, label))}
              />
            )}
          </div>
        )}
      </ErrorBoundary>
    </TooltipProvider>
  );
}

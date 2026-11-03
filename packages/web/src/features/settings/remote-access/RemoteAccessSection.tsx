import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  cockpitRemoteStatusSchema,
  remoteAdminResponseSchema,
  type CockpitRemoteRequest,
} from '@puddle/shared';
import { api, ApiError } from '../../../lib/transport/api';
import { useCurrentProfileId } from '../../profile/profile-store';
import { hostStyleForPlatform } from '../../../lib/host-path';
import { useHostInfo, useProfiles } from '../../../lib/queries/queries';
import { Button } from '../../../components/ui/button';
import { Disclosure } from '../../../components/ui/disclosure';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../../../components/ui/dialog';
import { SectionTitle } from '../parts';
import { RegistrationForm } from './RegistrationForm';
import { PairingInvitation } from './PairingInvitation';
import { DeviceList } from './DeviceList';
import { DeleteRegistrationDialog } from './DeleteRegistrationDialog';

export function RemoteAccessSection() {
  const queryClient = useQueryClient();
  const host = useHostInfo();
  // The relay connector does not run on Windows hosts in v1 (docs/windows.md).
  const windowsHost = hostStyleForPlatform(host.data?.platform) === 'win32';
  const profile = useCurrentProfileId();
  const profiles = useProfiles();
  const profileName = profiles.data?.find((row) => row.id === profile)?.name ?? 'this profile';
  const path = `/cockpit/remote?profile=${encodeURIComponent(profile ?? '')}`;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [replace, setReplace] = useState(false);
  const [reset, setReset] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [invitation, setInvitation] = useState<{ url: string; expires: number } | null>(null);
  const dismiss = useCallback(() => setInvitation(null), []);
  const status = useQuery({
    queryKey: ['cockpit-remote', profile],
    queryFn: async () => cockpitRemoteStatusSchema.parse(await api('GET', path)),
    refetchInterval: busy ? false : 5000,
    refetchOnWindowFocus: !busy,
    refetchOnReconnect: !busy,
    retry: false,
    gcTime: 0,
    enabled: !!profile && !windowsHost,
  });
  const act = async (request: CockpitRemoteRequest): Promise<boolean> => {
    if (busy || !profile) return false;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      // Keep background reads quiet, but let them finish before the serial host mutation.
      if (queryClient.isFetching({ queryKey: ['cockpit-remote', profile], exact: true })) {
        const latest = await status.refetch({ cancelRefetch: false });
        if (latest.isError) throw latest.error;
      }
      const result = remoteAdminResponseSchema.parse(await api('POST', path, request));
      if (request.t === 'pair' && result.url && result.invitation)
        setInvitation({ url: result.url, expires: result.invitation.expires });
      else {
        setMessage(
          {
            enable: 'Remote access enabled.',
            approve: 'Browser approved.',
            revoke: 'Browser revoked.',
            disable: 'Remote access disabled. Agents continue running.',
            delete_registration: 'Registration deleted from this host. Agents continue running.',
            reset: 'Host identity rotated and all browsers revoked. Enable access and pair again.',
            status: 'Status refreshed.',
            devices: 'Browsers refreshed.',
            pair: 'Invitation created.',
          }[request.t],
        );
        if (
          request.t === 'disable' ||
          request.t === 'reset' ||
          request.t === 'enable' ||
          request.t === 'delete_registration'
        )
          dismiss();
      }
      if (request.t === 'enable' || request.t === 'delete_registration') setReplace(false);
      setReset(false);
      setDeleting(false);
      await status.refetch();
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Host operation failed. Refresh status before retrying.',
      );
      await status.refetch();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const data = status.data;
  const unavailable = status.error instanceof ApiError && status.error.status === 404;
  const disabled = busy || status.isError;
  const title = (
    <SectionTitle
      note={`${profileName} on ${host.data?.displayName || host.data?.hostname || 'this host'} · only this profile’s projects and sessions`}
    >
      Remote access
    </SectionTitle>
  );
  if (windowsHost) {
    return (
      <div>
        {title}
        <p role="status" className="mt-5 text-sm text-fg-secondary">
          Remote access is not available on Windows hosts yet.
        </p>
      </div>
    );
  }
  return (
    <div>
      {title}
      <div className="mt-5 flex items-center justify-between gap-3">
        <span role="status" className="text-sm font-medium">
          {status.isError
            ? 'Status unavailable'
            : !data
              ? 'Checking remote access…'
              : data.availability !== 'ready'
                ? 'Daemon upgrade required'
                : !data.configured
                  ? 'Not configured'
                  : !data.enabled
                    ? 'Disabled'
                    : data.connected
                      ? 'Connected to relay'
                      : 'Enabled · relay disconnected'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void status.refetch({ cancelRefetch: false })}
        >
          <RefreshCw />
          Refresh status
        </Button>
      </div>
      {status.isError && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {unavailable
            ? 'This cockpit does not provide remote controls. Update Puddle and reopen this window.'
            : status.error.message}
        </p>
      )}
      {error && !deleting && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {message}
        </p>
      )}
      {data?.availability !== undefined && data.availability !== 'ready' && (
        <p className="mt-3 text-sm text-fg-secondary">
          Update the daemon on this host, then refresh status to set up mobile access.
        </p>
      )}
      {data?.availability === 'ready' && (
        <>
          {!data.enabled && data.supervisor && (!data.configured || replace) ? (
            <RegistrationForm
              key={data.host ?? 'new'}
              service={data.service}
              app={data.app}
              hostName={`${host.data?.displayName || host.data?.hostname || 'My host'} · ${profileName}`}
              busy={busy}
              disabled={disabled}
              enable={act}
              cancel={data.configured ? () => setReplace(false) : undefined}
            />
          ) : data.configured ? (
            <dl className="mt-4 space-y-2 text-xs text-fg-secondary">
              <div>
                <dt className="text-fg-muted">Application</dt>
                <dd className="break-all">
                  <a href={data.app} target="_blank" rel="noreferrer" className="hover:text-fg">
                    {data.app} ↗
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">Relay</dt>
                <dd className="break-all">{data.service}</dd>
              </div>
              {data.peer && (
                <div>
                  <dt className="text-fg-muted">Host identity</dt>
                  <dd className="break-all font-mono">{data.peer}</dd>
                </div>
              )}
            </dl>
          ) : null}
          {!data.enabled && !data.supervisor && (
            <p className="mt-4 text-sm text-fg-secondary">
              This host needs persistent systemd or launchd supervision before access can be enabled
              here. For another supervisor, configure both the daemon and connector using the remote
              CLI commands.
            </p>
          )}
          {data.configured && (
            <div
              className="mt-4 flex flex-wrap gap-2"
              role="group"
              aria-label="Registration actions"
            >
              {!data.enabled && data.supervisor && !replace && (
                <>
                  <Button disabled={disabled} onClick={() => void act({ t: 'enable' })}>
                    Enable remote access
                  </Button>
                  <Button variant="ghost" disabled={disabled} onClick={() => setReplace(true)}>
                    Change registration
                  </Button>
                </>
              )}
              {data.enabled && (
                <>
                  <Button disabled={disabled} onClick={() => void act({ t: 'pair' })}>
                    Pair a browser
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void act({ t: 'disable' })}
                  >
                    Disable remote access
                  </Button>
                </>
              )}
              {data.canDeleteRegistration && (
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setError('');
                    setDeleting(true);
                  }}
                >
                  Delete registration
                </Button>
              )}
            </div>
          )}
          {invitation && data.enabled && <PairingInvitation {...invitation} dismiss={dismiss} />}
          {data.configured && (
            <>
              <DeviceList
                devices={data.devices}
                now={status.dataUpdatedAt}
                busy={disabled}
                act={act}
              />
              <Disclosure
                className="text-sm"
                summary="Host identity recovery"
                summaryClassName="py-2"
              >
                <p className="my-3 text-xs text-fg-muted">
                  Rotate a lost or compromised host identity. This profile’s browser approvals and
                  invitations will be revoked.
                </p>
                <Button variant="ghost" disabled={disabled} onClick={() => setReset(true)}>
                  Reset host identity…
                </Button>
              </Disclosure>
            </>
          )}
        </>
      )}
      <Dialog open={reset} onOpenChange={(open) => !busy && setReset(open)}>
        <DialogContent>
          <DialogTitle>Reset this profile’s remote identity?</DialogTitle>
          <DialogDescription>
            Disable remote access, rotate the host identity and revoke this profile’s paired
            browsers and invitation. Agents keep running. Enable access and pair each browser again
            afterwards.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void act({ t: 'reset' })}>
              Reset host identity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteRegistrationDialog
        open={deleting}
        busy={busy}
        error={error}
        onOpenChange={setDeleting}
        onConfirm={() => void act({ t: 'delete_registration' })}
      />
    </div>
  );
}

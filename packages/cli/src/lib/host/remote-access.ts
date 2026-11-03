import {
  cockpitRemoteRequestSchema,
  profileId,
  cockpitRemoteStatusSchema,
  remoteAdminResponseSchema,
  type CockpitRemoteRequest,
  type CockpitRemoteStatus,
  type RemoteAdminResponse,
} from '@puddle/shared';
import { hostPaths } from '../paths.js';
import { isLocalWindows } from '../transport/local.js';
import type { Transport } from '../transport/transport.js';

const binary = `${hostPaths.current}/bin/node ${hostPaths.current}/daemon/connector.mjs`;

/** Windows hosts have no connector supervision in v1 (docs/windows.md). */
export const WINDOWS_REMOTE_ACCESS_UNSUPPORTED =
  'Remote access is not supported on Windows hosts yet.';

/** Fixed host commands only; browser values travel exclusively through JSON stdin. */
export class RemoteAccessControl {
  constructor(private readonly transport: Transport) {}

  private async capabilities(): Promise<{
    availability: CockpitRemoteStatus['availability'];
    canDeleteRegistration: boolean;
  }> {
    if (isLocalWindows(this.transport)) {
      return { availability: 'unsupported', canDeleteRegistration: false };
    }
    const result = await this.transport.exec(
      `if test -f ${hostPaths.current}/daemon/connector.mjs; then ${binary} --version; else exit 44; fi`,
      { timeoutMs: 10_000 },
    );
    if (result.code === 44) return { availability: 'not_installed', canDeleteRegistration: false };
    if (result.code !== 0)
      throw new Error('Host control is unavailable. Check the host connection.');
    return {
      availability: result.stdout.includes('cockpit controls 2') ? 'ready' : 'upgrade_required',
      canDeleteRegistration: result.stdout.includes('delete registration 1'),
    };
  }

  async status(profile: string): Promise<CockpitRemoteStatus> {
    profileId.parse(profile);
    const capabilities = await this.capabilities();
    if (capabilities.availability !== 'ready')
      return {
        ...capabilities,
        configured: false,
        enabled: false,
        connected: false,
        supervisor: null,
        devices: [],
      };
    const result = await this.transport.exec(`${binary} --inspect`, {
      timeoutMs: 10_000,
      stdin: JSON.stringify({ profile }) + '\n',
    });
    if (result.code !== 0) throw new Error('Could not read remote access status on this host.');
    return cockpitRemoteStatusSchema.parse({ ...JSON.parse(result.stdout), ...capabilities });
  }

  async request(
    value: CockpitRemoteRequest,
    authorised: () => boolean,
    profile: string,
  ): Promise<RemoteAdminResponse> {
    const request = cockpitRemoteRequestSchema.parse(value);
    profileId.parse(profile);
    const capabilities = await this.capabilities();
    if (capabilities.availability === 'unsupported')
      throw new Error(WINDOWS_REMOTE_ACCESS_UNSUPPORTED);
    if (capabilities.availability !== 'ready')
      throw new Error('Upgrade the daemon on this host to manage remote access here.');
    if (request.t === 'delete_registration' && !capabilities.canDeleteRegistration)
      throw new Error('Upgrade the daemon on this host to delete its remote registration.');
    if (!authorised()) throw new Error('Browser authorisation expired before dispatch.');
    const flag =
      request.t === 'enable' ? '--configure' : request.t === 'reset' ? '--reset' : '--admin';
    const payload =
      request.t === 'enable'
        ? { profile, setup: { ...request.registration, managed: true } }
        : request.t === 'reset'
          ? { profile }
          : { profile, request };
    const result = await this.transport.exec(`${binary} ${flag}`, {
      stdin: JSON.stringify(payload) + '\n',
      timeoutMs: 30_000,
    });
    // Do not reflect subprocess output: it can contain a registration code or invitation.
    if (result.code !== 0)
      throw new Error(
        request.t === 'enable'
          ? 'Could not enable remote access. Check the origins, an unused registration code and persistent host supervision. Refresh status before retrying.'
          : 'The host operation failed or was interrupted. Refresh status before retrying.',
      );
    if (request.t === 'reset') return { enabled: false, connected: false };
    const response = remoteAdminResponseSchema.parse(JSON.parse(result.stdout));
    if (response.error) throw new Error(response.error);
    return response;
  }
}

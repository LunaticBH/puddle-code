import {
  cockpitRemoteRequestSchema,
  profileId,
  cockpitRemoteStatusSchema,
  remoteAdminResponseSchema,
  type CockpitRemoteRequest,
  type CockpitRemoteStatus,
  type RemoteAdminResponse,
} from '@puddle/shared';
import { readCurrentVersion } from '../installation/current-link.js';
import {
  runWindowsConnector,
  windowsConnectorInstalled,
  type WindowsConnectorRunner,
} from '../installation/windows-connector.js';
import { clientHome, hostPaths } from '../paths.js';
import { isLocalWindows } from '../transport/local.js';
import type { Transport } from '../transport/transport.js';

const binary = `${hostPaths.current}/bin/node ${hostPaths.current}/daemon/connector.mjs`;

interface Capabilities {
  availability: CockpitRemoteStatus['availability'];
  canDeleteRegistration: boolean;
}

const capabilitiesOf = (version: string): Capabilities => ({
  availability: version.includes('cockpit controls 2') ? 'ready' : 'upgrade_required',
  canDeleteRegistration: version.includes('delete registration 1'),
});

/**
 * Fixed host commands only; browser values travel exclusively through JSON
 * stdin. On this Windows machine the installed node.exe runs the connector
 * directly (docs/windows.md): there is no shell to give a command line to.
 */
export class RemoteAccessControl {
  /** Windows: `--version` answers once per installed release, not on every status poll. */
  private windowsCapabilities: { version: string; value: Capabilities } | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly windows: { run?: WindowsConnectorRunner; home?: () => string } = {},
  ) {}

  private home(): string {
    return this.windows.home?.() ?? clientHome();
  }

  /** One connector mode (`flag`) with JSON on stdin. */
  private run(
    flag: string,
    opts: { stdin?: string; timeoutMs: number },
  ): Promise<{ code: number; stdout: string }> {
    if (isLocalWindows(this.transport)) {
      return (this.windows.run ?? runWindowsConnector)(this.home(), [flag], opts);
    }
    return this.transport.exec(`${binary} ${flag}`, opts);
  }

  private async capabilities(): Promise<Capabilities> {
    if (isLocalWindows(this.transport)) return this.localWindowsCapabilities();
    const result = await this.transport.exec(
      `if test -f ${hostPaths.current}/daemon/connector.mjs; then ${binary} --version; else exit 44; fi`,
      { timeoutMs: 10_000 },
    );
    if (result.code === 44) return { availability: 'not_installed', canDeleteRegistration: false };
    if (result.code !== 0)
      throw new Error('Host control is unavailable. Check the host connection.');
    return capabilitiesOf(result.stdout);
  }

  private async localWindowsCapabilities(): Promise<Capabilities> {
    const home = this.home();
    if (!windowsConnectorInstalled(home)) {
      return { availability: 'not_installed', canDeleteRegistration: false };
    }
    const version = readCurrentVersion(home, 'win32');
    if (version !== undefined && this.windowsCapabilities?.version === version) {
      return this.windowsCapabilities.value;
    }
    const result = await this.run('--version', { timeoutMs: 10_000 });
    if (result.code !== 0)
      throw new Error('Host control is unavailable. Check the host connection.');
    const value = capabilitiesOf(result.stdout);
    this.windowsCapabilities = version === undefined ? undefined : { version, value };
    return value;
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
    const result = await this.run('--inspect', {
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
    const result = await this.run(flag, {
      stdin: JSON.stringify(payload) + '\n',
      // A Windows enable may start the home's supervisor first.
      timeoutMs: isLocalWindows(this.transport) && request.t === 'enable' ? 120_000 : 30_000,
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

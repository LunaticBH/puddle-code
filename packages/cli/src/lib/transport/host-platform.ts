import { isLocalWindows } from './local.js';
import { SshTransport } from './ssh.js';
import type { Transport } from './transport.js';

/** An SSH transport to a host recognised as Windows (SshTransport.remotePlatform). */
export function remoteWindows(transport: Transport): SshTransport | null {
  return transport instanceof SshTransport && transport.remotePlatform === 'win32'
    ? transport
    : null;
}

/**
 * Whether host operations take their Windows implementations: this machine
 * on Windows, or an SSH host recognised as Windows (docs/windows.md).
 */
export function isWindowsHost(transport: Transport): boolean {
  return isLocalWindows(transport) || remoteWindows(transport) !== null;
}

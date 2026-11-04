import { checkIpcProof, ipcChallenge } from '@puddle/shared/node';
import { HostControlClient, type ServerProof } from '@puddle/shared/node/host-control';
import { clientHome } from '../paths.js';
import { isLocalWindows } from '../transport/local.js';
import type { Transport } from '../transport/transport.js';
import { CliError } from '../types.js';
import { openControlChannel } from './control-channel.js';
export type { AuthorityState, ConnectionAuthority } from '@puddle/shared/node/host-control';

/** The local/SSH shell is itself the participating client. */
export class HostConnection extends HostControlClient {
  constructor(transport: Transport) {
    super(
      () => openControlChannel(transport),
      true,
      (code, message) => new CliError(code, message),
      undefined,
      isLocalWindows(transport) ? homeDaemonProof(clientHome()) : undefined,
    );
  }
}

/** A Windows pipe's server must show that it can read the home before it is believed. */
export function homeDaemonProof(home: string): ServerProof {
  return {
    challenge: ipcChallenge,
    verify: (challenge, proof) => checkIpcProof(home, 'host', challenge, proof),
  };
}

export async function acquireAuthority(transport: Transport): Promise<HostConnection> {
  const authority = new HostConnection(transport);
  try {
    await authority.establish();
    return authority;
  } catch (err) {
    authority.close();
    throw err;
  }
}

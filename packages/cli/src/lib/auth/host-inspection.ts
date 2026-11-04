import { connect } from 'node:net';
import {
  checkIpcEndpoint,
  checkIpcProof,
  ipcChallenge,
  ipcPath,
  jsonLines,
} from '@puddle/shared/node';
import { readFile } from 'node:fs/promises';
import { CliError } from '../types.js';
import { join } from 'node:path';
import {
  controlResponseSchema,
  hostInspectionSchema,
  sessionSchema,
  versionResponseSchema,
  type HostInspection,
} from '@puddle/shared';

/** Runs on the host, including for old daemons. The credential never leaves this process. */
export async function inspectLegacyHost(home: string): Promise<HostInspection | null> {
  let token: string;
  try {
    token = (await readFile(join(home, 'token'), 'utf8')).trim();
  } catch {
    return null;
  }
  if (!/^[a-f0-9]{32,}$/.test(token)) return null;
  let port = 7434;
  for (const name of ['config.json', 'runtime.json']) {
    try {
      const data = JSON.parse(await readFile(join(home, name), 'utf8')) as { port?: unknown };
      if (
        typeof data.port === 'number' &&
        Number.isInteger(data.port) &&
        data.port > 0 &&
        data.port < 65536
      )
        port = data.port;
    } catch {
      /* Absent metadata: use the conventional port. */
    }
  }
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 401 || response.status === 403)
      throw new CliError('port_in_use', 'The host endpoint rejects its local credential');
    if (!response.ok) throw new Error('host inspection failed');
    return response.json() as Promise<unknown>;
  };
  try {
    const version = versionResponseSchema.parse(await get('/api/version'));
    const sessions = sessionSchema
      .pick({ status: true })
      .array()
      .parse(await get('/api/sessions'));
    return hostInspectionSchema.parse({
      t: 'inspection',
      port,
      version,
      liveSessions: sessions.filter((s) =>
        ['starting', 'running', 'waiting_input'].includes(s.status),
      ).length,
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    return null;
  }
}

/**
 * Modern inspection also stays on the host; only validated summary data leaves it.
 * A Windows home has no pipe to stat and no pre-pipe daemons, so a missing
 * pipe there simply means no daemon, and its server is believed only once it
 * proves that it can read the home.
 */
export async function inspectHostLocally(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Promise<HostInspection | null> {
  const path = ipcPath(home, 'host');
  const challenge = platform === 'win32' ? ipcChallenge() : undefined;
  try {
    checkIpcEndpoint(path, platform);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return inspectLegacyHost(home);
    throw err;
  }
  const socket = connect(path);
  try {
    const grant = await new Promise<
      Extract<ReturnType<typeof controlResponseSchema.parse>, { t: 'authority' }>
    >((resolve, reject) => {
      socket.setTimeout(5000, () => socket.destroy(new Error('Host inspection timed out')));
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('Host control closed')));
      jsonLines(
        socket,
        (value) => {
          const message = controlResponseSchema.parse(value);
          if (message.t !== 'authority' || !message.token)
            throw new Error('Host authority unavailable');
          if (challenge !== undefined && !checkIpcProof(home, 'host', challenge, message.proof))
            throw new Error('The host control pipe is not served by this home’s daemon');
          resolve(message);
        },
        () => socket.destroy(new Error('Invalid host control response')),
      );
      socket.write(JSON.stringify({ t: 'open', ...(challenge ? { challenge } : {}) }) + '\n');
    });
    const response = await fetch(`http://127.0.0.1:${grant.port}/api/sessions`, {
      headers: { authorization: `Bearer ${grant.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Host inspection rejected');
    const sessions = sessionSchema
      .pick({ status: true })
      .array()
      .parse(await response.json());
    return hostInspectionSchema.parse({
      t: 'inspection',
      port: grant.port,
      version: grant.version,
      liveSessions: sessions.filter((s) =>
        ['starting', 'running', 'waiting_input'].includes(s.status),
      ).length,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (platform === 'win32' && code === 'ENOENT') return null;
    if (code === 'ECONNREFUSED') return inspectLegacyHost(home);
    throw err;
  } finally {
    socket.destroy();
  }
}

import { CliError } from '../types.js';
import { shellQuote } from '../transport/ssh.js';
import { digest } from '@puddle/shared/node';
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkIpcEndpoint, ipcPath } from '@puddle/shared/node';
import { controlResponseSchema, type HostInspection } from '@puddle/shared';
import type { Duplex } from 'node:stream';
import { remoteWindowsHost } from '../host/windows-remote-host.js';
import { clientHome, hostPaths } from '../paths.js';
import { remoteWindows } from '../transport/host-platform.js';
import type { Transport } from '../transport/transport.js';
import { inspectHostLocally } from './host-inspection.js';

const staged = new WeakMap<Transport, Promise<string>>();
async function helper(transport: Transport): Promise<string> {
  let pending = staged.get(transport);
  if (!pending) {
    pending = (async () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const file = [
        join(here, 'host-control.mjs'),
        join(here, '../../../dist/host-control.mjs'),
      ].find(existsSync);
      if (!file)
        throw new Error('Puddle host control helper is missing; rebuild or reinstall the CLI');
      // Stage our helper for older installations, using their bundled Node runtime.
      const code = readFileSync(file, 'utf8');
      const name = `helper-${digest(code)}.mjs`;
      const stage = `const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = path.join(process.env.PUDDLE_HOME || path.join(os.homedir(), '.puddle'), 'control');
fs.mkdirSync(dir, {recursive:true, mode:0o700});
const st = fs.lstatSync(dir);
if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error('Private control directory required');
const dest = path.join(dir, '${name}');
const tmp = dest + '.' + require('node:crypto').randomBytes(16).toString('hex');
fs.writeFileSync(tmp, fs.readFileSync(0), {mode:0o600, flag:'wx'});
fs.renameSync(tmp, dest);`;
      const result = await transport.exec(`${hostPaths.current}/bin/node -e ${shellQuote(stage)}`, {
        stdin: code,
        timeoutMs: 15_000,
        revealsWindows: true,
      });
      // The first command a connection runs: a Git Bash default shell passes
      // `true`, so a Windows host may be recognised only here (callers then
      // take its own control path).
      if (result.code !== 0) throw new Error('Could not stage the host control helper');
      return `${hostPaths.current}/bin/node ${hostPaths.home}/control/${name}`;
    })();
    staged.set(transport, pending);
    void pending.catch(() => staged.delete(transport));
  }
  return pending;
}

/**
 * The POSIX helper's command, or null when staging it showed the host is
 * Windows (whose own helper then serves the request).
 */
async function posixHelper(transport: Transport): Promise<string | null> {
  try {
    return await helper(transport);
  } catch (err) {
    if (remoteWindows(transport)) return null;
    throw err;
  }
}

export async function openControlChannel(transport: Transport): Promise<Duplex> {
  if (transport.kind === 'local') {
    const path = ipcPath(clientHome(), 'host');
    checkIpcEndpoint(path);
    return connect(path);
  }
  const windows = remoteWindows(transport);
  if (windows) return remoteWindowsHost(windows).openChannel();
  if (!transport.openChannel) throw new Error('Transport has no bidirectional control channel');
  const command = await posixHelper(transport);
  if (command === null) return remoteWindowsHost(remoteWindows(transport)!).openChannel();
  return transport.openChannel(command);
}

export async function inspectHost(transport: Transport): Promise<HostInspection | null> {
  if (transport.kind === 'local') return inspectHostLocally(clientHome());
  const windows = remoteWindows(transport);
  let stdout: string;
  if (windows) stdout = await remoteWindowsHost(windows).inspect();
  else {
    const command = await posixHelper(transport);
    stdout =
      command === null
        ? await remoteWindowsHost(remoteWindows(transport)!).inspect()
        : (await transport.exec(`${command} --inspect`, { timeoutMs: 10_000 })).stdout;
  }
  return parseInspection(stdout);
}

/** The helper's one-line answer (host-control.ts, or the Windows host helper's `inspect`). */
function parseInspection(stdout: string): HostInspection | null {
  if (Buffer.byteLength(stdout) > 256 * 1024) return null;
  try {
    const message = controlResponseSchema.parse(JSON.parse(stdout));
    if (message.t === 'error' && message.code === 'rejected')
      throw new CliError('port_in_use', 'The host endpoint rejects its local credential');
    return message.t === 'inspection' ? message : null;
  } catch (err) {
    if (err instanceof CliError) throw err;
    return null;
  }
}

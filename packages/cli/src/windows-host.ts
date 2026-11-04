import { disableCurrentDirectorySearch } from '@puddle/shared/node/platform';
import { runWindowsHostOp } from './lib/host/windows-host-ops.js';
import { clientHome } from './lib/paths.js';
import { fromB64json } from './lib/transport/windows-remote.js';

/**
 * dist/windows-host.mjs: the host helper an SSH client stages on a Windows
 * host and runs with that host's own node.exe (docs/windows.md), as
 * `node windows-host.mjs <op> <base64 JSON request> [archive]`. Standard
 * output carries only the operation's protocol (JSON lines, or the control
 * channel); the client always passes the release and repository, since this
 * bundle runs beside whichever release the host has installed.
 */

disableCurrentDirectorySearch();
const [op = '', request, archive] = process.argv.slice(2);
const supervision = process.env.PUDDLE_TEST_WINDOWS_SUPERVISION;
const code = await runWindowsHostOp(op, fromB64json(request), {
  home: clientHome(),
  stdin: process.stdin,
  stdout: process.stdout,
  ...(archive !== undefined ? { archive } : {}),
  ...(supervision === 'wmi' || supervision === 'session' ? { supervision } : {}),
});
// A channel's standard input may still be open: leave once the output is written.
process.stdout.write('', () => process.exit(code));

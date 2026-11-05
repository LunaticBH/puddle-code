import { disableCurrentDirectorySearch } from '@puddle/shared/node/platform';
import { runWindowsHostOp, testSupervision } from './lib/host/windows-host-ops.js';
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
const home = clientHome();
// Tests only: a home in the temporary directory, never a real one.
const supervision = testSupervision(process.env, home);
const code = await runWindowsHostOp(op, fromB64json(request), {
  home,
  stdin: process.stdin,
  stdout: process.stdout,
  ...(archive !== undefined ? { archive } : {}),
  ...(supervision !== undefined ? { supervision } : {}),
});
// A channel's standard input may still be open: leave once the output is written.
process.stdout.write('', () => process.exit(code));

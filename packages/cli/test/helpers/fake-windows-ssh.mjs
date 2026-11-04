#!/usr/bin/env node
/**
 * A stand-in for the ssh client talking to a Windows OpenSSH server, so the
 * whole `puddle launch user@winhost` flow runs on a Windows test machine
 * with no sshd (docs/windows.md). It interprets the argv shapes SshTransport
 * and the tunnel produce, as Windows OpenSSH would:
 *
 *   ssh <opts…> host <command…>        → run the command line as the
 *                                         server's default shell runs it:
 *                                         `cmd.exe /c` (FAKE_WINDOWS_SSH_SHELL
 *                                         unset or `cmd`) or `powershell.exe
 *                                         -c` (`powershell`), standard
 *                                         streams passed through, status
 *                                         returned (POSIX `true` fails there)
 *   ssh <opts…> -N -L lp:127.0.0.1:rp h → a TCP forwarder lp → rp, alive
 *                                         until killed
 *   ssh <opts…> -O <ctl> host          → exit 0 (a Windows client has no master)
 *
 * The remote account's profile is FAKE_WINDOWS_SSH_HOME: it becomes
 * USERPROFILE (and HOME), its AppData\Local\Temp TEMP and TMP, and the
 * session starts in it, as an OpenSSH session starts in the profile.
 * PUDDLE_HOME is the client's, so it never reaches the "host" unless
 * FAKE_WINDOWS_SSH_PUDDLE_HOME names one. FAKE_WINDOWS_SSH_UNREACHABLE makes
 * every connection fail with ssh's own status 255. Each invocation is
 * appended to FAKE_WINDOWS_SSH_LOG as a JSON line (argv, options, command).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const options = [];
let control;
let forward;
let noCommand = false;
let i = 0;
for (; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '-o') options.push(argv[++i]);
  else if (['-i', '-p', '-F', '-l', '-J'].includes(arg)) options.push(`${arg} ${argv[++i]}`);
  else if (arg === '-O') control = argv[++i];
  else if (arg === '-L') forward = argv[++i];
  else if (arg === '-N') noCommand = true;
  else if (arg === '-T' || arg === '-q') continue;
  else break;
}
const host = argv[i];
let rest = argv.slice(i + 1);
if (rest[0] === '--') rest = rest.slice(1);
// ssh hands the server one command line: its words joined by spaces.
const command = rest.join(' ');

if (process.env.FAKE_WINDOWS_SSH_LOG) {
  appendFileSync(
    process.env.FAKE_WINDOWS_SSH_LOG,
    JSON.stringify({ argv, options, host, control, forward, noCommand, command }) + '\n',
  );
}
if (process.env.FAKE_WINDOWS_SSH_UNREACHABLE) {
  process.stderr.write(`ssh: connect to host ${host}: Connection refused\r\n`);
  process.exit(255);
}
if (control !== undefined) process.exit(0);

if (noCommand && forward !== undefined) {
  const [lp, , rp] = forward.split(':');
  const server = createServer((client) => {
    const upstream = connect({ host: '127.0.0.1', port: Number(rp) });
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on('error', () => process.exit(255));
  server.listen(Number(lp), '127.0.0.1');
  setInterval(() => {}, 1000);
} else {
  const profile = process.env.FAKE_WINDOWS_SSH_HOME;
  if (!profile) {
    process.stderr.write('fake-windows-ssh: FAKE_WINDOWS_SSH_HOME is not set\n');
    process.exit(255);
  }
  const temp = join(profile, 'AppData', 'Local', 'Temp');
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PUDDLE_HOME|USERPROFILE|HOME|TEMP|TMP|FAKE_WINDOWS_SSH_.*)$/i.test(key)) delete env[key];
  }
  Object.assign(env, { USERPROFILE: profile, HOME: profile, TEMP: temp, TMP: temp });
  if (process.env.FAKE_WINDOWS_SSH_PUDDLE_HOME) {
    env.PUDDLE_HOME = process.env.FAKE_WINDOWS_SSH_PUDDLE_HOME;
  }
  const shell = process.env.FAKE_WINDOWS_SSH_SHELL ?? 'cmd';
  const started = Date.now();
  const [file, args, verbatim] =
    shell === 'powershell'
      ? [
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          ['-NoProfile', '-c', command],
          false,
        ]
      : [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], true];
  const child = spawn(file, args, {
    stdio: 'inherit',
    cwd: profile,
    env,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
  });
  child.on('error', (err) => {
    process.stderr.write(`fake-windows-ssh: ${err.message}\n`);
    process.exit(255);
  });
  const watchdog = child.pid === undefined ? undefined : watchSession(child.pid, started);
  // The session ended by itself: the operation and everything it waited for are done.
  child.on('close', (code) => {
    watchdog?.kill();
    process.exit(code ?? 255);
  });
}

/**
 * Windows OpenSSH runs a session in a kill-on-close job: when the client
 * goes, so does everything the session started (only what WMI or Task
 * Scheduler created survives, being no descendant of the session). A client
 * that is killed runs no code of its own, and Node's own job takes only its
 * direct children with it, so a detached watchdog ends the rest of the
 * session's process tree: every process descended from the shell since the
 * session began, found by its (possibly dead) parent's pid.
 */
function watchSession(shell, started) {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const watchdog = `
const { execFileSync, spawnSync } = require('node:child_process');
const [client, shell, since] = process.argv.slice(1).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const timer = setInterval(() => {
  if (alive(client)) return;
  clearInterval(timer);
  const ps = ${JSON.stringify(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'))};
  const list = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    '@(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; ' +
    'created = [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }) | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true }) || '[]');
  const doomed = new Set([shell]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of list) {
      if (!doomed.has(p.pid) && doomed.has(p.parent) && p.created >= since - 1000) { doomed.add(p.pid); grew = true; }
    }
  }
  for (const pid of doomed) {
    if (alive(pid)) spawnSync(${JSON.stringify(join(system, 'taskkill.exe'))}, ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  }
  process.exit(0);
}, 250);`;
  const child = spawn(
    process.execPath,
    ['-e', watchdog, String(process.pid), String(shell), String(started)],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  return child;
}

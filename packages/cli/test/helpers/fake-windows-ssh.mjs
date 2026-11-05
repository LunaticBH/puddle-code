#!/usr/bin/env node
/**
 * A stand-in for the ssh client talking to a Windows OpenSSH server, so the
 * whole `puddle launch user@winhost` flow runs on a Windows test machine
 * with no sshd (docs/windows.md). It interprets the argv shapes SshTransport
 * and the tunnel produce, as Windows OpenSSH would:
 *
 *   ssh <opts…> host <command…>        → run the command line as the
 *                                         server's default shell runs it,
 *                                         by FAKE_WINDOWS_SSH_SHELL:
 *                                         `cmd.exe /c` (unset or `cmd`),
 *                                         `powershell.exe -c` (`powershell`)
 *                                         or Git Bash's `bash.exe -c`
 *                                         (`bash`, FAKE_WINDOWS_SSH_BASH),
 *                                         standard streams passed through,
 *                                         status returned (POSIX `true`
 *                                         fails under the first two)
 *   ssh <opts…> -N -L lp:127.0.0.1:rp h → a TCP forwarder lp → rp, alive
 *                                         until killed (lp = rp drops every
 *                                         connection: nothing listens there
 *                                         on the host)
 *   ssh <opts…> -O <ctl> host          → exit 0 (a Windows client has no master)
 *   scp <opts…> <file> host:<path>     → a copy into the profile (run as
 *                                         scp: its launcher is named scp)
 *
 * The remote account's profile is FAKE_WINDOWS_SSH_HOME: it becomes
 * USERPROFILE (and HOME), its AppData\Local\Temp TEMP and TMP, its AppData
 * folders LOCALAPPDATA and APPDATA, and the session starts in it, as an
 * OpenSSH session starts in the profile. The session's PATH is Windows' own
 * default, never the client's, which may hold Git's Unix tools: only the
 * `bash` shell brings those, as Git Bash does. PUDDLE_HOME is the client's,
 * so it never reaches the "host" unless FAKE_WINDOWS_SSH_PUDDLE_HOME names
 * one. FAKE_WINDOWS_SSH_UNREACHABLE makes every connection fail with ssh's
 * own status 255. Each invocation is appended to FAKE_WINDOWS_SSH_LOG as a
 * JSON line (argv, options, command).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { basename, dirname, join, win32 } from 'node:path';

const argv = process.argv.slice(2);
const asScp = basename(process.argv[1] ?? '')
  .toLowerCase()
  .startsWith('scp');

function log(entry) {
  if (process.env.FAKE_WINDOWS_SSH_LOG) {
    appendFileSync(process.env.FAKE_WINDOWS_SSH_LOG, JSON.stringify(entry) + '\n');
  }
}

function unreachable(host) {
  process.stderr.write(`ssh: connect to host ${host}: Connection refused\r\n`);
  process.exit(255);
}

function profile() {
  const home = process.env.FAKE_WINDOWS_SSH_HOME;
  if (home) return home;
  process.stderr.write('fake-windows-ssh: FAKE_WINDOWS_SSH_HOME is not set\n');
  process.exit(255);
}

if (asScp) copy();
else session();

/** scp: options take their value as the next word; the copy's two ends come last. */
function copy() {
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (['-o', '-P', '-i', '-F', '-J', '-l', '-c', '-S'].includes(argv[i])) i += 1;
    else if (!argv[i].startsWith('-')) words.push(argv[i]);
  }
  const [source, target = ''] = words.slice(-2);
  const colon = target.indexOf(':');
  log({ scp: true, argv, source, target });
  if (process.env.FAKE_WINDOWS_SSH_UNREACHABLE) unreachable(target.slice(0, colon));
  if (source === undefined || colon <= 0) {
    process.stderr.write('fake-windows-ssh: scp needs <file> host:<path>\n');
    process.exit(1);
  }
  // sftp resolves a relative path against the profile, the session's start.
  const path = target.slice(colon + 1);
  const dest = win32.isAbsolute(path) ? path : join(profile(), path);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  process.exit(0);
}

function session() {
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

  log({ argv, options, host, control, forward, noCommand, command });
  if (process.env.FAKE_WINDOWS_SSH_UNREACHABLE) unreachable(host);
  if (control !== undefined) process.exit(0);

  if (noCommand && forward !== undefined) {
    const [lp, , rp] = forward.split(':');
    const server = createServer((client) => {
      // The "host" shares this machine's loopback: a port forwarded to itself
      // (the agent OAuth callback's 1455) would reach this listener again, in
      // an endless loop that exhausts the ephemeral ports. The host has no
      // listener there, so the channel fails, as sshd's would.
      if (lp === rp) {
        client.destroy();
        return;
      }
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
    return;
  }

  const home = profile();
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const system = join(root, 'System32');
  const local = join(home, 'AppData', 'Local');
  const temp = join(local, 'Temp');
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env };
  const replaced =
    /^(PATH|PUDDLE_HOME|USERPROFILE|HOME|TEMP|TMP|LOCALAPPDATA|APPDATA|FAKE_WINDOWS_SSH_.*)$/i;
  for (const key of Object.keys(env)) if (replaced.test(key)) delete env[key];
  Object.assign(env, {
    // Windows' default system PATH: no Unix tools, whatever the client's holds.
    Path: [
      system,
      root,
      join(system, 'Wbem'),
      join(system, 'WindowsPowerShell', 'v1.0'),
      join(system, 'OpenSSH'),
    ].join(';'),
    USERPROFILE: home,
    HOME: home,
    TEMP: temp,
    TMP: temp,
    LOCALAPPDATA: local,
    APPDATA: join(home, 'AppData', 'Roaming'),
  });
  if (process.env.FAKE_WINDOWS_SSH_PUDDLE_HOME) {
    env.PUDDLE_HOME = process.env.FAKE_WINDOWS_SSH_PUDDLE_HOME;
  }
  const shell = process.env.FAKE_WINDOWS_SSH_SHELL ?? 'cmd';
  const started = Date.now();
  const [file, args, verbatim] =
    shell === 'powershell'
      ? [
          join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-c', command],
          false,
        ]
      : shell === 'bash'
        ? // OpenSSH runs a DefaultShell other than cmd and PowerShell as `<shell> -c <command>`.
          [
            process.env.FAKE_WINDOWS_SSH_BASH ??
              join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
            ['-c', command],
            false,
          ]
        : [
            process.env.ComSpec ?? join(system, 'cmd.exe'),
            ['/d', '/s', '/c', `"${command}"`],
            true,
          ];
  const child = spawn(file, args, {
    stdio: 'inherit',
    cwd: home,
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
 *
 * Windows reuses a pid as soon as its process is gone, and that job has
 * ended the shell itself before the watchdog looks: a pid counts as the
 * session's only while no younger process holds it (the shell's own was
 * created as it spawned; a child is never older than its parent), and only
 * a process whose command line names the profile (a helper, a runtime or
 * a daemon of its home) is ever terminated. Anything else, a supervisor WMI
 * started, another session or an unrelated program, is never touched.
 */
function watchSession(shell, started) {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const watchdog = `
const { execFileSync, spawnSync } = require('node:child_process');
const [client, shell, since, spawned] = process.argv.slice(1, 5).map(Number);
const profile = process.argv[5].toLowerCase();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const timer = setInterval(() => {
  if (alive(client)) return;
  clearInterval(timer);
  const ps = ${JSON.stringify(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'))};
  const list = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    '@(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; ' +
    'created = [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(); line = [string]$_.CommandLine } }) | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true }) || '[]');
  const live = new Map(list.map((p) => [p.pid, p]));
  // Whether pid, if anything holds it now, still names a process born by then.
  const holds = (pid, by) => { const now = live.get(pid); return now === undefined || now.created <= by; };
  const doomed = new Set();
  if (holds(shell, spawned + 2000)) doomed.add(shell);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of list) {
      if (doomed.has(p.pid) || !doomed.has(p.parent) || p.created < since - 1000) continue;
      if (!holds(p.parent, p.created + 1)) continue;
      doomed.add(p.pid);
      grew = true;
    }
  }
  for (const pid of doomed) {
    const p = live.get(pid);
    if (!p || !String(p.line || '').toLowerCase().includes(profile) || !alive(pid)) continue;
    spawnSync(${JSON.stringify(join(system, 'taskkill.exe'))}, ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  }
  process.exit(0);
}, 250);`;
  const child = spawn(
    process.execPath,
    [
      '-e',
      watchdog,
      String(process.pid),
      String(shell),
      String(started),
      String(Date.now()),
      profile(),
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  return child;
}

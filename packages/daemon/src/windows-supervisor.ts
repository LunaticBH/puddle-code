#!/usr/bin/env node
import { spawn, type StdioOptions } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcPath, ipcProof, listenPrivate } from '@puddle/shared/node';
import {
  childProcessTree,
  connectorPipeState,
  connectorSupervisedMarker,
  controlPipeState,
  daemonEnvironment,
  disableCurrentDirectorySearch,
  listWindowsProcesses,
  LOG_ROTATE_BYTES,
  openRotated,
  requestDaemonShutdown,
  setEnv,
  supervisorRequest,
} from '@puddle/shared/node/platform';
import { ptyRootsFile } from './pty/pty-roots.js';
import { reapWindowsDaemon } from './supervision/reap-daemon.js';
import { WindowsSupervisor, type SupervisedChild } from './supervision/windows-supervisor.js';

/**
 * `daemon\supervisor.mjs` (Windows release archives only): started at logon
 * by the home's scheduled task, or by a launcher, as
 * `node.exe supervisor.mjs --home <home>` (the task and WMI start it through
 * the windowless bin\puddle-hidden.exe, supervision/puddle-hidden.cs). See
 * supervision/windows-supervisor.ts.
 */

declare const __PUDDLED_VERSION__: string | undefined;

function appVersion(): string {
  if (typeof __PUDDLED_VERSION__ !== 'undefined') return __PUDDLED_VERSION__;
  const here = dirname(fileURLToPath(import.meta.url));
  return (JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string })
    .version;
}

if (process.argv.includes('--version')) {
  console.log(`puddle-supervisor ${appVersion()}`);
  process.exit(0);
}
if (process.platform !== 'win32') {
  console.error('puddle-supervisor runs on Windows hosts only');
  process.exit(1);
}

disableCurrentDirectorySearch();

const flag = process.argv.indexOf('--home');
// Task Scheduler gives its processes the user's own environment, not a
// launcher's: the home travels on the command line.
const home = win32.resolve(
  flag !== -1 && process.argv[flag + 1]
    ? process.argv[flag + 1]!
    : (process.env.PUDDLE_HOME ?? join(homedir(), '.puddle')),
);
const defaultHome = win32.resolve(join(homedir(), '.puddle')).toLowerCase() === home.toLowerCase();

const logs = join(home, 'logs');
mkdirSync(logs, { recursive: true });
const logFile = join(logs, 'supervisor.log');
closeSync(openRotated(logFile, LOG_ROTATE_BYTES));
const log = (line: string) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A full disk must not stop supervision.
  }
};

/** The release `bin\current` names now: a restart after an upgrade runs the new one. */
function spawnChild(kind: 'puddled' | 'connector'): SupervisedChild {
  const runtime = realpathSync.native(join(home, 'bin', 'current'));
  const node = join(runtime, 'bin', 'node.exe');
  const script = join(runtime, 'daemon', `${kind}.mjs`);
  for (const file of [node, script]) {
    if (!existsSync(file)) throw new Error(`${file} is missing`);
  }
  const out = openRotated(join(logs, `${kind}.out.log`));
  const err = openRotated(join(logs, `${kind}.err.log`));
  try {
    const env = daemonEnvironment(process.env, home);
    // The connector is always told its home, as the POSIX units tell it.
    if (kind === 'connector' || !defaultHome) setEnv(env, 'PUDDLE_HOME', home, 'win32');
    const stdio: StdioOptions =
      kind === 'connector' ? ['ignore', out, err, 'ipc'] : ['ignore', out, err];
    // Not detached: the versioned node.exe (whose command line names
    // bin\versions, as launchers identify a daemon) is this process's child.
    const startedAtMs = Date.now();
    const child = spawn(node, [script], { cwd: homedir(), windowsHide: true, stdio, env });
    const tree = childProcessTree(child, startedAtMs);
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${kind} could not be started`);
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null));
      child.once('exit', (code) => resolve(code));
    });
    return {
      pid,
      startedAtMs,
      exited,
      // The connector stops cleanly when its IPC channel closes; the daemon is asked over its pipe.
      stop: () => {
        if (child.connected) child.disconnect();
      },
      // The daemon alone: its consoles close with it, and the reap that
      // follows its exit ends what they left by the PTY rule (never a GUI
      // programme or what left a console), which a tree kill would not.
      // The connector with what it started, as stopping its POSIX unit ends
      // the unit's control group: its own helpers, never a session's. By
      // the process table's creation-time-consistent tree, the connector
      // by its own handle, never a GUI programme or what one started.
      kill:
        kind === 'puddled'
          ? async () => {
              child.kill();
            }
          : () => tree.kill({ platform: 'win32' }),
    };
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

const pidFile = join(home, 'puddled.pid');
const supervisor = new WindowsSupervisor({
  pid: process.pid,
  log,
  listen: (onConnection) => listenPrivate(ipcPath(home, 'supervisor'), onConnection),
  holder: async () => (await supervisorRequest(home, 'status')).kind,
  spawnDaemon: () => spawnChild('puddled'),
  spawnConnector: () => spawnChild('connector'),
  connectorWanted: () =>
    existsSync(connectorSupervisedMarker(home)) &&
    existsSync(join(home, 'bin', 'current', 'daemon', 'connector.mjs')),
  hostPipe: () => controlPipeState(home),
  requestDaemonShutdown: () => requestDaemonShutdown(home),
  reapDaemon: (daemon, exitedAtMs) =>
    reapWindowsDaemon(daemon, exitedAtMs, {
      processes: listWindowsProcesses,
      rootsFile: ptyRootsFile(home),
    }),
  connectorManager: () => connectorPipeState(home, 'remote'),
  writePid: (pid) => {
    try {
      if (pid === null) rmSync(pidFile, { force: true });
      else writeFileSync(pidFile, `${pid}\n`);
    } catch {
      // Launchers identify the daemon by its command line as well.
    }
  },
  proof: (challenge) => ipcProof(home, 'supervisor', challenge),
  now: () => Date.now(),
});

process.on('uncaughtException', (err) => {
  log(`supervisor failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
// Closing the console sends SIGHUP and Ctrl-Break SIGBREAK, each with a few seconds' grace.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
  process.on(signal, () => void supervisor.shutdown(`${signal} received`));
}
process.exit(await supervisor.run());

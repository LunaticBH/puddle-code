import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { controlRequestSchema, controlResponseSchema } from '@puddle/shared';
import {
  checkIpcEndpoint,
  checkIpcProof,
  ipcChallenge,
  ipcPath,
  jsonLines,
} from '@puddle/shared/node';
import {
  canonicalWindowsHome,
  controlPipeState,
  daemonEnvironment,
  openRotated,
  runWindowsPowerShell,
  type PowerShellRunner,
} from '@puddle/shared/node/platform';
import { inspectHostLocally } from '../auth/host-inspection.js';
import {
  connectorEnvironment,
  runWindowsConnector,
  windowsConnectorInstalled,
  windowsConnectorPaths,
} from '../installation/windows-connector.js';
import { stopWindowsDaemonPid, windowsRuntime } from '../installation/windows-daemon.js';
import { installWindowsDaemon, windowsInstalledVersion } from '../installation/windows-install.js';
import { removeWindowsDaemon, sweepWindowsWorktrees } from '../installation/windows-remove.js';
import { CliError, type Logger } from '../types.js';
import { showWindowsLogs } from '../windows-logs.js';
import { errorMessage, type HelperMessage } from './windows-host-protocol.js';

/**
 * The host side of SSH to a Windows host (docs/windows.md): what the host
 * helper (src/windows-host.ts, run by the host's own node.exe) does for each
 * operation, using the same implementations as a local Windows host. It
 * runs inside the SSH session's kill-on-close job, so it never leaves a
 * daemon as its detached child: starts go through Task Scheduler or WMI,
 * or are refused with `session_bound`.
 */

export interface HostOpContext {
  home: string;
  stdin: NodeJS.ReadableStream;
  /** Standard output: JSON lines, or the control protocol for `channel`. */
  stdout: NodeJS.WritableStream;
  /** The archive a bootstrap unpacked, after the request on the command line. */
  archive?: string;
  /**
   * Test seam (PUDDLE_TEST_WINDOWS_SUPERVISION, for test homes only): Task
   * Scheduler is refused without being asked, so no test registers a task;
   * `wmi` still creates the supervisor through WMI, as on a host without an
   * interactive logon, and `session` refuses WMI too, as on a host that
   * blocks it.
   */
  supervision?: 'wmi' | 'session';
}

/** Connector modes a client may ask for; anything else is refused. */
const CONNECTOR_FLAGS = new Set([
  '--version',
  '--inspect',
  '--configure',
  '--reset',
  '--admin',
  '--disable-all',
]);

/** Task Scheduler refused (and WMI unless `wmi`), as on a test machine without them. */
function testPowerShell(mode: 'wmi' | 'session'): PowerShellRunner {
  return async (script, env, timeoutMs) => {
    if ('PUDDLE_PROCESS_COMMAND' in env && mode === 'wmi') {
      return runWindowsPowerShell(script, env, timeoutMs);
    }
    const reply =
      'PUDDLE_PROCESS_COMMAND' in env
        ? { code: 2, pid: 0, error: 'WMI is refused in tests' }
        : 'PUDDLE_TASK_XML' in env
          ? { registered: false, disabled: false, error: 'Task Scheduler is refused in tests' }
          : { ran: false, removed: false, state: 'absent', error: '' };
    return { code: 0, stdout: JSON.stringify(reply), stderr: '' };
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function optionalString(request: Record<string, unknown>, key: string): string | undefined {
  const value = request[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new CliError('bad_arguments', `${key} must be a string`);
  return value;
}

function readAll(stream: NodeJS.ReadableStream, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > limit) reject(new CliError('bad_arguments', 'the request is too large'));
    });
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

/** Run one helper operation; resolves with the process's exit status. */
export async function runWindowsHostOp(
  op: string,
  request: unknown,
  context: HostOpContext,
): Promise<number> {
  const { home } = context;
  const emit = (message: HelperMessage) => context.stdout.write(JSON.stringify(message) + '\n');
  const logger: Logger = {
    info: (message) => emit({ t: 'log', level: 'info', message }),
    warn: (message) => emit({ t: 'log', level: 'warn', message }),
  };
  const seams = context.supervision ? { powershell: testPowerShell(context.supervision) } : {};
  const body = record(request);
  try {
    switch (op) {
      case 'channel':
        return await bridgeControl(home, context.stdin, context.stdout);
      case 'inspect': {
        // The same single line as host-control.ts --inspect. A pipe that
        // cannot prove it reads the home is no daemon here, as on a local
        // Windows host; only a refused credential is reported as such.
        const inspection = await inspectHostLocally(home).catch((err: unknown) =>
          err instanceof CliError ? { t: 'error', code: 'rejected' } : null,
        );
        context.stdout.write(
          JSON.stringify(inspection ?? { t: 'error', code: 'unavailable' }) + '\n',
        );
        return 0;
      }
      case 'installed':
        emit({ t: 'result', value: await windowsInstalledVersion(home) });
        return 0;
      case 'pipe':
        emit({ t: 'result', value: await controlPipeState(home) });
        return 0;
      case 'install': {
        const version = optionalString(body, 'version');
        if (version === undefined) throw new CliError('bad_arguments', 'install needs a version');
        const slug = optionalString(body, 'slug');
        await installWindowsDaemon({
          home,
          version,
          ...(context.archive !== undefined ? { tarball: context.archive } : {}),
          ...(body.replaceRunning === false ? { replaceRunning: false } : {}),
          ...(slug !== undefined ? { slug } : {}),
          logger,
          supervision: seams,
          // A detached child would end with this SSH session (its job), and
          // until then hold the session's pipes open.
          detachedStart: false,
        });
        emit({ t: 'result' });
        return 0;
      }
      case 'stop-daemon': {
        // The attached lease's own daemon: never the home's supervisor, nor another daemon.
        const pid = body.pid;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
          throw new CliError('bad_arguments', 'stop-daemon needs a pid');
        }
        emit({ t: 'result', value: await stopWindowsDaemonPid(home, pid, { logger }) });
        return 0;
      }
      case 'sweep':
        emit({ t: 'result', value: await sweepWindowsWorktrees(home) });
        return 0;
      case 'remove':
        await removeWindowsDaemon(home, { purge: body.purge === true, logger, ...seams });
        emit({ t: 'result' });
        return 0;
      case 'logs': {
        const session = optionalString(body, 'session');
        const term = optionalString(body, 'term');
        await showWindowsLogs(home, {
          ...(session !== undefined ? { session } : {}),
          ...(term !== undefined ? { term } : {}),
          follow: body.follow === true,
          write: (text) => emit({ t: 'out', text }),
        });
        emit({ t: 'result' });
        return 0;
      }
      case 'connector-installed':
        emit({
          t: 'result',
          value: {
            installed: windowsConnectorInstalled(home),
            version: await windowsInstalledVersion(home),
          },
        });
        return 0;
      case 'connector': {
        const args = Array.isArray(body.args) ? body.args : [];
        if (!args.every((arg) => typeof arg === 'string' && CONNECTOR_FLAGS.has(arg))) {
          throw new CliError('bad_arguments', 'not a connector mode');
        }
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 30_000;
        // Registration values travel on standard input only, never the command line.
        const stdin = await readAll(context.stdin);
        const run = await runWindowsConnector(home, args as string[], { stdin, timeoutMs });
        emit({ t: 'result', value: run });
        return 0;
      }
      case 'connector-run':
        return await runConnectorForeground(home);
      case 'attached':
        return await runAttachedDaemon(home, body, emit);
      default:
        throw new CliError('bad_arguments', `unknown host operation ${op}`);
    }
  } catch (err) {
    emit(errorMessage(err));
    return 1;
  }
}

/**
 * The control channel: host-control.ts's bridge, plus the proof a Windows
 * client checks itself on a local host. The client cannot read this host's
 * ipc-key, so the first `open` is given a challenge here and the first
 * answer is believed only with a valid proof; anything else ends the
 * channel before a word of it reaches the client.
 */
function bridgeControl(
  home: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<number> {
  return new Promise((resolve) => {
    const path = ipcPath(home, 'host');
    checkIpcEndpoint(path);
    const socket = connect(path);
    let challenge: string | undefined;
    let proven = false;
    let done = false;
    const stop = (code = 0) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(code);
    };
    jsonLines(
      input,
      (value) => {
        let message = controlRequestSchema.parse(value);
        if (message.t === 'open' && challenge === undefined) {
          challenge = message.challenge ?? ipcChallenge();
          message = { ...message, challenge };
        }
        if (!socket.write(JSON.stringify(message) + '\n')) input.pause();
      },
      () => stop(1),
    );
    jsonLines(
      socket,
      (value) => {
        const message = controlResponseSchema.parse(value);
        if (!proven) {
          const proof = 'proof' in message ? message.proof : undefined;
          if (challenge === undefined || !checkIpcProof(home, 'host', challenge, proof)) {
            output.write(JSON.stringify({ t: 'error', code: 'rejected' }) + '\n');
            return stop(1);
          }
          proven = true;
        }
        if (!output.write(JSON.stringify(message) + '\n')) socket.pause();
      },
      () => stop(1),
    );
    socket.on('drain', () => input.resume());
    output.on('drain', () => socket.resume());
    input.on('end', () => stop());
    input.on('error', () => stop());
    output.on('error', () => stop());
    socket.on('error', () => stop(1));
    socket.on('close', () => stop());
  });
}

/**
 * The daemon attached to this SSH session (the cockpit's last resort when
 * neither Task Scheduler nor WMI can start one that outlives it): the
 * installed runtime as this process's child, inside the session's job, so
 * it ends with the cockpit's connection.
 */
async function runAttachedDaemon(
  home: string,
  request: Record<string, unknown>,
  emit: (message: HelperMessage) => void,
): Promise<number> {
  const version = await windowsInstalledVersion(home);
  if (version === null) throw new CliError('not_installed', 'puddled is not installed here');
  const runtime = windowsRuntime(canonicalWindowsHome(home), version);
  const port = typeof request.port === 'number' ? request.port : undefined;
  const logs = join(home, 'logs');
  mkdirSync(logs, { recursive: true });
  const out = openRotated(join(logs, 'puddled.out.log'));
  const err = openRotated(join(logs, 'puddled.err.log'));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(runtime.node, [runtime.entry, ...(port ? ['--port', String(port)] : [])], {
      cwd: homedir(),
      windowsHide: true,
      stdio: ['ignore', out, err],
      env: daemonEnvironment(process.env, home),
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => resolve(child.pid!));
  });
  const pidFile = join(home, 'puddled.pid');
  writeFileSync(pidFile, `${pid}\n`);
  emit({ t: 'started', pid });
  const code = await new Promise<number>((resolve) => child.once('exit', (c) => resolve(c ?? 1)));
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(pid)) rmSync(pidFile, { force: true });
  } catch {
    // Removed by a stop meanwhile.
  }
  emit({ t: 'result', value: { code } });
  return 0;
}

/** `puddle remote run`: the connector's manager in this session's foreground. */
function runConnectorForeground(home: string): Promise<number> {
  const { node, script } = windowsConnectorPaths(home);
  return new Promise((resolve, reject) => {
    const child = spawn(node, [script], {
      cwd: homedir(),
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: connectorEnvironment(home),
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

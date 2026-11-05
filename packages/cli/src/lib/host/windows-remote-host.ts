import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { parseSums } from '../installation/desktop-update.js';
import { versionFromLinkTarget } from '../installation/current-link.js';
import type { ConnectorRun } from '../installation/windows-connector.js';
import { versionFromArchiveName } from '../installation/windows-install.js';
import type { LogsOptions } from '../logs.js';
import type { RunningSshCommand, SshTransport } from '../transport/ssh.js';
import {
  bootstrapScript,
  HELPER_MISSING_EXIT,
  NO_RUNTIME_EXIT,
  runHelperScript,
  stageScript,
  type HelperRuntime,
  type WindowsProbe,
} from '../transport/windows-remote.js';
import { CliError, type Logger, silentLogger } from '../types.js';
import { pinnedDaemonVersion, repoSlug } from '../version.js';
import { helperError, parseHelperMessage, type HelperMessage } from './windows-host-protocol.js';
import type { WindowsHostOps, WindowsInstallRequest } from './windows-ops.js';

/**
 * An SSH host recognised as Windows (docs/windows.md): every operation is
 * one PowerShell script over the transport (windows-remote.ts), most of them
 * running this CLI's own host helper (dist/windows-host.mjs) with the host's
 * node.exe, which does on the host what a local Windows launcher does in
 * process. The helper is staged once per process in the user's %TEMP%.
 */

const INSTALL_TIMEOUT_MS = 10 * 60_000;

function helperFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = [join(here, 'windows-host.mjs'), join(here, '../../../dist/windows-host.mjs')].find(
    existsSync,
  );
  if (!file) {
    throw new CliError(
      'not_installed',
      'the Windows host helper is missing from this build',
      'rebuild or reinstall the CLI',
    );
  }
  return file;
}

/** Splits streamed standard output into the helper's JSON lines. */
function lineReader(receive: (message: HelperMessage) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const message = parseHelperMessage(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
      if (message) receive(message);
    }
  };
}

function lastLines(text: string, count = 3): string {
  return text.trim().split('\n').slice(-count).join('\n');
}

export interface HelperRun {
  runtime?: HelperRuntime;
  logger?: Logger;
  /** `out` messages (log text) as they arrive. */
  onOut?: (text: string) => void;
  payload?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The home has no runtime, so no node.exe could run the helper. */
class NoRuntimeError extends CliError {
  constructor(label: string) {
    super('not_installed', `no Puddle runtime is installed on ${label}`);
  }
}

/**
 * The daemon carries an administrator's elevated SSH token: WMI created its
 * supervisor from the session, or it runs attached to the session itself.
 * The logon task runs it without elevation.
 */
export function elevatedWarning(label: string, via: 'wmi' | 'session'): string {
  return (
    `puddled on ${label} runs elevated: an administrator's SSH session started it ` +
    `${via === 'wmi' ? 'through WMI' : 'as its own child'}, outside Task Scheduler; ` +
    'log on to the machine once so its logon task, which runs without elevation, starts it instead'
  );
}

const hosts = new WeakMap<SshTransport, RemoteWindowsHost>();

/** The one client of a Windows SSH host per transport, so the helper is staged once. */
export function remoteWindowsHost(ssh: SshTransport): RemoteWindowsHost {
  let host = hosts.get(ssh);
  if (!host) {
    host = new RemoteWindowsHost(ssh);
    hosts.set(ssh, host);
  }
  return host;
}

export class RemoteWindowsHost implements WindowsHostOps {
  private staged: Promise<string> | undefined;

  constructor(readonly ssh: SshTransport) {}

  /** The staged helper's path on the host. */
  helper(restage = false): Promise<string> {
    if (restage || this.staged === undefined) {
      const pending = this.stage();
      this.staged = pending;
      pending.catch(() => {
        if (this.staged === pending) this.staged = undefined;
      });
    }
    return this.staged!;
  }

  private async stage(): Promise<string> {
    const code = readFileSync(helperFile());
    const sha256 = createHash('sha256').update(code).digest('hex');
    const name = `windows-host-${sha256.slice(0, 16)}.mjs`;
    const result = await this.ssh.execWindows(stageScript(name, sha256, code.length), {
      payload: code,
      timeoutMs: 60_000,
    });
    let path: unknown;
    try {
      path = (JSON.parse(result.stdout.trim()) as { path?: unknown }).path;
    } catch {
      path = undefined;
    }
    if (result.code !== 0 || typeof path !== 'string') {
      throw new CliError(
        'daemon_unreachable',
        `could not stage the Puddle host helper on ${this.ssh.label}`,
        lastLines(result.stderr) || undefined,
      );
    }
    return path;
  }

  /**
   * One helper operation: relays its log lines, resolves with its result and
   * throws the CliError it reports. A helper that %TEMP% clean-up removed
   * meanwhile is staged again once.
   */
  async run(op: string, request: unknown, opts: HelperRun = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const helper = await this.helper(attempt > 0);
      const script = runHelperScript(helper, op, request, opts.runtime ?? 'current');
      const outcome = await this.collect(script, opts);
      if (outcome.code === HELPER_MISSING_EXIT && attempt === 0) continue;
      if (outcome.code === NO_RUNTIME_EXIT) throw new NoRuntimeError(this.ssh.label);
      return this.settle(op, outcome);
    }
  }

  private async collect(
    script: string,
    opts: HelperRun,
  ): Promise<{ code: number; stderr: string; result?: { value?: unknown }; error?: CliError }> {
    const logger = opts.logger ?? silentLogger;
    let result: { value?: unknown } | undefined;
    let error: CliError | undefined;
    const read = lineReader((message) => {
      if (message.t === 'log') logger[message.level](message.message);
      else if (message.t === 'out') opts.onOut?.(message.text);
      else if (message.t === 'result') result = { value: message.value };
      else if (message.t === 'error') error = helperError(message);
    });
    const outcome = await this.ssh.execWindows(script, {
      onStdout: read,
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return {
      code: outcome.code,
      stderr: outcome.stderr,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }

  private settle(
    op: string,
    outcome: { code: number; stderr: string; result?: { value?: unknown }; error?: CliError },
  ): unknown {
    if (outcome.error) throw outcome.error;
    if (outcome.result) return outcome.result.value;
    throw new CliError(
      'not_installed',
      `the ${op} operation failed on ${this.ssh.label} (exit ${outcome.code})`,
      lastLines(outcome.stderr) || undefined,
    );
  }

  /** host-control.ts --inspect's single line, run on the host. */
  async inspect(): Promise<string> {
    const helper = await this.helper();
    let result = await this.ssh.execWindows(runHelperScript(helper, 'inspect', {}, 'current'), {
      timeoutMs: 30_000,
    });
    if (result.code === HELPER_MISSING_EXIT) {
      const restaged = await this.helper(true);
      result = await this.ssh.execWindows(runHelperScript(restaged, 'inspect', {}, 'current'), {
        timeoutMs: 30_000,
      });
    }
    return result.stdout;
  }

  /**
   * The control channel. The helper adds the challenge the client cannot
   * check here (it has no access to the host's ipc-key) and verifies the
   * proof host-side before relaying anything.
   */
  async openChannel(): Promise<Duplex> {
    const helper = await this.helper();
    return this.ssh.openWindowsChannel(runHelperScript(helper, 'channel', {}, 'current'));
  }

  /** From the probe: no node.exe has to start, and a tree of another architecture is none. */
  async installedVersion(): Promise<string | null> {
    const probe = await this.ssh.windowsProbe(true);
    if (probe.current === null || probe.node !== probe.arch) return null;
    return versionFromLinkTarget(probe.current, 'win32') ?? null;
  }

  /** From the probe, whatever the tree's architecture: what removal and upgrades act on. */
  async presentVersion(): Promise<string | null> {
    const probe = await this.ssh.windowsProbe(true);
    if (probe.current === null) return null;
    return versionFromLinkTarget(probe.current, 'win32') ?? null;
  }

  /**
   * Run by whichever runtime the home has: an x64 tree on Arm still runs
   * (emulated), and its daemon may hold the pipe. Without a node.exe that
   * runs here, no daemon of that tree can run either.
   */
  async pipePresent(): Promise<boolean> {
    const probe = await this.ssh.windowsProbe(true);
    if (probe.current === null || probe.node === null) return false;
    const state = await this.run('pipe', {}, { timeoutMs: 30_000 }).catch((err: unknown) => {
      // Windows 10 on Arm runs no x64 program at all.
      if (probe.node !== probe.arch) return 'absent';
      throw err;
    });
    return state === 'daemon' || state === 'unknown';
  }

  /**
   * Install (or start) a release: by the installed runtime's temporary copy
   * when it is this machine's build, else by the release archive's own
   * node.exe, fetched or streamed by the bootstrap script (decision 3). The
   * client always names the release and its repository.
   */
  async install(opts: WindowsInstallRequest): Promise<void> {
    const logger = opts.logger ?? silentLogger;
    const probe = await this.ssh.windowsProbe(true);
    const outcome = await this.installAs(probe, opts, logger);
    // Only a supervisor WMI created carries the session's token: the logon
    // task runs without elevation, and one already running was not started here.
    const started = (outcome as { started?: unknown } | undefined)?.started;
    if (probe.elevated && started === 'process') {
      logger.warn(elevatedWarning(this.ssh.label, 'wmi'));
    }
  }

  private async installAs(
    probe: WindowsProbe,
    opts: WindowsInstallRequest,
    logger: Logger,
  ): Promise<unknown> {
    const tarball = opts.tarball;
    if (tarball !== undefined && /^https?:\/\//.test(tarball)) {
      throw new CliError('bad_arguments', '--tarball must be a local file path');
    }
    if (tarball !== undefined && !existsSync(tarball)) {
      throw new CliError('not_installed', `tarball not found: ${tarball}`);
    }
    const version =
      opts.version ??
      (tarball !== undefined ? versionFromArchiveName(tarball) : pinnedDaemonVersion());
    if (version === undefined) {
      throw new CliError(
        'bad_arguments',
        `cannot derive a version from ${win32.basename(tarball!)}`,
        `name it puddled-v<version>-win32-${probe.arch}.zip, or pass the version explicitly`,
      );
    }
    const slug = repoSlug();
    const request = {
      version,
      ...(opts.replaceRunning === false ? { replaceRunning: false } : {}),
      ...(slug !== undefined ? { slug } : {}),
    };
    logger.info(`installing puddled ${version} on ${this.ssh.label}`);
    if (tarball !== undefined) return this.bootstrap(version, request, logger, tarball);
    if (probe.node === probe.arch) {
      return this.run('install', request, {
        runtime: 'copy',
        logger,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
    }
    return this.bootstrap(version, request, logger);
  }

  private async bootstrap(
    version: string,
    install: Record<string, unknown>,
    logger: Logger,
    tarball?: string,
  ): Promise<unknown> {
    const helper = await this.helper();
    let archive: Parameters<typeof bootstrapScript>[0]['archive'];
    if (tarball !== undefined) {
      const name = process.platform === 'win32' ? win32.basename(tarball) : basename(tarball);
      const hash = createHash('sha256');
      await pipeline(createReadStream(tarball), hash);
      const sha256 = hash.digest('hex');
      const sums = `${tarball}.sha256`;
      const listed = existsSync(sums) ? parseSums(readFileSync(sums, 'utf8')).get(name) : undefined;
      if (existsSync(sums) && listed !== sha256) {
        throw new CliError('not_installed', `checksum mismatch for ${tarball}`);
      }
      archive = { name, length: statSync(tarball).size, sha256, verified: listed !== undefined };
      logger.info(`delivering ${name} to ${this.ssh.label}`);
    }
    const script = bootstrapScript({
      version,
      install,
      helper,
      ...(archive ? { archive } : {}),
      ...(typeof install.slug === 'string' ? { slug: install.slug } : {}),
    });
    const outcome = await this.collectStream(script, logger, tarball);
    return this.settle('installation', outcome);
  }

  /** collect() with a file streamed after the script. */
  private async collectStream(script: string, logger: Logger, file?: string) {
    let result: { value?: unknown } | undefined;
    let error: CliError | undefined;
    const read = lineReader((message) => {
      if (message.t === 'log') logger[message.level](message.message);
      else if (message.t === 'result') result = { value: message.value };
      else if (message.t === 'error') error = helperError(message);
    });
    const outcome = await this.ssh.execWindows(script, {
      onStdout: read,
      timeoutMs: INSTALL_TIMEOUT_MS,
      ...(file !== undefined ? { payload: createReadStream(file) } : {}),
    });
    return {
      code: outcome.code,
      stderr: outcome.stderr,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }

  /**
   * Stop the daemon `pid` only, while the home still names it (runtime.json
   * or puddled.pid): an attached lease's own daemon, never the home's
   * supervisor or a daemon started meanwhile by its task or another launcher.
   */
  async stopDaemon(pid: number, logger?: Logger): Promise<unknown> {
    return this.run('stop-daemon', { pid }, { ...(logger ? { logger } : {}), timeoutMs: 60_000 });
  }

  async sweep(): Promise<string[]> {
    if ((await this.presentVersion()) === null) return [];
    const value = await this.run('sweep', {}, { timeoutMs: 2 * 60_000 });
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  /** From a temporary copy of node.exe: the installed one's image would keep its tree. */
  async remove(opts: { purge: boolean; logger?: Logger }): Promise<void> {
    await this.run(
      'remove',
      { purge: opts.purge },
      { runtime: 'copy', timeoutMs: 2 * 60_000, ...(opts.logger ? { logger: opts.logger } : {}) },
    );
  }

  async logs(opts: LogsOptions): Promise<void> {
    await this.run(
      'logs',
      {
        ...(opts.session !== undefined ? { session: opts.session } : {}),
        ...(opts.term !== undefined ? { term: opts.term } : {}),
        follow: opts.follow === true,
      },
      {
        onOut: opts.write,
        ...(opts.follow ? {} : { timeoutMs: 30_000 }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
  }

  /**
   * One helper run, without the probe: the cockpit's remote access settings
   * ask on every status poll, and each SSH round trip from a Windows client
   * authenticates again. A home without a runtime has no connector.
   */
  async connectorInstalled(): Promise<{ installed: boolean; version: string | null }> {
    let value: { installed?: unknown; version?: unknown } | undefined;
    try {
      value = (await this.run('connector-installed', {}, { timeoutMs: 30_000 })) as typeof value;
    } catch (err) {
      if (err instanceof NoRuntimeError) return { installed: false, version: null };
      throw err;
    }
    return {
      installed: value?.installed === true,
      version: typeof value?.version === 'string' ? value.version : null,
    };
  }

  /** One connector mode; values travel only on standard input, as on POSIX hosts. */
  async connector(
    args: readonly string[],
    opts: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<ConnectorRun> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const value = (await this.run(
      'connector',
      { args, timeoutMs },
      { payload: opts.stdin ?? '', timeoutMs: timeoutMs + 60_000 },
    )) as Partial<ConnectorRun> | undefined;
    return {
      code: typeof value?.code === 'number' ? value.code : 1,
      stdout: typeof value?.stdout === 'string' ? value.stdout : '',
      stderr: typeof value?.stderr === 'string' ? value.stderr : '',
    };
  }

  /** `puddle remote run`: the connector's manager, its output passed through as it comes. */
  async connectorForeground(write: (text: string) => void): Promise<number> {
    const helper = await this.helper();
    const result = await this.ssh.execWindows(
      runHelperScript(helper, 'connector-run', {}, 'current'),
      { onStdout: write },
    );
    return result.code;
  }

  /**
   * The daemon attached to a channel of its own (the lease of last resort):
   * it runs as long as the returned command, which reports its pid first.
   */
  async attached(port?: number): Promise<{ command: RunningSshCommand; pid: Promise<number> }> {
    const helper = await this.helper();
    let started: (pid: number) => void = () => {};
    let failed: (err: Error) => void = () => {};
    const pid = new Promise<number>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    pid.catch(() => {});
    const read = lineReader((message) => {
      if (message.t === 'started') started(message.pid);
      else if (message.t === 'error') failed(helperError(message));
    });
    const command = this.ssh.runAttachedWindows(
      runHelperScript(helper, 'attached', port === undefined ? {} : { port }, 'current'),
      { onStdout: read },
    );
    void command.result.then((result) =>
      failed(
        new CliError(
          'daemon_start_timeout',
          `puddled exited while starting on ${this.ssh.label}`,
          lastLines(result.stderr) || undefined,
        ),
      ),
    );
    return { command, pid };
  }
}

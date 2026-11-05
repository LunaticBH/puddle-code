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
  type BootstrapOp,
  NO_RUNTIME_EXIT,
  runHelperScript,
  stageScript,
  type HelperRuntime,
  type StagedHelper,
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

/** Status 3 with nothing from the helper: it never ran, its staged copy being gone. */
function missing(outcome: HelperOutcome): boolean {
  return outcome.code === HELPER_MISSING_EXIT && !outcome.result && !outcome.error;
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

/** What one helper run said: its status, standard error, and the result or error it reported. */
interface HelperOutcome {
  code: number;
  stderr: string;
  /** No status from the loader: the connection ended or the operation was killed. */
  incomplete?: true;
  result?: { value?: unknown };
  error?: Error;
}

/** The home has no runtime, so no node.exe could run the helper. */
class NoRuntimeError extends CliError {
  constructor(label: string) {
    super('not_installed', `no Puddle runtime is installed on ${label}`);
  }
}

/**
 * The staged helper was gone (or changed) when an attached daemon was to
 * start: the client has forgotten it, so the next attempt stages it again.
 */
export class HelperMissingError extends CliError {
  constructor(label: string) {
    super('daemon_start_timeout', `the Puddle host helper was missing on ${label}`);
  }
}

/**
 * The daemon carries an administrator's elevated SSH token: WMI created its
 * supervisor from the session, or it runs attached to the session itself.
 * Until it stops, its pipes refuse that user's unelevated programs there:
 * the desktop app, a local CLI, and the logon task's supervisor, which
 * leaves the home to it. The logon task runs it without elevation, but only
 * while its user is logged on, and never beside a daemon that already
 * serves the home: the elevated one has to stop first, which only an
 * elevated session (or a restart) can make a WMI-started supervisor do.
 */
export function elevatedWarning(label: string, via: 'wmi' | 'session'): string {
  return (
    `puddled on ${label} runs elevated: an administrator's SSH session started it ` +
    `${via === 'wmi' ? 'through WMI' : 'as its own child'}, outside Task Scheduler, and ` +
    'programs there that run without elevation cannot reach it until it stops; ' +
    'to run it without elevation, log on to the machine and stay logged on, then ' +
    (via === 'wmi'
      ? `run puddle upgrade daemon ${label}, which stops it and starts it through its logon task`
      : 'launch again once this cockpit has closed: its logon task then starts it')
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
  private staged: Promise<StagedHelper> | undefined;
  /** This client has said the home's supervisor runs elevated. */
  private warnedElevated = false;

  constructor(readonly ssh: SshTransport) {}

  /** The staged helper on the host: its path and digest. */
  helper(restage = false): Promise<StagedHelper> {
    if (restage || this.staged === undefined) {
      const pending = this.stage();
      this.staged = pending;
      pending.catch(() => {
        if (this.staged === pending) this.staged = undefined;
      });
    }
    return this.staged!;
  }

  /**
   * A run of `helper` found it gone (status 3): the next operation stages
   * it again. A cockpit lives for days, and %TEMP% clean-up does not wait.
   */
  private forget(helper: StagedHelper): void {
    const pending = this.staged;
    void pending?.then(
      (current) => {
        if (current === helper && this.staged === pending) this.staged = undefined;
      },
      () => {},
    );
  }

  private async stage(): Promise<StagedHelper> {
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
    return { path, sha256 };
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
      if (missing(outcome) && attempt === 0) continue;
      if (outcome.code === NO_RUNTIME_EXIT) throw new NoRuntimeError(this.ssh.label);
      return this.settle(op, outcome);
    }
  }

  private async collect(script: string, opts: HelperRun): Promise<HelperOutcome> {
    const logger = opts.logger ?? silentLogger;
    let result: { value?: unknown } | undefined;
    let error: Error | undefined;
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
      ...(outcome.incomplete ? { incomplete: true as const } : {}),
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }

  /**
   * The helper's answer. One that never came is the helper's failure only
   * when the loader reported a status: a connection that dropped, or an
   * operation killed by its timeout, says nothing about the installed tree,
   * so it never reads as `not_installed` (which a launcher answers by
   * installing its own release).
   */
  private settle(op: string, outcome: HelperOutcome): unknown {
    if (outcome.error) throw outcome.error;
    if (outcome.result) return outcome.result.value;
    if (outcome.incomplete) {
      throw new CliError(
        'ssh_unreachable',
        `the SSH connection to ${this.ssh.label} ended during the ${op} operation (exit ${outcome.code})`,
        lastLines(outcome.stderr) || undefined,
      );
    }
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
    // The control client opens a new channel after a closed one: that one restages.
    return this.ssh.openWindowsChannel(runHelperScript(helper, 'channel', {}, 'current'), {
      onExit: (code) => {
        if (code === HELPER_MISSING_EXIT) this.forget(helper);
      },
    });
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
      this.warnedElevated = true;
      logger.warn(elevatedWarning(this.ssh.label, 'wmi'));
    }
  }

  /**
   * Warn, once per client, while the home's supervisor runs with an elevated
   * SSH session's token (the probe's elevatedSupervisor), whichever launch or
   * enable started it: logging on alone does not replace it.
   */
  async warnElevated(logger: Logger, opts: { refresh?: boolean } = {}): Promise<void> {
    if (this.warnedElevated) return;
    if (!(await this.ssh.windowsProbe(opts.refresh === true)).elevatedSupervisor) return;
    this.warnedElevated = true;
    logger.warn(elevatedWarning(this.ssh.label, 'wmi'));
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
      // The helper records a supervisor WMI starts with this session's elevated token.
      ...(probe.elevated ? { elevated: true } : {}),
    };
    logger.info(`installing puddled ${version} on ${this.ssh.label}`);
    const boot = { op: 'install' as const, version, request, logger, ...(slug ? { slug } : {}) };
    if (tarball !== undefined) return this.bootstrap({ ...boot, tarball });
    if (probe.node === probe.arch) {
      return this.run('install', request, {
        runtime: 'copy',
        logger,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
    }
    return this.bootstrap(boot);
  }

  /**
   * A removal or sweep, whose helper normally runs on the home's own
   * runtime. One whose `bin\current\bin\node.exe` is gone (quarantined, or
   * its version folder deleted while `bin\current` still names it) runs on
   * the node.exe of this launcher's release instead, fetched as a first
   * install fetches it, so a broken install can still be removed.
   */
  private async withAnyRuntime(
    op: 'remove' | 'sweep',
    request: Record<string, unknown>,
    opts: HelperRun,
  ): Promise<unknown> {
    try {
      return await this.run(op, request, opts);
    } catch (err) {
      if (!(err instanceof NoRuntimeError)) throw err;
    }
    const logger = opts.logger ?? silentLogger;
    const version = pinnedDaemonVersion();
    const slug = repoSlug();
    if (slug === undefined) {
      throw new CliError(
        'not_installed',
        `the installed runtime on ${this.ssh.label} is gone, and this build has no release ` +
          `source to fetch one from for the ${op}`,
        `set PUDDLE_REPO=owner/repo, or run puddle remove daemon on ${this.ssh.label} itself`,
      );
    }
    logger.info(
      `the installed runtime on ${this.ssh.label} is gone — fetching the node.exe of ` +
        `puddled ${version} for the ${op}`,
    );
    return this.bootstrap({ op, version, request, slug, logger });
  }

  /**
   * The bootstrap route (bootstrapScript): `op` by the release archive's own
   * node.exe, fetched with `slug` or streamed from `tarball`.
   */
  private async bootstrap(opts: {
    op: BootstrapOp;
    version: string;
    request: Record<string, unknown>;
    logger: Logger;
    slug?: string;
    tarball?: string;
  }): Promise<unknown> {
    const { op, version, logger, tarball } = opts;
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
    for (let attempt = 0; ; attempt++) {
      const script = bootstrapScript({
        op,
        version,
        install: opts.request,
        helper: await this.helper(attempt > 0),
        ...(archive ? { archive } : { ...(opts.slug !== undefined ? { slug: opts.slug } : {}) }),
      });
      const outcome = await this.collectStream(script, logger, tarball);
      // Checked before anything is fetched: a helper %TEMP% clean-up removed is staged again.
      if (missing(outcome) && attempt === 0) continue;
      return this.settle(op === 'install' ? 'installation' : op, outcome);
    }
  }

  /** collect() with a file streamed after the script. */
  private async collectStream(
    script: string,
    logger: Logger,
    file?: string,
  ): Promise<HelperOutcome> {
    let result: { value?: unknown } | undefined;
    let error: Error | undefined;
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
      ...(outcome.incomplete ? { incomplete: true as const } : {}),
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
    const value = await this.withAnyRuntime('sweep', {}, { timeoutMs: 2 * 60_000 });
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  /** From a temporary copy of node.exe: the installed one's image would keep its tree. */
  async remove(opts: { purge: boolean; logger?: Logger }): Promise<void> {
    await this.withAnyRuntime(
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
    // An enable may start the supervisor through WMI, with this session's token.
    const { elevated } = await this.ssh.windowsProbe();
    const value = (await this.run(
      'connector',
      { args, timeoutMs, ...(elevated ? { elevated: true } : {}) },
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
    for (let attempt = 0; ; attempt++) {
      const helper = await this.helper(attempt > 0);
      const result = await this.ssh.execWindows(
        runHelperScript(helper, 'connector-run', {}, 'current'),
        { onStdout: write },
      );
      // Status 3 comes before the helper starts, so nothing was written yet.
      if (result.code === HELPER_MISSING_EXIT && attempt === 0) continue;
      return result.code;
    }
  }

  /**
   * The daemon attached to a channel of its own (the lease of last resort):
   * it runs as long as the returned command, which reports its pid first.
   * `exited` resolves with the daemon's own status once the channel ends
   * (null when the helper never reported one).
   */
  async attached(
    port?: number,
    opts: { restage?: boolean } = {},
  ): Promise<{
    command: RunningSshCommand;
    pid: Promise<number>;
    exited: Promise<number | null>;
  }> {
    const helper = await this.helper(opts.restage === true);
    let started: (pid: number) => void = () => {};
    let failed: (err: Error) => void = () => {};
    const pid = new Promise<number>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    pid.catch(() => {});
    let status: number | null = null;
    const read = lineReader((message) => {
      if (message.t === 'started') started(message.pid);
      else if (message.t === 'result') {
        const code = (message.value as { code?: unknown } | undefined)?.code;
        if (typeof code === 'number') status = code;
      } else if (message.t === 'error') failed(helperError(message));
    });
    const command = this.ssh.runAttachedWindows(
      runHelperScript(helper, 'attached', port === undefined ? {} : { port }, 'current'),
      { onStdout: read },
    );
    void command.result.then((result) => {
      if (result.code === HELPER_MISSING_EXIT) {
        this.forget(helper);
        return failed(new HelperMissingError(this.ssh.label));
      }
      failed(
        new CliError(
          'daemon_start_timeout',
          `puddled exited while starting on ${this.ssh.label}`,
          lastLines(result.stderr) || undefined,
        ),
      );
    });
    return { command, pid, exited: command.result.then(() => status) };
  }
}

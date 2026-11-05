import { DAEMON_ALREADY_ACTIVE_EXIT } from '@puddle/shared/node/platform';
import type { HostConnection } from '../auth/connection-authority.js';
import {
  elevatedWarning,
  HelperMissingError,
  remoteWindowsHost,
} from '../host/windows-remote-host.js';
import { hostPaths } from '../paths.js';
import { sleep } from '../transport/net.js';
import type { RunningSshCommand, SshTransport } from '../transport/ssh.js';
import { CliError, type Logger, silentLogger } from '../types.js';
import { waitForStartedDaemon, type DaemonEndpoint, type DaemonLease } from './cockpit.js';

/** A first start may wait for Defender to scan a freshly unpacked runtime. */
const START_TIMEOUT_MS = 60_000;

/**
 * A daemon held open by an SSH channel to a Windows host: the AttachedDaemon
 * of a host where neither Task Scheduler nor WMI can start a daemon that
 * outlives the session (`session_bound`), since Windows OpenSSH ends every
 * process of a session with it. The host helper runs the installed runtime
 * as its own child; the cockpit stops exactly that pid with the daemon's
 * `shutdown` request before it closes the channel, as the POSIX lease
 * signals only the pid it captured, and the session's job ends whatever is
 * left. Durable state stays in the home, as under the supervisor.
 */
export class WindowsAttachedDaemon implements DaemonLease {
  private command: RunningSshCommand | null = null;
  private commandExited = true;
  private pid: number | null = null;
  private port: number | undefined;

  constructor(
    private readonly ssh: SshTransport,
    private readonly logger: Logger = silentLogger,
  ) {}

  async start(): Promise<DaemonEndpoint> {
    const started = await this.launchAndWait();
    if ((await this.ssh.windowsProbe()).elevated) {
      this.logger.warn(elevatedWarning(this.ssh.label, 'session'));
    }
    return { ...started, bootstrapped: true, daemonLifetime: 'cockpit', lease: this };
  }

  async ensureRunning(): Promise<void> {
    if (!this.commandExited) return;
    this.logger.info(`restarting SSH-attached puddled on ${this.ssh.label}`);
    const started = await this.launchAndWait(this.port);
    started.authority.close();
  }

  async stop(): Promise<void> {
    const command = this.command;
    const pid = this.pid;
    const running = !this.commandExited;
    this.clear();
    // Its daemon has exited already: whatever runs in the home now is not this lease's.
    if (command === null || !running) return;
    // Graceful first, as SIGTERM is on POSIX: live rows are frozen for boot
    // reconciliation and runtime.json goes before the channel closes. The
    // host stops only this pid, and only while the home still names it.
    if (pid !== null) {
      await remoteWindowsHost(this.ssh)
        .stopDaemon(pid)
        .catch(() => {});
    }
    const exited = await Promise.race([
      command.result.then(() => true),
      sleep(5000).then(() => false),
    ]);
    if (!exited) command.terminate();
  }

  /**
   * Start the attached daemon and wait for it. A helper that %TEMP% clean-up
   * removed since it was staged (a cockpit reconnecting days later) is
   * staged again once.
   */
  private async launchAndWait(
    preferredPort?: number,
  ): Promise<{ port: number; authority: HostConnection }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.launchOnce(preferredPort, attempt > 0);
      } catch (err) {
        if (!(err instanceof HelperMissingError) || attempt > 0) throw err;
      }
    }
  }

  private async launchOnce(
    preferredPort: number | undefined,
    restage: boolean,
  ): Promise<{ port: number; authority: HostConnection }> {
    const { command, pid, exited } = await remoteWindowsHost(this.ssh).attached(preferredPort, {
      restage,
    });
    this.command = command;
    this.commandExited = false;
    this.pid = null;
    void command.result.then(() => {
      if (this.command === command) {
        this.commandExited = true;
        this.pid = null;
      }
    });
    const waiting = new AbortController();
    let outcome:
      | { kind: 'started'; started: { port: number; authority: HostConnection } }
      | { kind: 'exited'; error: unknown };
    try {
      outcome = await Promise.race([
        waitForStartedDaemon(this.ssh, START_TIMEOUT_MS, waiting.signal).then((started) => ({
          kind: 'started' as const,
          started,
        })),
        // The helper reports a failure to start, or the channel's end, before
        // the daemon runs or after: one that exits at once fails the start now.
        pid.then(
          () => exited.then((status) => ({ kind: 'exited' as const, error: this.exit(status) })),
          (error: unknown) => ({ kind: 'exited' as const, error }),
        ),
      ]);
    } catch (err) {
      command.terminate();
      this.clear();
      throw err;
    } finally {
      waiting.abort();
    }
    if (outcome.kind === 'exited') {
      this.clear();
      throw outcome.error;
    }
    this.port = outcome.started.port;
    // Another daemon of the home may have won the start: only this channel's counts.
    const [claimed, runtime] = await Promise.all([pid, this.runtimePid()]);
    if (runtime !== claimed) {
      outcome.started.authority.close();
      command.terminate();
      this.clear();
      throw this.lostRace();
    }
    if (this.command === command && !this.commandExited) this.pid = claimed;
    return outcome.started;
  }

  /** Why a daemon that had started ended before it answered. */
  private exit(status: number | null): CliError {
    // Another daemon serves the home's control pipe: this one stood down.
    if (status === DAEMON_ALREADY_ACTIVE_EXIT) return this.lostRace();
    return new CliError(
      'daemon_start_timeout',
      `puddled exited while starting on ${this.ssh.label}` +
        (status === null ? '' : ` (status ${status})`),
      `inspect it with: puddle logs ${this.ssh.label}`,
    );
  }

  private lostRace(): CliError {
    return new CliError(
      'daemon_start_timeout',
      `another puddled process won the startup race on ${this.ssh.label}`,
      'close the other cockpit or wait for its daemon to stop, then launch again',
    );
  }

  private async runtimePid(): Promise<number | null> {
    const raw = await this.ssh.readFile(hostPaths.runtime);
    if (raw === null) return null;
    try {
      const value: unknown = (JSON.parse(raw) as { pid?: unknown }).pid;
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  private clear(): void {
    this.command = null;
    this.commandExited = true;
    this.pid = null;
  }
}

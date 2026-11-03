import type { HostConnection } from '../auth/connection-authority.js';
import { randomUUID } from 'node:crypto';
import { waitForStartedDaemon, type DaemonEndpoint, type DaemonLease } from './cockpit.js';
import { sleep } from '../transport/net.js';
import { hostPaths } from '../paths.js';
import type { RunningSshCommand, SshTransport } from '../transport/ssh.js';
import { CliError, type Logger, silentLogger } from '../types.js';

/**
 * A daemon held open by an SSH exec channel. This is the last-resort lifetime
 * for hosts that explicitly selected nohup but reap the child as soon as its
 * launching SSH channel closes. Durable state remains in ~/.puddle exactly as
 * it does under systemd/launchd; only the live processes follow the cockpit.
 */
export class AttachedDaemon implements DaemonLease {
  private command: RunningSshCommand | null = null;
  private commandExited = true;
  private pid: number | null = null;
  private port: number | undefined;
  private leasePidPath: string | null = null;

  constructor(
    private readonly ssh: SshTransport,
    private readonly logger: Logger = silentLogger,
  ) {}

  async start(): Promise<DaemonEndpoint> {
    const started = await this.launchAndWait();
    return {
      ...started,
      bootstrapped: true,
      daemonLifetime: 'cockpit',
      lease: this,
    };
  }

  async ensureRunning(): Promise<void> {
    if (!this.commandExited) return;
    this.logger.info(`restarting SSH-attached puddled on ${this.ssh.label}`);
    if (this.leasePidPath !== null) {
      await this.ssh.exec(`rm -f ${this.leasePidPath}`, { timeoutMs: 5000 });
    }
    this.pid = null;
    this.leasePidPath = null;
    const started = await this.launchAndWait(this.port);
    started.authority.close();
  }

  async stop(): Promise<void> {
    const command = this.command;
    if (command === null) return;
    const pid = this.pid;
    const leasePidPath = this.leasePidPath;

    // Ask the exact daemon pid captured after this lease started to shut down
    // cleanly. That freezes live rows for boot reconciliation, drains PTYs and
    // removes runtime.json before the SSH channel is closed.
    if (pid !== null) {
      await this.ssh.exec(`kill ${pid}`, { timeoutMs: 5000 });
    }
    const exited = await Promise.race([
      command.result.then(() => true),
      sleep(5000).then(() => false),
    ]);
    if (!exited) command.terminate();

    if (pid !== null) {
      await this.ssh.exec(
        `if [ -f ${hostPaths.pid} ] && [ "$(cat ${hostPaths.pid})" = "${pid}" ]; then ` +
          `rm -f ${hostPaths.pid}; fi`,
        { timeoutMs: 5000 },
      );
    }
    if (leasePidPath !== null) {
      await this.ssh.exec(`rm -f ${leasePidPath}`, { timeoutMs: 5000 });
    }
    this.command = null;
    this.commandExited = true;
    this.pid = null;
    this.leasePidPath = null;
  }

  private async launchAndWait(
    preferredPort?: number,
  ): Promise<{ port: number; authority: HostConnection }> {
    const portFlag = preferredPort === undefined ? '' : ` --port ${preferredPort}`;
    const leasePidPath = `${hostPaths.home}/attached-${randomUUID()}.pid`;
    this.leasePidPath = leasePidPath;
    const command = this.ssh.runAttached(
      `printf '%s\\n' "$$" > ${leasePidPath}; ` +
        `exec ${hostPaths.current}/puddled${portFlag} >> ${hostPaths.logs}/puddled.out.log 2>&1`,
    );
    this.command = command;
    this.commandExited = false;
    void command.result.then(() => {
      if (this.command === command) {
        this.commandExited = true;
        this.pid = null;
      }
    });

    let outcome:
      | { kind: 'started'; started: { port: number; authority: HostConnection } }
      | { kind: 'exited'; result: Awaited<RunningSshCommand['result']> };
    const waiting = new AbortController();
    try {
      outcome = await Promise.race([
        waitForStartedDaemon(this.ssh, 20_000, waiting.signal).then((started) => ({
          kind: 'started' as const,
          started,
        })),
        command.result.then((result) => ({ kind: 'exited' as const, result })),
      ]);
    } catch (err) {
      command.terminate();
      await this.clearFailedLaunch(leasePidPath);
      throw err;
    } finally {
      waiting.abort();
    }
    if (outcome.kind === 'exited') {
      await this.clearFailedLaunch(leasePidPath);
      throw await this.startFailure(outcome.result.stderr || outcome.result.stdout);
    }

    this.port = outcome.started.port;
    const [claimedPid, runtimePid] = await Promise.all([
      this.readPidFile(leasePidPath),
      this.readPidFile(hostPaths.runtime, true),
    ]);
    if (claimedPid === null || runtimePid !== claimedPid) {
      outcome.started.authority.close();
      command.terminate();
      await this.clearFailedLaunch(leasePidPath);
      throw new CliError(
        'daemon_start_timeout',
        `another puddled process won the startup race on ${this.ssh.label}`,
        'close the other cockpit or wait for its daemon to stop, then launch again',
      );
    }
    this.pid = claimedPid;
    await this.ssh.exec(`printf '%s\\n' '${this.pid}' > ${hostPaths.pid}`, { timeoutMs: 5000 });
    return outcome.started;
  }

  private async readPidFile(path: string, json = false): Promise<number | null> {
    const raw = await this.ssh.readFile(path);
    if (raw === null) return null;
    try {
      const value: unknown = json ? (JSON.parse(raw) as { pid?: unknown }).pid : Number(raw.trim());
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  private async clearFailedLaunch(leasePidPath: string): Promise<void> {
    try {
      await this.ssh.exec(`rm -f ${leasePidPath}`, { timeoutMs: 5000 });
    } catch {
      // The SSH connection may be the failure. The uniquely named file is
      // harmless residue and the next launch never trusts it.
    }
    this.command = null;
    this.commandExited = true;
    this.pid = null;
    if (this.leasePidPath === leasePidPath) this.leasePidPath = null;
  }

  private async startFailure(channelOutput: string): Promise<CliError> {
    this.command = null;
    this.commandExited = true;
    const log = await this.ssh.exec(`tail -n 20 ${hostPaths.logs}/puddled.out.log`, {
      timeoutMs: 5000,
    });
    const detail = (log.stdout || log.stderr || channelOutput)
      .trim()
      .split('\n')
      .slice(-8)
      .join('\n');
    return new CliError(
      'daemon_start_timeout',
      `puddled exited while starting on ${this.ssh.label}`,
      detail || `inspect it with: puddle logs ${this.ssh.label}`,
    );
  }
}

import { Duplex } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { clientHome } from '../paths.js';
import { CliError } from '../types.js';
import { spawnClient } from './spawn.js';
import type { ExecOptions, ExecResult, Transport } from './transport.js';

/** A remote command whose SSH channel deliberately stays open with it. */
export interface RunningSshCommand {
  /** Resolves when the remote command (or its SSH channel) exits. */
  readonly result: Promise<ExecResult>;
  /** Close the SSH channel; the remote command receives the channel hangup. */
  terminate(): void;
}

export interface SshOptions {
  /** The ssh binary to spawn — the test seam (a fake shim in tests). */
  sshBinary?: string;
  /** The scp binary for copyTo; defaults alongside sshBinary. */
  scpBinary?: string;
  /** Injected platform; win32 disables ControlMaster (unsupported there). */
  platform?: NodeJS.Platform;
  /**
   * Optional OpenSSH askpass executable supplied by a graphical embedder.
   * The CLI leaves this unset and keeps using its inherited terminal.
   */
  askpassProgram?: string;
  /**
   * Never prompt (`-o BatchMode=yes`): for a Windows background cockpit,
   * which has no terminal and, without ControlMaster, no master to reuse.
   */
  batchMode?: boolean;
}

/**
 * SSH transport over the system ssh binary (never a JS SSH library — the
 * user's ~/.ssh/config, agents, jump hosts, and 2FA prompting come free,
 * SPEC §10). A multiplexed master connection is opened once, interactively,
 * inheriting the TTY so password/2FA prompts are typed at most once; every
 * exec, the tunnel, and scp then reuse it. ControlPersist keeps the master
 * for a quick next connect; we never -O exit it.
 */
export class SshTransport implements Transport {
  readonly kind = 'ssh' as const;
  readonly label: string;
  private readonly ssh: string;
  private readonly scp: string;
  private readonly controlArgs: string[];
  private readonly keepaliveArgs: string[];
  private readonly askpassProgram: string | undefined;
  private readonly batchMode: boolean;

  constructor(
    readonly host: string,
    opts: SshOptions = {},
  ) {
    this.label = host;
    this.ssh = opts.sshBinary ?? 'ssh';
    this.scp = opts.scpBinary ?? 'scp';
    this.askpassProgram = opts.askpassProgram;
    this.batchMode = opts.batchMode ?? false;
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32') {
      // Windows OpenSSH has no multiplexing: every spawn may prompt again.
      this.controlArgs = [];
    } else {
      const home = clientHome();
      mkdirSync(home, { recursive: true, mode: 0o700 });
      this.controlArgs = [
        '-o',
        'ControlMaster=auto',
        '-o',
        // %C (a hash of the connection) keeps the socket path under the Unix
        // ~104-byte cap however long user@host is.
        `ControlPath=${home}/cm-%C`,
        '-o',
        'ControlPersist=10m',
      ];
    }
    // Application-level keepalives on whichever process owns the TCP
    // connection (the mux master on POSIX, each spawn on Windows). Without
    // them an idle NAT/firewall silently drops the connection and the tunnel
    // dies on every quiet spell — 15s×3 detects a dead peer inside a minute.
    this.keepaliveArgs = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
    if (this.batchMode) this.keepaliveArgs.push('-o', 'BatchMode=yes');
  }

  get hasControlMaster(): boolean {
    return this.controlArgs.length > 0;
  }

  /**
   * Whether ssh children start without a console window. Only a client with
   * no terminal of its own (a background cockpit, a graphical embedder) hides
   * them: on Windows a hidden child gets no console, so it could not prompt
   * on the user's terminal. Ignored outside Windows.
   */
  get hidesWindows(): boolean {
    return this.batchMode || this.askpassProgram !== undefined;
  }

  /** Argv prefix every ssh/scp spawn shares. */
  args(...rest: string[]): string[] {
    return [...this.controlArgs, ...this.keepaliveArgs, ...rest];
  }

  /**
   * Every ssh/scp child, with this client's environment. The program is
   * resolved for the OS this runs on, whichever platform the argv targets.
   */
  private spawn(file: string, args: string[], options: SpawnOptions): ChildProcess {
    return spawnClient(file, args, {
      ...options,
      env: this.spawnEnv(),
      ...(this.hidesWindows ? { windowsHide: true } : {}),
    });
  }

  /**
   * Environment for every ssh/scp child. `force` is scoped to graphical
   * embedders that supplied a helper; normal CLI launches still talk to the
   * inherited TTY exactly as before. OpenSSH also requires DISPLAY to be set
   * before it considers askpass, even when the helper is not an X11 program.
   */
  spawnEnv(): NodeJS.ProcessEnv | undefined {
    if (this.askpassProgram === undefined) return undefined;
    return {
      ...process.env,
      SSH_ASKPASS: this.askpassProgram,
      SSH_ASKPASS_REQUIRE: 'force',
      PUDDLE_DESKTOP_SSH_TARGET: this.host,
      DISPLAY: process.env.DISPLAY ?? 'puddle',
    };
  }

  /**
   * Open the master through the caller's authentication surface: the CLI's
   * inherited TTY or a graphical embedder's askpass helper. Exit 0 leaves a
   * live control socket behind.
   */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.ssh, this.args(this.host, 'true'), {
        // A GUI has no useful inherited terminal; OpenSSH calls its askpass
        // helper instead. The terminal CLI keeps byte-for-byte inheritance.
        stdio: this.askpassProgram === undefined ? 'inherit' : 'ignore',
      });
      child.on('error', (err) =>
        reject(new CliError('ssh_unreachable', `could not run ${this.ssh}: ${err.message}`)),
      );
      child.on('close', (code) => {
        if (code === 0) resolve();
        else {
          reject(
            new CliError(
              'ssh_unreachable',
              `could not open an SSH connection to ${this.host}`,
              `check that '${this.ssh} ${this.host}' works on its own`,
            ),
          );
        }
      });
    });
  }

  /** Whether the master connection is still alive (-O check). */
  isAlive(): Promise<boolean> {
    if (!this.hasControlMaster) return Promise.resolve(true);
    return new Promise((resolve) => {
      const child = this.spawn(this.ssh, this.args('-O', 'check', this.host), {
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  /**
   * Best-effort removal of a multiplexed local forward (`-O cancel`). A
   * non-OpenSSH server (Tailscale SSH) attaches the `-L` to the master and it
   * outlives the spawning client — killing that client does not remove it, so
   * the forward must be cancelled explicitly or the local port stays forwarded
   * until the master lapses. A no-op (and unnecessary) without a master, where
   * the forward dies with its own ssh process.
   */
  cancelForward(localPort: number, remotePort: number): Promise<void> {
    if (!this.hasControlMaster) return Promise.resolve();
    return new Promise((resolve) => {
      const spec = `${localPort}:127.0.0.1:${remotePort}`;
      const child = this.spawn(this.ssh, this.args('-O', 'cancel', '-L', spec, this.host), {
        stdio: 'ignore',
      });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = this.spawn(
        this.ssh,
        this.args(this.host, '--', `sh -c ${shellQuote(command)}`),
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
        timer.unref();
      }
      child.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        opts.onStdout?.(text);
      });
      child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err) });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin!.on('error', () => {}); // EPIPE is reported by the command's exit status.
      if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
      else child.stdin!.end();
    });
  }

  /**
   * Run a command through a live SSH channel instead of waiting for a detached
   * supervisor to adopt it. Used by the daemon lease on hosts that reap nohup
   * children when an SSH exec channel closes.
   */
  runAttached(command: string): RunningSshCommand {
    const child = this.spawn(this.ssh, this.args(this.host, '--', `sh -c ${shellQuote(command)}`), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const result = new Promise<ExecResult>((resolve) => {
      child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    return {
      result,
      terminate() {
        child.kill('SIGTERM');
      },
    };
  }

  async readFile(path: string): Promise<string | null> {
    const result = await this.exec(`cat ${path}`, { timeoutMs: 15_000 });
    return result.code === 0 ? result.stdout : null;
  }

  async copyTo(localPath: string, destPath: string): Promise<void> {
    await this.exec(`mkdir -p $(dirname ${destPath})`, { timeoutMs: 15_000 });
    await new Promise<void>((resolve, reject) => {
      const child = this.spawn(
        this.scp,
        [...this.controlArgs, localPath, `${this.host}:${destPath}`],
        {
          stdio: ['ignore', 'ignore', 'inherit'],
        },
      );
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new CliError('ssh_unreachable', `scp to ${this.host} failed (exit ${code})`));
      });
    });
  }

  openChannel(command: string): Duplex {
    const child = this.spawn(
      this.ssh,
      this.args('-T', this.host, '--', `sh -c ${shellQuote(command)}`),
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
    child.stderr!.resume(); // diagnostics must not enter the credential protocol
    child.once('error', () => stream.destroy(new Error('SSH control channel failed')));
    child.once('close', () => stream.destroy());
    stream.once('close', () => child.kill('SIGTERM'));
    return stream;
  }

  dispose(): void {
    // Deliberately nothing: ControlPersist keeps the master warm for the
    // next connect; the tunnel and exec children die with their own spawns.
  }
}

/** POSIX single-quote escaping for embedding in a remote sh -c. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

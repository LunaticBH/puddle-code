import { Duplex, Readable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { clientHome, hostPaths } from '../paths.js';
import { CliError } from '../types.js';
import { spawnClient } from './spawn.js';
import type { ExecOptions, ExecResult, Transport } from './transport.js';
import { isWindowsHostFailure } from './windows-host.js';
import {
  frame,
  languageModeRefusal,
  parseProbe,
  parseTrailer,
  PROBE_SCRIPT,
  readHomeFileScript,
  WINDOWS_HOME_FILES,
  windowsRemoteCommand,
  windowsScript,
  type WindowsProbe,
} from './windows-remote.js';

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
  /**
   * The host's platform as an earlier connection found it: a background
   * cockpit is told its launcher's, so it never sends a Windows host `true`.
   */
  remotePlatform?: 'win32';
  /**
   * Test seam: the PUDDLE_HOME a Windows host uses for this connection (an
   * isolated home on a real host). Hosts otherwise use their own environment.
   */
  windowsHome?: string;
}

/** A PowerShell operation's outcome on a Windows host. */
export interface WindowsExecResult extends ExecResult {
  /**
   * The loader never reported the script's status: ssh failed (255), the
   * connection dropped, or a timeout or abort killed the operation. `code`
   * is then ssh's own status, not the host's.
   */
  incomplete?: true;
}

/** Options for one PowerShell operation on a Windows host. */
export interface WindowsExecOptions {
  /** Bytes that follow the script on the same standard input. */
  payload?: string | Buffer | Readable;
  timeoutMs?: number;
  /** Standard output as it arrives, decoded as UTF-8. */
  onStdout?: (chunk: string) => void;
  /** Ends the operation (its SSH channel, and with it the session's processes). */
  signal?: AbortSignal;
}

/**
 * SSH transport over the system ssh binary (never a JS SSH library — the
 * user's ~/.ssh/config, agents, jump hosts, and 2FA prompting come free,
 * SPEC §10). A multiplexed master connection is opened once, interactively,
 * inheriting the TTY so password/2FA prompts are typed at most once; every
 * exec, the tunnel, and scp then reuse it. ControlPersist keeps the master
 * for a quick next connect; we never -O exit it.
 *
 * A Windows host (docs/windows.md) is recognised only when POSIX `true`
 * fails on an authenticated connection: one PowerShell probe then decides,
 * and the answer is sticky. From then on the host takes only PowerShell
 * operations (execWindows and its channel forms, windows-remote.ts); a POSIX
 * command sent to it is refused, never run by whichever shell answers.
 */
export class SshTransport implements Transport {
  readonly kind = 'ssh' as const;
  readonly label: string;
  /** Set once the host is recognised as Windows; never cleared. */
  remotePlatform: 'win32' | undefined;
  private readonly ssh: string;
  private readonly scp: string;
  private readonly controlArgs: string[];
  private readonly keepaliveArgs: string[];
  private readonly askpassProgram: string | undefined;
  private readonly batchMode: boolean;
  private readonly windowsHome: string | undefined;
  private probe: WindowsProbe | undefined;

  constructor(
    readonly host: string,
    opts: SshOptions = {},
  ) {
    this.label = host;
    this.ssh = opts.sshBinary ?? 'ssh';
    this.scp = opts.scpBinary ?? 'scp';
    this.askpassProgram = opts.askpassProgram;
    this.batchMode = opts.batchMode ?? false;
    this.remotePlatform = opts.remotePlatform;
    this.windowsHome = opts.windowsHome;
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
   *
   * Status 255 is ssh's own failure. Any other failure of `true` happened on
   * an authenticated connection, as on a Windows host, whose default shell
   * (cmd.exe or PowerShell) has no `true`: one PowerShell probe tells, and a
   * host that does not answer it fails exactly as before. A host already
   * known to be Windows is opened with the probe alone.
   */
  open(): Promise<void> {
    if (this.remotePlatform === 'win32') return this.openWindows();
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
        if (code === 0) return resolve();
        const unreachable = this.unreachable();
        if (code === null || code === 255) return reject(unreachable);
        this.recogniseWindows().then(
          (windows) => (windows ? resolve() : reject(unreachable)),
          (err: unknown) => reject(err instanceof CliError ? err : unreachable),
        );
      });
    });
  }

  private unreachable(): CliError {
    return new CliError(
      'ssh_unreachable',
      `could not open an SSH connection to ${this.host}`,
      `check that '${this.ssh} ${this.host}' works on its own`,
    );
  }

  /**
   * The PowerShell probe; true (and the transport switched to win32) when
   * the host answers it as a Windows host. A ConstrainedLanguage session
   * rejects with a clear refusal.
   */
  private async recogniseWindows(): Promise<boolean> {
    const result = await this.execWindows(PROBE_SCRIPT, { timeoutMs: 60_000 });
    const probe = result.code === 0 ? parseProbe(result.stdout) : null;
    if (probe === null) return false;
    this.probe = probe;
    this.remotePlatform = 'win32';
    return true;
  }

  /**
   * A host whose own answer says it is Windows (its connector's `--version`,
   * reached through a Git Bash default shell), confirmed with the probe;
   * true once the transport is win32. A ConstrainedLanguage session rejects.
   */
  async confirmWindows(): Promise<boolean> {
    if (this.remotePlatform === 'win32') return true;
    return this.recogniseWindows();
  }

  private async openWindows(): Promise<void> {
    await this.windowsProbe(true);
  }

  /**
   * What the Windows host reports about itself (windows-remote.ts); asked
   * again with `refresh`, since installation changes it.
   */
  async windowsProbe(refresh = false): Promise<WindowsProbe> {
    if (this.remotePlatform !== 'win32') throw new Error(`${this.host} is not a Windows host`);
    if (refresh || this.probe === undefined) {
      const result = await this.execWindows(PROBE_SCRIPT, { timeoutMs: 60_000 });
      const probe = result.code === 0 ? parseProbe(result.stdout) : null;
      if (probe === null) throw this.unreachable();
      this.probe = probe;
    }
    return this.probe;
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

  /**
   * `sh -c <command>` on a POSIX host. For a command that may reveal a
   * Windows host (`revealsWindows`: a Git Bash default shell passes `true`,
   * then the helper stage's node.exe or install.sh's `uname` gives it away),
   * a failure that reads as Windows answering it is confirmed with the
   * PowerShell probe. ssh's own failure (255) and a killed command (-1) are
   * no answer from the host. The result is returned unchanged either way,
   * and the caller re-dispatches on the transport's platform.
   */
  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.remotePlatform === 'win32') return Promise.reject(this.posixRefusal());
    return this.execPosix(command, opts).then(async (result) => {
      if (
        opts.revealsWindows === true &&
        result.code !== 255 &&
        result.code !== -1 &&
        isWindowsHostFailure(result)
      ) {
        await this.recogniseWindows().catch(() => false);
      }
      return result;
    });
  }

  /** A POSIX command meant for this host after it was recognised as Windows. */
  private posixRefusal(): CliError {
    return new CliError(
      'unsupported_platform',
      `a POSIX host command was about to be sent to ${this.host}, a Windows host`,
      'report it with the command you ran',
    );
  }

  private execPosix(command: string, opts: ExecOptions): Promise<ExecResult> {
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
    if (this.remotePlatform === 'win32') throw this.posixRefusal();
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

  /**
   * A host file. On a Windows host only the home files the host-path
   * constants name can be read (paths.ts): the host resolves its own home.
   */
  async readFile(path: string): Promise<string | null> {
    if (this.remotePlatform === 'win32') {
      const prefix = `${hostPaths.home}/`;
      const name = path.startsWith(prefix) ? path.slice(prefix.length) : '';
      if (!WINDOWS_HOME_FILES.includes(name)) throw this.posixRefusal();
      const result = await this.execWindows(readHomeFileScript(name), { timeoutMs: 15_000 });
      return result.code === 0 ? result.stdout : null;
    }
    const result = await this.exec(`cat ${path}`, { timeoutMs: 15_000 });
    return result.code === 0 ? result.stdout : null;
  }

  /** POSIX hosts only: a Windows host receives archives on an operation's own stdin. */
  async copyTo(localPath: string, destPath: string): Promise<void> {
    if (this.remotePlatform === 'win32') throw this.posixRefusal();
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
    if (this.remotePlatform === 'win32') throw this.posixRefusal();
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

  /** One ssh child running the Windows loader, its script already framed on stdin. */
  private spawnWindows(script: string, extra: string[] = []): ChildProcess {
    const child = this.spawn(
      this.ssh,
      this.args(...extra, this.host, '--', windowsRemoteCommand()),
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdin!.on('error', () => {}); // EPIPE is reported by the operation's status.
    child.stdin!.write(frame(windowsScript(script, { home: this.windowsHome })));
    return child;
  }

  /**
   * One PowerShell operation on a Windows host (windows-remote.ts), resolving
   * with the script's own status from the loader's trailer. Like exec, it
   * never rejects on a non-zero status, except for a ConstrainedLanguage
   * session, where no operation can run.
   */
  execWindows(script: string, opts: WindowsExecOptions = {}): Promise<WindowsExecResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnWindows(script);
      const out: Buffer[] = [];
      const decoder = new StringDecoder('utf8');
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
        timer.unref();
      }
      const abort = () => child.kill('SIGTERM');
      if (opts.signal?.aborted) abort();
      opts.signal?.addEventListener('abort', abort, { once: true });
      child.once('close', () => opts.signal?.removeEventListener('abort', abort));
      child.stdout!.on('data', (chunk: Buffer) => {
        out.push(chunk);
        if (opts.onStdout) {
          const text = decoder.write(chunk);
          if (text !== '') opts.onStdout(text);
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          code: -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: String(err),
          incomplete: true,
        });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const trailer = parseTrailer(stderr);
        const refusal =
          trailer.code === null || /puddle-language-mode:/.test(trailer.stderr)
            ? languageModeRefusal(this.host, trailer.stderr)
            : null;
        if (refusal) return reject(refusal);
        resolve({
          code: trailer.code ?? code ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: trailer.stderr,
          ...(trailer.code === null ? { incomplete: true as const } : {}),
        });
      });
      const payload = opts.payload;
      if (payload instanceof Readable) {
        payload.on('error', () => child.kill('SIGKILL'));
        payload.pipe(child.stdin!);
      } else child.stdin!.end(payload);
    });
  }

  /**
   * A PowerShell operation whose SSH channel stays open with it (the
   * Windows counterpart of runAttached): the session's kill-on-close job
   * ends whatever it started when the channel closes.
   */
  runAttachedWindows(
    script: string,
    opts: { onStdout?: (chunk: string) => void } = {},
  ): RunningSshCommand {
    const child = this.spawnWindows(script);
    child.stdin!.end();
    let stdout = '';
    let stderr = '';
    const decoder = new StringDecoder('utf8');
    const result = new Promise<ExecResult>((resolve) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk);
        stdout += text;
        if (text !== '') opts.onStdout?.(text);
      });
      child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
      child.on('close', (code) => {
        const trailer = parseTrailer(stderr);
        resolve({ code: trailer.code ?? code ?? -1, stdout, stderr: trailer.stderr });
      });
    });
    return {
      result,
      terminate() {
        child.kill('SIGTERM');
      },
    };
  }

  /**
   * A credential channel to a Windows host: openChannel's counterpart,
   * framed. `onExit` receives the script's own status from the loader's
   * trailer as the channel ends (null without one).
   */
  openWindowsChannel(
    script: string,
    opts: { onExit?: (code: number | null) => void } = {},
  ): Duplex {
    const child = this.spawnWindows(script, ['-T']);
    const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
    // Diagnostics must not enter the credential protocol: only the end of
    // standard error is kept, for the trailer.
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.once('error', () => stream.destroy(new Error('SSH control channel failed')));
    child.once('close', () => {
      opts.onExit?.(parseTrailer(stderr).code);
      stream.destroy();
    });
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

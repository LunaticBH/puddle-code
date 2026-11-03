import type { ChildProcess } from 'node:child_process';
import { findFreePort, sleep, tcpListening, waitForTcp } from './net.js';
import { spawnClient } from './spawn.js';
import type { SshTransport } from './ssh.js';
import { CliError, type CliEvent, type Logger, silentLogger } from '../types.js';

/** An `ssh -N -L` client, spawned the way the transport spawns its own children. */
function spawnForwardClient(ssh: SshTransport, binary: string, args: string[]): ChildProcess {
  return spawnClient(binary, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: ssh.spawnEnv(),
    ...(ssh.hidesWindows ? { windowsHide: true } : {}),
  });
}

export interface Tunnel {
  /** The forward's local end — pure transport, never user-visible. */
  readonly localPort: number;
  onEvent(cb: (e: CliEvent) => void): () => void;
  /** The port may move if the original is stolen during a reconnect. */
  onPortChange(cb: (port: number) => void): () => void;
  /** Immediate transport availability, before notification debounce. */
  onAvailability(cb: (available: boolean) => void): () => void;
  close(): Promise<void>;
}

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** An outage restored inside this window is a blip, not news (see below). */
const DOWN_GRACE_MS = 2000;
/** A drop this soon after a restore is instability — announce it at once. */
const STABLE_MS = 30_000;
/** How often the forward's liveness (its local listener) is re-checked. */
const HEALTH_INTERVAL_MS = 1000;

/**
 * Best-effort FIXED-port forward (`-L <port>:127.0.0.1:<port>`) for an agent's
 * OAuth callback. Codex's ChatGPT login redirects the CLIENT browser to a
 * registered `http://localhost:1455/...` redirect URI — an address on the
 * client machine that no proxy rewrite can change — so completing it against
 * a remote daemon needs the client's own port 1455 carried to the host
 * (codex's documented headless-SSH recipe). Unlike openTunnel this is not
 * load-bearing: no health loop, no reconnect, and a busy local port (another
 * cockpit, or a genuinely local login server) skips it with a warning rather
 * than failing the connect. Returns a closer, or null when skipped.
 */
export async function openCallbackForward(
  ssh: SshTransport,
  port: number,
  opts: { sshBinary?: string; logger?: Logger } = {},
): Promise<(() => Promise<void>) | null> {
  const logger = opts.logger ?? silentLogger;
  const skip = (why: string) => {
    logger.warn(
      `agent OAuth callback port ${port} not forwarded (${why}) — ` +
        `a remote ChatGPT-style login that calls back to localhost:${port} will not complete`,
    );
    return null;
  };
  if (await tcpListening(port)) return skip('local port busy');
  const child = spawnForwardClient(
    ssh,
    opts.sshBinary ?? 'ssh',
    ssh.args('-N', '-L', `${port}:127.0.0.1:${port}`, ssh.host),
  );
  if (!(await waitForTcp(port, 5000))) {
    child.kill('SIGTERM');
    void ssh.cancelForward(port, port);
    return skip('forward did not come up');
  }
  return () => {
    child.kill('SIGTERM');
    // A mux server leaves the -L on the master after the client dies (see
    // openTunnel's header): cancel it or the port leaks until the master ends.
    return ssh.cancelForward(port, port);
  };
}

/**
 * `ssh -N -L <localPort>:127.0.0.1:<remotePort>` over the master connection,
 * with auto-reconnect.
 *
 * The spawned ssh client is NOT the source of truth for the forward's health.
 * Over a multiplexed master a non-OpenSSH server (Tailscale SSH) installs the
 * forward on the master and the client exits immediately while the forward
 * keeps carrying traffic — and killing that client does not remove the forward
 * (only `ssh -O cancel` does). So the forward is judged by the forward itself:
 * readiness is the local listener accepting **and** an end-to-end probe
 * reaching the daemon; liveness is a periodic check of that local listener. On
 * loss the master is checked (re-opened if ControlPersist lapsed — a prompt may
 * reappear, correctly) and the forward respawned on the SAME local port so the
 * UI server's target stays put; only if that port got stolen meanwhile is a new
 * one picked and announced via onPortChange.
 *
 * tunnel-down/tunnel-up are announcements, not raw telemetry: an outage that
 * heals inside the grace window emits nothing (reconnecting on the first
 * attempt is a blip, and a lost/restored pair for every blip reads like a
 * broken tunnel) — unless it follows a recent restore, which means flapping and
 * is announced immediately.
 */
export async function openTunnel(
  ssh: SshTransport,
  remotePort: number,
  opts: {
    sshBinary?: string;
    logger?: Logger;
    downGraceMs?: number;
    healthIntervalMs?: number;
    /**
     * End-to-end readiness: given the forward's local port, resolve true once
     * the forward actually carries traffic to the daemon (e.g. an HTTP probe of
     * `/api/version` through it). This is what makes readiness robust across
     * SSH server implementations — we trust the bytes reaching the daemon, not
     * ssh's own opinion of the forward, nor whether the spawning client lived.
     * Defaults to "the local socket accepting is enough", the generic
     * behaviour.
     */
    ready?: (localPort: number) => Promise<boolean>;
  } = {},
): Promise<Tunnel> {
  const logger = opts.logger ?? silentLogger;
  const sshBinary = opts.sshBinary ?? 'ssh';
  const downGraceMs = opts.downGraceMs ?? DOWN_GRACE_MS;
  const healthIntervalMs = opts.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  const isReady = opts.ready ?? (() => Promise.resolve(true));
  const eventCbs = new Set<(e: CliEvent) => void>();
  const availabilityCbs = new Set<(available: boolean) => void>();
  const portCbs = new Set<(port: number) => void>();
  const emit = (e: CliEvent) => eventCbs.forEach((cb) => cb(e));

  let localPort = await findFreePort();
  // Property access instead of a bare `let`: TS narrows a closure-assigned
  // local to null/never at the call sites below.
  const state: { child: ChildProcess | null } = { child: null };
  let stopping = false;
  let lastRestoredAt = 0;
  // True while a reconnect loop owns the lifecycle — the health monitor stands
  // down and lets that loop resume it on completion.
  let reconnectActive = false;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;

  const spawnForward = async (port: number): Promise<boolean> => {
    if (stopping) return false;
    const child = spawnForwardClient(
      ssh,
      sshBinary,
      ssh.args('-N', '-L', `${port}:127.0.0.1:${remotePort}`, ssh.host),
    );
    state.child = child;
    // Readiness by the forward, not the client: the local end accepts and the
    // daemon answers through it. We deliberately do not require this ssh child
    // to still be running — under a mux master it may have already handed the
    // forward off and exited (see the header comment).
    const ready = (await waitForTcp(port, 5000)) && (await isReady(port));
    if (!ready) discard(child, port);
    return ready;
  };

  /** Kill a forward we gave up on, and remove any copy left on the master. */
  const discard = (child: ChildProcess, port: number) => {
    if (state.child === child) state.child = null;
    child.kill('SIGTERM');
    // A mux server (Tailscale) leaves the -L on the master after the client
    // dies, so an abandoned forward must be cancelled or it leaks its port.
    void ssh.cancelForward(port, remotePort);
  };

  const scheduleHealthCheck = () => {
    if (stopping || healthTimer !== null) return;
    healthTimer = setTimeout(() => void healthCheck(), healthIntervalMs);
  };

  const healthCheck = async (): Promise<void> => {
    healthTimer = null;
    if (stopping) return;
    if (reconnectActive) {
      scheduleHealthCheck(); // a reconnect owns things; just keep the beat
      return;
    }
    // The local listener is the liveness signal — it drops when the owning
    // client (non-mux) or the master (mux) dies. The end-to-end probe is
    // reserved for readiness; a cheap loopback check here does not conflate a
    // momentarily-unreachable daemon with a dead tunnel.
    if (await tcpListening(localPort)) {
      scheduleHealthCheck();
      return;
    }
    if (stopping || reconnectActive) return;
    void reconnect();
  };

  const reconnect = async () => {
    if (reconnectActive || stopping) return; // set synchronously below — single loop, always
    reconnectActive = true;
    availabilityCbs.forEach((cb) => cb(false));
    const flapping = lastRestoredAt !== 0 && Date.now() - lastRestoredAt < STABLE_MS;
    let announced = false;
    const announce = () => {
      announced = true;
      emit({ t: 'tunnel-down' });
    };
    const grace = flapping ? null : setTimeout(announce, downGraceMs);
    if (flapping) announce();

    let delay = RECONNECT_INITIAL_MS;
    let restored = false;
    try {
      while (!stopping) {
        await sleep(delay);
        if (stopping) break;
        if (!(await ssh.isAlive())) {
          try {
            // May prompt on the TTY in --foreground mode or through an
            // embedder-supplied askpass helper. A detached CLI cockpit has
            // neither, so password/2FA re-auth keeps retrying in its log.
            await ssh.open();
          } catch {
            delay = Math.min(delay * 2, RECONNECT_MAX_MS);
            continue;
          }
        }
        if (await spawnForward(localPort)) {
          restored = true;
          break;
        }
        // The old port may have been stolen while we were down: try a fresh one.
        const port = await findFreePort();
        if (await spawnForward(port)) {
          localPort = port;
          portCbs.forEach((cb) => cb(port));
          restored = true;
          break;
        }
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
        logger.warn(`tunnel to ${ssh.host} not back yet — retrying`);
      }
    } finally {
      if (grace !== null) clearTimeout(grace);
      reconnectActive = false;
    }
    if (stopping) {
      state.child?.kill('SIGTERM'); // close() may have missed a child adopted mid-loop
      return;
    }
    if (restored) {
      availabilityCbs.forEach((cb) => cb(true));
      lastRestoredAt = Date.now();
      if (announced) emit({ t: 'tunnel-up' });
    }
    scheduleHealthCheck();
  };

  const initialReady = await spawnForward(localPort);
  if (!initialReady) {
    stopping = true; // no Tunnel handle will exist — nothing may keep respawning
    throw new CliError(
      'ssh_unreachable',
      `could not open a tunnel to ${ssh.host}:${remotePort}`,
      'is the daemon running on the host? try: puddle status ' + ssh.host,
    );
  }
  scheduleHealthCheck();

  return {
    get localPort() {
      return localPort;
    },
    onEvent(cb) {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    onAvailability(cb) {
      availabilityCbs.add(cb);
      return () => availabilityCbs.delete(cb);
    },
    onPortChange(cb) {
      portCbs.add(cb);
      return () => portCbs.delete(cb);
    },
    close() {
      stopping = true;
      if (healthTimer !== null) {
        clearTimeout(healthTimer);
        healthTimer = null;
      }
      const child = state.child;
      state.child = null;
      child?.kill('SIGTERM');
      // Killing the client is enough for a non-mux forward; a mux server leaves
      // the -L on the master, so cancel it too (and that Promise is our close).
      return ssh.cancelForward(localPort, remotePort);
    },
  };
}

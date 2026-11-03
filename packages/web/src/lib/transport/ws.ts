import { toast } from 'sonner';
import type {
  AgentNotification,
  SessionStatus,
  WsClientMessage,
  WsServerMessage,
} from '@puddle/shared';
import { clearToken, tokenStore } from './auth';
import { browserTransport, type CockpitSocket } from './browser-transport';

/**
 * Singleton WebSocket manager. One socket carries every terminal and the
 * status feed; the first message after connect MUST be auth. On reconnect it
 * re-authenticates, re-attaches every registered terminal (the daemon replies
 * with a canonical screen/scrollback snapshot), and re-subscribes to status.
 */

export interface StatusEvent {
  session: string;
  status: SessionStatus;
  last_activity_at: string | null;
}

export interface RenameEvent {
  session: string;
  title: string | null;
  /** The agent's own name; present when the daemon also tracks it. */
  agent_title?: string | null;
  /** The terminal-title "sequence" name; present when the daemon also tracks it. */
  osc_title?: string | null;
}

/** An account's login state changed (protocol 15.1) — see the shared message. */
export interface AccountEvent {
  account_id: number;
  profile_id: string;
  logged_in: boolean;
}

export interface SessionSwitchEvent {
  source_session: string;
  target_session: string;
  target_project: string;
  cause: 'clear' | 'resume' | 'fork';
  outcome: 'rebound' | 'focused-existing';
}

export interface SessionsChangedEvent {
  project_ids: string[];
}

export interface TerminalHandlers {
  /** Called for both the initial replay chunk and live output. */
  onData(data: string, kind: 'replay' | 'output'): void;
  onExit?(code: number): void;
}

interface Registration {
  session: string;
  term: string;
  cols: number;
  rows: number;
  handlers: TerminalHandlers;
}

type ConnectionListener = (connected: boolean) => void;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

function key(session: string, term: string): string {
  return `${session} ${term}`;
}

export class WsManager {
  private ws: CockpitSocket | null = null;
  private open = false;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The resolved terminal colours to report (protocol 14.1) — the daemon
   * answers agents' OSC 10/11 colour queries from the last report, so
   * auto-theming agents match the app theme even though they query at spawn,
   * before any viewer attaches. Null until the shell learns the daemon speaks
   * 14.1 (ShellLayout wires it): a 14.0 daemon would reject the message.
   */
  private theme: { fg: string; bg: string } | null = null;
  private readonly terminals = new Map<string, Registration>();
  private readonly notificationListeners = new Set<(e: AgentNotification) => void>();
  private readonly statusListeners = new Set<(e: StatusEvent) => void>();
  private readonly renameListeners = new Set<(e: RenameEvent) => void>();
  private readonly accountListeners = new Set<(e: AccountEvent) => void>();
  private readonly switchListeners = new Set<(e: SessionSwitchEvent) => void>();
  private readonly sessionsChangedListeners = new Set<(e: SessionsChangedEvent) => void>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly shellWaiters = new Map<
    string,
    Array<{ resolve(term: string): void; reject(error: Error): void }>
  >();

  /** Registers a terminal and attaches it (now, or on the next connect). */
  attach(
    session: string,
    term: string,
    cols: number,
    rows: number,
    handlers: TerminalHandlers,
  ): () => void {
    const registration: Registration = { session, term, cols, rows, handlers };
    this.terminals.set(key(session, term), registration);
    this.ensureConnected();
    if (this.open) this.send({ t: 'attach', session, term, cols, rows });
    return () => this.detach(session, term);
  }

  detach(session: string, term: string): void {
    if (this.terminals.delete(key(session, term)) && this.open) {
      this.send({ t: 'detach', session, term });
    }
  }

  write(session: string, term: string, data: string): void {
    if (this.open) this.send({ t: 'stdin', session, term, data });
  }

  resize(session: string, term: string, cols: number, rows: number): void {
    const registration = this.terminals.get(key(session, term));
    if (registration) {
      registration.cols = cols;
      registration.rows = rows;
    }
    if (this.open) this.send({ t: 'resize', session, term, cols, rows });
  }

  spawnShell(session: string): Promise<string> {
    this.ensureConnected();
    if (!this.open) return Promise.reject(new Error('Connection is unavailable'));
    return new Promise((resolve, reject) => {
      const waiters = this.shellWaiters.get(session) ?? [];
      waiters.push({ resolve, reject });
      this.shellWaiters.set(session, waiters);
      if (this.open) this.send({ t: 'spawn-shell', session });
    });
  }

  /** Terminate a shell PTY; attached viewers learn through the `exit` event. */
  killShell(session: string, term: string): void {
    if (this.open) this.send({ t: 'kill-shell', session, term });
  }

  /** Status broadcasts for every session; also implies subscribe-status. */
  onStatus(listener: (e: StatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    this.ensureConnected();
    return () => this.statusListeners.delete(listener);
  }

  onAgentNotification(listener: (e: AgentNotification) => void): () => void {
    this.notificationListeners.add(listener);
    this.ensureConnected();
    return () => this.notificationListeners.delete(listener);
  }

  /** Rename broadcasts for every session (UI renames and agent self-naming). */
  onRenamed(listener: (e: RenameEvent) => void): () => void {
    this.renameListeners.add(listener);
    this.ensureConnected();
    return () => this.renameListeners.delete(listener);
  }

  /** Account login-state broadcasts (15.1) — how the accounts UI goes green live. */
  onAccount(listener: (e: AccountEvent) => void): () => void {
    this.accountListeners.add(listener);
    this.ensureConnected();
    return () => this.accountListeners.delete(listener);
  }

  onSessionSwitched(listener: (e: SessionSwitchEvent) => void): () => void {
    this.switchListeners.add(listener);
    this.ensureConnected();
    return () => this.switchListeners.delete(listener);
  }

  onSessionsChanged(listener: (e: SessionsChangedEvent) => void): () => void {
    this.sessionsChangedListeners.add(listener);
    this.ensureConnected();
    return () => this.sessionsChangedListeners.delete(listener);
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  isConnected(): boolean {
    return this.open;
  }

  /** Report the terminal colours (14.1) — now, and again on every reconnect. */
  reportTheme(fg: string, bg: string): void {
    if (this.theme && this.theme.fg === fg && this.theme.bg === bg) return;
    this.theme = { fg, bg };
    if (this.open) this.send({ t: 'theme', fg, bg });
  }

  /** Drops the socket (e.g. token change); registrations survive a reconnect. */
  reset(): void {
    this.ws?.close();
  }

  /** A different host must never inherit terminal registrations or uncertain writes. */
  switchHost(): void {
    const socket = this.ws;
    this.ws = null;
    this.open = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.terminals.clear();
    for (const waiters of this.shellWaiters.values())
      for (const waiter of waiters) waiter.reject(new Error('Host changed'));
    this.shellWaiters.clear();
    socket?.close();
    for (const listener of this.connectionListeners) listener(false);
  }

  private ensureConnected(): void {
    if (this.ws || this.reconnectTimer) return;
    this.connect();
  }

  private connect(): void {
    const token = tokenStore.get();
    const remote = browserTransport();
    if (!token && !remote) return; // the token gate is showing; nothing to do yet
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws: CockpitSocket = remote
      ? remote.socket()
      : new WebSocket(`${proto}://${window.location.host}/ws`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }
      if (!remote) ws.send(JSON.stringify({ t: 'auth', token }));
    });
    ws.addEventListener('message', (evt) => {
      if (this.ws !== ws) return;
      let message: WsServerMessage;
      try {
        message = JSON.parse(String(evt.data)) as WsServerMessage;
      } catch {
        return;
      }
      if (message.t === 'authenticated') {
        if (this.open) return;
        this.open = true;
        this.backoff = INITIAL_BACKOFF_MS;
        this.send({ t: 'subscribe-status' });
        if (this.theme) this.send({ t: 'theme', ...this.theme });
        for (const { session, term, cols, rows } of this.terminals.values())
          this.send({ t: 'attach', session, term, cols, rows });
        for (const listener of this.connectionListeners) listener(true);
      } else if (this.open) this.handle(message);
    });
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      const wasOpen = this.open;
      this.open = false;
      this.ws = null;
      for (const waiters of this.shellWaiters.values())
        for (const waiter of waiters)
          waiter.reject(new Error('Connection lost; operation outcome is unknown'));
      this.shellWaiters.clear();
      if (wasOpen) for (const listener of this.connectionListeners) listener(false);
      if (event.code === 4401 && event.reason === 'browser_rejected') {
        clearToken();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Nothing depends on the socket → let it stay down until something does.
    if (
      this.terminals.size === 0 &&
      this.statusListeners.size === 0 &&
      this.notificationListeners.size === 0 &&
      this.renameListeners.size === 0 &&
      this.accountListeners.size === 0 &&
      this.switchListeners.size === 0 &&
      this.sessionsChangedListeners.size === 0
    )
      return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private send(msg: WsClientMessage): void {
    if (this.open && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private handle(msg: WsServerMessage): void {
    switch (msg.t) {
      case 'agent-notification':
        for (const listener of this.notificationListeners) listener(msg);
        break;
      case 'replay':
      case 'output':
        this.terminals.get(key(msg.session, msg.term))?.handlers.onData(msg.data, msg.t);
        break;
      case 'exit':
        this.terminals.get(key(msg.session, msg.term))?.handlers.onExit?.(msg.code);
        break;
      case 'status':
        for (const listener of this.statusListeners) {
          listener({
            session: msg.session,
            status: msg.status,
            last_activity_at: msg.last_activity_at,
          });
        }
        break;
      case 'renamed':
        for (const listener of this.renameListeners) {
          listener({
            session: msg.session,
            title: msg.title,
            agent_title: msg.agent_title,
            osc_title: msg.osc_title,
          });
        }
        break;
      case 'account':
        for (const listener of this.accountListeners) {
          listener({
            account_id: msg.account_id,
            profile_id: msg.profile_id,
            logged_in: msg.logged_in,
          });
        }
        break;
      case 'session-switched':
        for (const listener of this.switchListeners) listener(msg);
        break;
      case 'sessions-changed':
        for (const listener of this.sessionsChangedListeners) listener(msg);
        break;
      case 'shell-spawned': {
        const waiters = this.shellWaiters.get(msg.session);
        const next = waiters?.shift();
        if (next) next.resolve(msg.term);
        break;
      }
      // Failures are never swallowed: the daemon raises these precisely
      // because the user needs to see them, and they arrive whichever tab is
      // open. `detail` is the process's own last output, shown verbatim.
      case 'notice':
        (msg.level === 'warning' ? toast.warning : toast.error)(msg.title, {
          ...(msg.detail !== undefined ? { description: msg.detail } : {}),
          duration: 12_000, // long enough to read an error and act on it
        });
        break;
      case 'error':
        toast.error('Connection error', { description: msg.message });
        break;
    }
  }
}

export const wsManager = new WsManager();

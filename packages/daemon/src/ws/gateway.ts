import type { ProfileAccess } from '../security/profile-access.js';
import type { AuthorityResource, LeaseRegistry } from '../security/leases.js';
import { homedir } from 'node:os';
import type { WSContext } from 'hono/ws';
import {
  HOME_STREAM,
  wsClientMessageSchema,
  type Account,
  type AgentNotification,
  type WsServerMessage,
} from '@puddle/shared';
import type { LogStore } from '../logs/log-store.js';
import type { PtyDataEvent, PtyExitEvent, PtyManager } from '../pty/pty-manager.js';
import { defaultShell } from '../pty/shell.js';
import type { TerminalTheme } from '../pty/terminal-theme.js';
import type {
  NoticeEvent,
  RenameEvent,
  SessionService,
  SessionSwitchEvent,
  StatusEvent,
} from '../sessions/service.js';
import type {
  ConversationCatalogue,
  SessionsChangedEvent,
} from '../sessions/conversation-catalogue.js';
import { ApiError } from '../http/errors.js';
import { stripDeviceReplies } from './device-replies.js';

export interface WsGatewayDeps {
  authority: LeaseRegistry;
  profileAccess?: ProfileAccess;
  ptys: PtyManager;
  logs: LogStore;
  service: SessionService;
  catalogue?: ConversationCatalogue;
  /** The last client-reported terminal colours (14.1) — see terminal-theme.ts. */
  theme: TerminalTheme;
}

interface WsEventHandlers {
  onMessage: (evt: { data: unknown }, ws: WSContext) => void;
  onClose: (evt: unknown, ws: WSContext) => void;
}

/**
 * A TUI may redraw far faster than a browser can paint (Codex has been
 * observed emitting more than 100 synchronised redraws per second). Coalesce
 * the tiny node-pty chunks into approximately one browser-frame message while
 * bounding how much output can wait in memory. The bytes and their order stay
 * exact; only the WebSocket envelope cadence changes.
 */
const OUTPUT_BATCH_MS = 16;
const OUTPUT_BATCH_MAX_CHARS = 64 * 1024;

interface PendingOutput {
  stream: string;
  term: string;
  chunks: string[];
  chars: number;
  timer: NodeJS.Timeout;
}

interface PendingAttach {
  messages: WsServerMessage[];
}

/**
 * WebSocket hub (SPEC §6). Any number of viewers may attach to the same
 * (stream, term); output/status/exit broadcast to all of them and stdin is
 * accepted from any (last-writer-wins, like tmux). Auth is the mandatory
 * first message — browsers cannot set WS headers.
 */
export class WsGateway {
  private readonly resources = new Map<WSContext, AuthorityResource>();
  private readonly viewers = new Map<string, Set<WSContext>>();
  private readonly statusSubs = new Set<WSContext>();
  private readonly pendingOutput = new Map<string, PendingOutput>();
  /** Live messages held until a new viewer has received its snapshot. */
  private readonly pendingAttaches = new Map<string, Map<WSContext, PendingAttach>>();
  /**
   * The one viewer per (stream, term) whose device-query answers reach the
   * PTY (see device-replies.ts): the most recent attacher/resizer — the same
   * viewer whose grid won the PTY size, so its cursor reports are the
   * authoritative ones. Other viewers' reply-shaped stdin is stripped; with
   * a single viewer nothing ever is.
   */
  private readonly responders = new Map<string, WSContext>();

  constructor(private readonly deps: WsGatewayDeps) {
    deps.ptys.on('data', (e: PtyDataEvent) => {
      this.queueOutput(e.stream, e.term, e.data);
    });
    deps.ptys.on('exit', (e: PtyExitEvent) => {
      this.flushOutput(this.key(e.stream, e.term));
      this.broadcast(this.key(e.stream, e.term), {
        t: 'exit',
        session: e.stream,
        term: e.term,
        code: e.exitCode,
      });
    });
    deps.service.on('agent-notification', (event: AgentNotification) => {
      for (const ws of this.statusSubs) this.send(ws, event);
    });
    deps.service.on('status', (e: StatusEvent) => {
      for (const ws of this.statusSubs) {
        this.send(ws, {
          t: 'status',
          session: e.session,
          status: e.status,
          last_activity_at: e.last_activity_at,
        });
      }
    });
    // Failures go to EVERY status subscriber, not just a client attached to the
    // stream — the user is usually looking at another tab when one happens.
    deps.service.on('notice', (e: NoticeEvent) => {
      for (const ws of this.statusSubs) {
        this.send(ws, {
          t: 'notice',
          level: e.level,
          title: e.title,
          ...(e.detail !== undefined ? { detail: e.detail } : {}),
          ...(e.session !== undefined ? { session: e.session } : {}),
          ...(e.term !== undefined ? { term: e.term } : {}),
        });
      }
    });
    deps.service.on('renamed', (e: RenameEvent) => {
      for (const ws of this.statusSubs) {
        this.send(ws, {
          t: 'renamed',
          session: e.session,
          title: e.title,
          agent_title: e.agent_title,
          osc_title: e.osc_title,
        });
      }
    });
    const sessionsChanged = (e: SessionsChangedEvent) => {
      for (const ws of this.statusSubs) {
        this.send(ws, { t: 'sessions-changed', project_ids: e.projectIds });
      }
    };
    deps.catalogue?.on('sessions-changed', sessionsChanged);
    deps.service.on('sessions-changed', sessionsChanged);
    deps.service.on('session-switched', (e: SessionSwitchEvent) => {
      for (const ws of this.statusSubs) {
        this.send(ws, {
          t: 'session-switched',
          source_session: e.sourceSession,
          target_session: e.targetSession,
          target_project: e.targetProject,
          cause: e.cause,
          outcome: e.outcome,
        });
      }
    });
  }

  /**
   * An account's login state changed (protocol 15.1) — to every status
   * subscriber, like notices: the settings dialog showing the badge is a
   * status subscriber wherever it is open, and login verification lands
   * asynchronously after the login PTY exits, when no request is in flight
   * to carry the answer back.
   */
  accountChanged(account: Account): void {
    for (const ws of this.statusSubs) {
      this.send(ws, {
        t: 'account',
        account_id: account.id,
        profile_id: account.profile_id,
        logged_in: account.logged_in,
      });
    }
  }

  /** Per-connection handler factory for upgradeWebSocket. */
  connection(): WsEventHandlers {
    let resource: AuthorityResource | null = null;
    const attached = new Set<string>();

    const onMessage = (evt: { data: unknown }, ws: WSContext): void => {
      const parsed = wsClientMessageSchema.safeParse(this.decode(evt.data));
      if (!parsed.success) {
        this.send(ws, { t: 'error', message: 'malformed message' });
        return;
      }
      const msg = parsed.data;
      if (msg.t === 'auth') {
        if (resource) {
          ws.close(4401, 'already authenticated');
          return;
        }
        resource = this.deps.authority.attach(msg.token, msg.resource ?? '', () =>
          ws.close(4401, 'upstream_expired'),
        );
        if (!resource) {
          ws.close(4401, 'upstream_expired');
          return;
        }
        this.resources.set(ws, resource);
        this.send(ws, { t: 'authenticated' });
        return;
      }
      if (!resource?.valid()) {
        ws.close(4401, 'upstream_expired');
        return;
      }
      try {
        if (
          resource.profile &&
          'session' in msg &&
          !this.deps.profileAccess?.session(resource.profile, msg.session)
        )
          throw new ApiError(
            403,
            'profile_scope',
            'This session is outside the registered profile',
          );
        switch (msg.t) {
          case 'attach': {
            this.assertStream(msg.session);
            const key = this.key(msg.session, msg.term);
            // The canonical terminal has already parsed output waiting in our
            // WS batch. Deliver that batch only to the OLD viewers first, or
            // this new viewer would receive it once in the snapshot and once
            // as live output.
            this.flushOutput(key);
            let set = this.viewers.get(key);
            if (!set) this.viewers.set(key, (set = new Set()));
            set.add(ws);
            attached.add(key);
            this.responders.set(key, ws);
            let pendingForKey = this.pendingAttaches.get(key);
            if (!pendingForKey) this.pendingAttaches.set(key, (pendingForKey = new Map()));
            // A duplicate attach supersedes the earlier snapshot attempt but
            // inherits any live messages already held behind its boundary.
            const pending: PendingAttach = {
              messages: pendingForKey.get(ws)?.messages ?? [],
            };
            pendingForKey.set(ws, pending);
            void this.finishAttach(
              key,
              msg.session,
              msg.term,
              msg.cols,
              msg.rows,
              ws,
              pending,
              attached,
            );
            break;
          }
          case 'stdin': {
            const responder = this.responders.get(this.key(msg.session, msg.term));
            const data =
              responder === undefined || responder === ws ? msg.data : stripDeviceReplies(msg.data);
            if (data !== '') this.deps.ptys.write(msg.session, msg.term, data);
            break;
          }
          case 'resize': {
            // The resize that wins the PTY size also wins the responder role:
            // this viewer's grid is now the one the PTY believes in.
            const key = this.key(msg.session, msg.term);
            if (this.viewers.get(key)?.has(ws)) this.responders.set(key, ws);
            this.deps.ptys.resize(msg.session, msg.term, msg.cols, msg.rows);
            break;
          }
          case 'detach': {
            const key = this.key(msg.session, msg.term);
            this.flushOutput(key);
            this.dropViewer(key, ws);
            attached.delete(key);
            break;
          }
          case 'spawn-shell': {
            const term =
              msg.session === HOME_STREAM
                ? this.spawnHomeShell()
                : this.deps.service.spawnShell(msg.session);
            this.send(ws, { t: 'shell-spawned', session: msg.session, term });
            break;
          }
          case 'kill-shell': {
            this.assertStream(msg.session);
            if (msg.term === 'agent') {
              throw ApiError.badRequest('agent_term', 'the agent PTY is killed via its session');
            }
            this.deps.service.expectExit(msg.session, msg.term); // asked for: no notice
            this.deps.ptys.kill(msg.session, msg.term);
            break;
          }
          case 'subscribe-status':
            this.statusSubs.add(ws);
            break;
          case 'theme':
            // Last report wins, like stdin — one person's cockpit in practice.
            this.deps.theme.set(msg.fg, msg.bg);
            break;
        }
      } catch (e) {
        const message = e instanceof ApiError ? e.message : 'internal error';
        this.send(ws, { t: 'error', message });
      }
    };

    const onClose = (_evt: unknown, ws: WSContext): void => {
      resource?.release();
      this.resources.delete(ws);
      for (const key of attached) this.dropViewer(key, ws);
      this.statusSubs.delete(ws);
    };

    return { onMessage, onClose };
  }

  /** Session uuids must exist; `login-<id>` and `home` streams attach like sessions (SPEC §6). */
  private assertStream(stream: string): void {
    if (stream === HOME_STREAM || /^login-[0-9]+$/.test(stream)) return;
    this.deps.service.get(stream); // throws 404 for unknown sessions
  }

  /**
   * The homescreen shell (SPEC §11): a plain shell in the daemon host's home
   * directory, on the project-less `home` stream. One at a time — while a
   * shell is live, spawn requests return its term instead of adding another.
   * Term numbering skips old log files so replay never mixes dead scrollback
   * into a fresh shell.
   */
  private spawnHomeShell(): string {
    const [live] = this.deps.ptys.liveTerms(HOME_STREAM);
    if (live) return live;
    const used = new Set(this.deps.logs.listTerms(HOME_STREAM));
    let n = 1;
    while (used.has(`shell-${n}`)) n++;
    const term = `shell-${n}`;
    this.deps.ptys.spawn(HOME_STREAM, term, defaultShell(), [], { cwd: homedir() });
    return term;
  }

  private decode(data: unknown): unknown {
    try {
      return JSON.parse(String(data));
    } catch {
      return null;
    }
  }

  private send(ws: WSContext, msg: WsServerMessage): void {
    const resource = this.resources.get(ws);
    if (ws.readyState !== 1 || !resource?.valid()) return;
    const allowed = resource.profile ? this.deps.profileAccess?.event(resource.profile, msg) : msg;
    if (allowed) ws.send(JSON.stringify(allowed));
  }

  /**
   * Removes a viewer and, crucially, the (stream, term) entry once its last
   * viewer is gone — a lingering empty Set would keep `broadcast` JSON-encoding
   * every output chunk of a stream nobody watches, forever.
   */
  private dropViewer(key: string, ws: WSContext): void {
    const pendingForKey = this.pendingAttaches.get(key);
    pendingForKey?.delete(ws);
    if (pendingForKey?.size === 0) this.pendingAttaches.delete(key);
    const set = this.viewers.get(key);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.viewers.delete(key);
      this.responders.delete(key);
      return;
    }
    // The answering viewer left: pass the role to the most recently attached
    // of the rest (Sets iterate in insertion order), so queries keep getting
    // exactly one answer.
    if (this.responders.get(key) === ws) {
      let last: WSContext | undefined;
      for (const viewer of set) last = viewer;
      if (last) this.responders.set(key, last);
    }
  }

  private broadcast(key: string, msg: WsServerMessage): void {
    const set = this.viewers.get(key);
    if (!set) return;
    const encoded = JSON.stringify(msg);
    for (const ws of set) {
      const resource = this.resources.get(ws);
      if (!resource?.valid()) continue;
      if (resource.profile && !this.deps.profileAccess?.event(resource.profile, msg)) continue;
      const pending = this.pendingAttaches.get(key)?.get(ws);
      if (pending) pending.messages.push(msg);
      else if (ws.readyState === 1) ws.send(encoded);
    }
  }

  /**
   * Establish an exact snapshot boundary for a new viewer. Output arriving
   * while the headless terminal serialises is held for this viewer only, then
   * delivered after replay so no bytes are missed or applied twice.
   */
  private async finishAttach(
    key: string,
    stream: string,
    term: string,
    cols: number,
    rows: number,
    ws: WSContext,
    pending: PendingAttach,
    attached: Set<string>,
  ): Promise<void> {
    try {
      const snapshot = await this.deps.ptys.snapshot(stream, term, cols, rows);
      if (this.pendingAttaches.get(key)?.get(ws) !== pending) return;
      if (!this.viewers.get(key)?.has(ws) || !this.resources.get(ws)?.valid()) return;
      this.send(ws, { t: 'replay', session: stream, term, data: snapshot });
      this.pendingAttaches.get(key)?.delete(ws);
      if (this.pendingAttaches.get(key)?.size === 0) this.pendingAttaches.delete(key);
      for (const message of pending.messages) this.send(ws, message);
      // A genuine PTY resize now asks a full-screen TUI for a fresh frame. It
      // occurs after the snapshot boundary and is therefore ordinary output.
      this.deps.ptys.resize(stream, term, cols, rows);
    } catch (error) {
      if (this.pendingAttaches.get(key)?.get(ws) !== pending) return;
      this.dropViewer(key, ws);
      attached.delete(key);
      console.error(`Could not attach terminal ${stream}/${term}:`, error);
      this.send(ws, { t: 'error', message: 'could not restore terminal' });
    }
  }

  private queueOutput(stream: string, term: string, data: string): void {
    const key = this.key(stream, term);
    // Do no batching or timer work for a PTY nobody is viewing.
    if (!this.viewers.has(key)) return;
    const pending = this.pendingOutput.get(key);
    if (pending) {
      pending.chunks.push(data);
      pending.chars += data.length;
      if (pending.chars >= OUTPUT_BATCH_MAX_CHARS) this.flushOutput(key);
      return;
    }
    const timer = setTimeout(() => this.flushOutput(key), OUTPUT_BATCH_MS);
    timer.unref?.();
    this.pendingOutput.set(key, { stream, term, chunks: [data], chars: data.length, timer });
    if (data.length >= OUTPUT_BATCH_MAX_CHARS) this.flushOutput(key);
  }

  private flushOutput(key: string): void {
    const pending = this.pendingOutput.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingOutput.delete(key);
    this.broadcast(key, {
      t: 'output',
      session: pending.stream,
      term: pending.term,
      data: pending.chunks.join(''),
    });
  }

  private key(stream: string, term: string): string {
    return `${stream} ${term}`;
  }
}

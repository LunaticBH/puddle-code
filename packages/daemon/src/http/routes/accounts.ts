import { existsSync, mkdirSync, statSync } from 'node:fs';
import { Hono } from 'hono';
import {
  createAccountRequestSchema,
  patchAccountRequestSchema,
  type AccountUsage,
  type LoginResponse,
} from '@puddle/shared';
import { assertBinaryAvailable } from '../../agents/binary.js';
import type { AdapterRegistry } from '../../agents/registry.js';
import type { ConversationShare } from '../../sessions/conversation-share.js';
import type { ConversationCatalogue } from '../../sessions/conversation-catalogue.js';
import type { AccountStore } from '../../db/stores/accounts.js';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { SessionStore } from '../../db/stores/sessions.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import type { RemovalStore } from '../../db/stores/removals.js';
import { isNativeAbsolute } from '../../host-path.js';
import { ApiError } from '../errors.js';
import { removeDirWithin } from '../fs-cleanup.js';
import { expandTilde } from '../tilde.js';
import type { PtyExitEvent, PtyManager } from '../../pty/pty-manager.js';
import type { PuddlePaths } from '../../paths.js';
import { idParam, parseBody } from '../validate.js';

export interface AccountRouteDeps {
  accounts: AccountStore;
  profiles: ProfileStore;
  sessions: SessionStore;
  removals: RemovalStore;
  adapters: AdapterRegistry;
  share: ConversationShare;
  catalogue: ConversationCatalogue;
  projects: ProjectStore;
  ptys: PtyManager;
  paths: PuddlePaths;
}

export function accountRoutes(deps: AccountRouteDeps): Hono {
  // A login PTY exiting cleanly marks the account logged in (SPEC §6) — but
  // verified against the adapter's own auth check where one exists: a
  // full-TUI login (Claude Code) also exits cleanly when the user quits
  // WITHOUT signing in, so the exit code alone would lie (2026-08-05).
  deps.ptys.on('exit', (e: PtyExitEvent) => {
    const match = /^login-([0-9]+)$/.exec(e.stream);
    if (!match || e.exitCode !== 0) return;
    let account;
    try {
      account = deps.accounts.get(Number(match[1]));
    } catch {
      return; // the account was deleted while its login PTY was open
    }
    const adapter = deps.adapters.get(account.agent_type);
    if (adapter.checkLoggedIn) {
      void adapter.checkLoggedIn(account).then(
        (ok) => deps.accounts.setLoggedIn(account.id, ok),
        () => {}, // an unanswerable check leaves the stored flag alone
      );
    } else {
      deps.accounts.setLoggedIn(account.id, true);
    }
  });

  return new Hono()
    .get('/', (c) => {
      const profile = c.req.query('profile');
      return c.json(deps.accounts.list(profile));
    })
    .post('/', async (c) => {
      const body = await parseBody(c, createAccountRequestSchema);
      const adapter = deps.adapters.get(body.agent_type); // 400 for unknown agent types
      const profile = deps.profiles.get(body.profile_id);
      // Always a fresh, puddle-owned directory — never a foreign dir in
      // place. Importing COPIES a pre-existing dir into it (SPEC §2).
      const configDir = deps.paths.accountConfigDir(profile.id, body.agent_type, body.label);
      if (body.import_dir !== undefined) {
        if (!adapter.importConfigDir) {
          throw ApiError.badRequest(
            'import_unsupported',
            `${adapter.displayName} accounts cannot be imported`,
          );
        }
        const source = expandTilde(body.import_dir);
        if (!isNativeAbsolute(source) || !existsSync(source) || !statSync(source).isDirectory()) {
          throw ApiError.badRequest(
            'import_dir_invalid',
            `'${body.import_dir}' is not a directory on this host`,
          );
        }
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        await adapter.importConfigDir(source, configDir);
      } else {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        adapter.prepareConfigDir?.(configDir);
      }
      let account;
      try {
        account = deps.accounts.create({
          profile_id: body.profile_id,
          agent_type: body.agent_type,
          label: body.label,
          config_dir: configDir,
          skip_permissions_default: body.skip_permissions_default ?? false,
        });
      } catch (e) {
        removeDirWithin(deps.paths.profilesDir, configDir); // no orphan copies on 409
        throw e;
      }
      if (body.import_dir !== undefined && adapter.checkLoggedIn) {
        // Imports carry files, not necessarily credentials (macOS keychain
        // binds them to the source path) — record the verified truth.
        const loggedIn = await adapter.checkLoggedIn(account);
        deps.accounts.setLoggedIn(account.id, loggedIn);
        account = deps.accounts.get(account.id);
      }
      // Link the profile's already-adopted conversations into this account (and
      // fold in any real conversation dir an imported config dir brought along)
      // so it can immediately resume them (Workstream S). Best-effort: the row
      // is already persisted, so a throw here must not 500 and strand a
      // half-created account (a retry would hit a duplicate-label 409). Backfill
      // is idempotent — the next boot's reconcile pass repairs any missed links.
      try {
        await deps.share.backfillAccount(account);
      } catch (e) {
        console.warn(`account ${account.id} conversation backfill failed: ${(e as Error).message}`);
      }
      deps.catalogue.reconcileWatchers();
      for (const project of deps.projects.list(account.profile_id)) {
        if (!project.archived) deps.catalogue.refreshProject(project.id);
      }
      return c.json(account, 201);
    })
    .patch('/:id', async (c) => {
      const id = idParam(c);
      const body = await parseBody(c, patchAccountRequestSchema);
      // A rename touches only the label; the config dir stays put (keychain).
      if (body.label !== undefined) deps.accounts.setLabel(id, body.label);
      if (body.skip_permissions_default !== undefined) {
        deps.accounts.setSkipPermissionsDefault(id, body.skip_permissions_default);
        // Opting an account in is the user's per-account confirmation (SPEC §11)
        // — the counterpart to opening the profile gate. Record the agent's skip
        // acceptance so the flag takes effect at launch (covers accounts added
        // after the gate was already open).
        if (body.skip_permissions_default === true) {
          const account = deps.accounts.get(id);
          try {
            deps.adapters.get(account.agent_type).acceptSkipPermissions?.(account);
          } catch {
            // A missing adapter or unwritable config dir must not fail the toggle.
          }
        }
      }
      return c.json(deps.accounts.get(id));
    })
    .delete('/:id', (c) => {
      const id = idParam(c);
      // 409 while any of its sessions is non-archived; cascade otherwise.
      const removed = deps.removals.deleteAccount(id);
      deps.ptys.killAll(`login-${id}`); // an in-flight login PTY dies with the account
      deps.ptys.forget(`login-${id}`); // …and the stream is retired: no size to keep
      removeDirWithin(deps.paths.profilesDir, removed.config_dir);
      deps.catalogue.reconcileWatchers();
      return c.body(null, 204);
    })
    .post('/:id/login', (c) => {
      const account = deps.accounts.get(idParam(c));
      const adapter = deps.adapters.get(account.agent_type);
      // Before the PTY: an absent CLI would otherwise spawn a terminal that dies
      // silently with no output, so the login dialog opens on nothing (SPEC §5).
      assertBinaryAvailable(adapter);
      const stream = `login-${account.id}`;
      if (!deps.ptys.has(stream, 'agent')) {
        // Not recorded: login output can carry secrets and needs no replay.
        deps.ptys.spawn(stream, 'agent', adapter.binary, adapter.loginArgs(), {
          cwd: deps.paths.home,
          env: adapter.env(account),
          record: false,
        });
      }
      return c.json<LoginResponse>({
        stream,
        term: 'agent',
        ...(adapter.loginHint !== undefined ? { hint: adapter.loginHint } : {}),
      });
    })
    .get('/:id/usage', async (c) => {
      const account = deps.accounts.get(idParam(c));
      const adapter = deps.adapters.get(account.agent_type);
      const counts = deps.sessions.usageForAccount(account.id);
      // Subscription windows come from the agent's own CLI (credential-free);
      // only a logged-in account can answer, and the adapter caches fetches.
      const windows =
        account.logged_in && adapter.subscriptionUsage
          ? await adapter.subscriptionUsage(account)
          : null;
      return c.json<AccountUsage>({
        account_id: account.id,
        logged_in: account.logged_in,
        session_count: counts.session_count,
        active_session_count: counts.active_session_count,
        last_activity_at: counts.last_activity_at,
        // Best-effort token totals from the agent's own history; null if it
        // keeps none (or has never run for this account).
        agent_usage: adapter.usageStats?.(account) ?? null,
        // Live per-session signal captured during runs (context fill, cost).
        live_usage: adapter.liveUsage?.(account) ?? null,
        subscription: windows ? { windows } : null,
      });
    });
}

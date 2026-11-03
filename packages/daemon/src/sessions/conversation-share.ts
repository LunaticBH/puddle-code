import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { isInsideHostPath, type Account } from '@puddle/shared';
import { sameHostPath } from '../host-path.js';
import type { AdapterRegistry } from '../agents/registry.js';
import type { ConversationShareHooks } from '../agents/adapter.js';
import type { AccountStore } from '../db/stores/accounts.js';
import type { EventStore } from '../db/stores/events.js';
import type { KeyedMutex } from '../git/mutex.js';
import type { PuddlePaths } from '../paths.js';

/** The subset of a session row the share manager needs. */
export interface ShareSession {
  id: string;
  /** Null for terminal sessions, which have no conversation to share. */
  agent_type: string | null;
  /** Null for terminal sessions, which have no account. */
  account_id: number | null;
  agent_session_ref: string | null;
}

export interface ConversationShareDeps {
  accounts: AccountStore;
  adapters: AdapterRegistry;
  paths: PuddlePaths;
  mutex: KeyedMutex;
  events: EventStore;
  /** Selects directory junctions and Windows sharing-violation handling; the host's by default. */
  platform?: NodeJS.Platform;
}

/**
 * Per-profile shared conversation store (Workstream S, SPEC §S). Adopts an
 * agent's per-conversation project dir into a canonical per-(profile, agent)
 * store the first time it appears on disk, then symlinks it back into EVERY
 * account of that profile so the same agent can resume the conversation under
 * a different account without moving files (tier-1 migration groundwork,
 * Task 18). Every filesystem mutation runs under `share:<profile>:<agent>` so
 * concurrent adopt/backfill/reconcile/archive passes never race on the tree.
 *
 * All public methods are idempotent and re-runnable.
 *
 * Windows links with directory junctions, which need no privilege, where a
 * directory symlink needs Developer Mode or elevation (docs/windows.md,
 * decision 12). An entry that cannot be linked keeps its own directory and
 * is never shared by copying; a store dir a live agent holds a file open in
 * is left in place and retried on a later pass.
 */
export class ConversationShare {
  constructor(private readonly deps: ConversationShareDeps) {}

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private hooksFor(agentType: string): ConversationShareHooks | null {
    let adapter;
    try {
      adapter = this.deps.adapters.get(agentType);
    } catch {
      return null; // unknown agent type — nothing to share
    }
    return adapter.conversationShare ?? null;
  }

  private key(agentType: string): string {
    return `share:${agentType}`;
  }

  /** Accounts of the same (profile, agent) as `account`, that account first. */
  private siblings(account: Account, agentType: string): Account[] {
    return this.deps.accounts.list(account.profile_id).filter((a) => a.agent_type === agentType);
  }

  /**
   * Adopt-after-first-write pass. Returns true once the conversation is adopted
   * (a symlink is in place) OR the agent is non-shareable — i.e. there is no
   * point retrying; false when nothing is on disk yet (retry on a later flip).
   */
  async adoptIfNeeded(session: ShareSession): Promise<boolean> {
    if (session.agent_type === null || session.account_id === null) return true; // terminal: no conversation
    const hooks = this.hooksFor(session.agent_type);
    if (!hooks) return true; // non-shareable agent: permanent no-op
    const ref = session.agent_session_ref;
    if (!ref) return true; // no ref will ever appear for this row
    const account = this.deps.accounts.get(session.account_id);
    const agentType = session.agent_type;

    return this.deps.mutex.run(`${this.key(agentType)}:${account.profile_id}`, async () => {
      const storeDir = hooks.locateStoreDir(ref, account);
      if (!storeDir) return false; // agent has not written the conversation yet
      if (isSymlink(storeDir)) return true; // adopted on an earlier pass

      const key = basename(storeDir);
      const canonical = join(
        this.deps.paths.profileSessionsDir(account.profile_id, agentType),
        key,
      );
      mkdirSync(dirname(canonical), { recursive: true });
      if (this.platform === 'win32') {
        const outcome = junctionInPlaceOf(storeDir, canonical);
        // Busy: retry on a later flip. Unlinkable: sharing stays off for it.
        if (outcome !== 'linked') return outcome === 'unlinkable';
      } else {
        if (existsSync(canonical)) {
          // Another account adopted this key first — fold this dir's files in.
          mergeDirInto(storeDir, canonical);
        } else {
          renameSync(storeDir, canonical);
        }
        symlinkSync(canonical, storeDir); // absolute target
      }

      // Mirror into every OTHER account of the profile.
      for (const sibling of this.siblings(account, agentType)) {
        if (sibling.id === account.id) continue;
        mirrorLink(hooks.storeParent(sibling), key, canonical, this.platform);
      }
      this.deps.events.record(session.id, 'conversation_adopted', { key });
      return true;
    });
  }

  /**
   * Link every existing canonical store key of the account's (profile, agent)
   * into the new account. Called after the config dir is prepared/imported; an
   * imported dir that already holds a real dir of the same key is merged in.
   */
  async backfillAccount(account: Account): Promise<void> {
    const hooks = this.hooksFor(account.agent_type);
    if (!hooks) return;
    const agentType = account.agent_type;
    await this.deps.mutex.run(`${this.key(agentType)}:${account.profile_id}`, async () => {
      const storeRoot = this.deps.paths.profileSessionsDir(account.profile_id, agentType);
      if (!existsSync(storeRoot)) return;
      for (const key of readdirSync(storeRoot)) {
        const canonical = join(storeRoot, key);
        if (!isDir(canonical)) continue;
        mirrorLink(hooks.storeParent(account), key, canonical, this.platform);
      }
    });
  }

  /**
   * Boot pass: for every share-capable account, ensure each canonical key is a
   * correct symlink and drop symlinks whose canonical dir has vanished.
   */
  async reconcile(): Promise<void> {
    // Group accounts by (profile, agent) so each group is one mutex section.
    const groups = new Map<string, { profileId: string; agentType: string; accounts: Account[] }>();
    for (const account of this.deps.accounts.list()) {
      if (!this.hooksFor(account.agent_type)) continue;
      const gk = `${account.profile_id}\0${account.agent_type}`;
      let group = groups.get(gk);
      if (!group) {
        group = { profileId: account.profile_id, agentType: account.agent_type, accounts: [] };
        groups.set(gk, group);
      }
      group.accounts.push(account);
    }
    for (const { profileId, agentType, accounts } of groups.values()) {
      const hooks = this.hooksFor(agentType)!;
      await this.deps.mutex.run(`${this.key(agentType)}:${profileId}`, async () => {
        const storeRoot = this.deps.paths.profileSessionsDir(profileId, agentType);
        const keys = existsSync(storeRoot)
          ? readdirSync(storeRoot).filter((k) => isDir(join(storeRoot, k)))
          : [];
        for (const account of accounts) {
          const parent = hooks.storeParent(account);
          // Repair or create a link for every live canonical key.
          for (const key of keys) mirrorLink(parent, key, join(storeRoot, key), this.platform);
          // Remove links whose canonical target is gone.
          if (!existsSync(parent)) continue;
          for (const entry of readdirSync(parent)) {
            const link = join(parent, entry);
            const stale = this.platform === 'win32' && STAGED_LINK.test(entry);
            if (isSymlink(link) && (stale || !existsSync(link))) rmSync(link, { force: true });
          }
        }
      });
    }
  }

  /**
   * Archive-time cleanup: delete this session's own files (its `inStore` JSONL
   * plus each account's `perAccount` ancillary files), and if the canonical
   * store dir is left empty, remove it and every account's symlink to it.
   * Conversations not yet adopted are handled too (files still under the
   * account's own dir).
   */
  async removeSessionData(session: ShareSession): Promise<void> {
    if (session.agent_type === null || session.account_id === null) return; // terminal: no conversation
    const hooks = this.hooksFor(session.agent_type);
    if (!hooks) return;
    const ref = session.agent_session_ref;
    if (!ref) return;
    const account = this.deps.accounts.get(session.account_id);
    const agentType = session.agent_type;
    await this.deps.mutex.run(`${this.key(agentType)}:${account.profile_id}`, async () => {
      const siblings = this.siblings(account, agentType);
      // Resolve the real store dir holding this ref: the account's link (which
      // realpath resolves to the canonical dir), else a scan of the canonical
      // root (covers a repaired-away link), else nothing.
      const located = hooks.locateStoreDir(ref, account);
      const storeRoot = this.deps.paths.profileSessionsDir(account.profile_id, agentType);
      const target = located
        ? realpathSync(located)
        : scanStoreRoot(hooks, ref, account, storeRoot);
      if (!target) return;

      // Delete the shared JSONL once, and each account's ancillary files.
      for (const path of hooks.sessionFiles(ref, target, account).inStore) {
        rmSync(path, { force: true });
      }
      for (const sibling of siblings) {
        for (const path of hooks.sessionFiles(ref, target, sibling).perAccount) {
          rmSync(path, { force: true });
        }
      }

      // If the store dir is now empty, drop it and any symlinks pointing at it.
      if (isDir(target) && readdirSync(target).length === 0) {
        // `target` is realpath'd (e.g. /private/var on macOS), so compare
        // against the realpath'd store root before removing the mirror links.
        const realStoreRoot = existsSync(storeRoot) ? realpathSync(storeRoot) : storeRoot;
        const adopted =
          this.platform === 'win32'
            ? isInsideHostPath(realStoreRoot, target) &&
              !sameHostPath(realStoreRoot, target, this.platform)
            : target.startsWith(realStoreRoot + sep);
        rmSync(target, { recursive: true, force: true });
        if (adopted) {
          const key = basename(target);
          for (const sibling of siblings) {
            const link = join(hooks.storeParent(sibling), key);
            if (isSymlink(link)) rmSync(link, { force: true });
          }
        }
      }
    });
  }
}

/** True if `path` is a symlink (not the thing it points at). */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True if `path` is a real directory (following symlinks). */
function isDir(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(realpathSync(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Move every entry of `src` into `dst` (keeping the canonical file on a name
 * collision — conversation refs are uuids, so a collision is the same file),
 * then remove the emptied `src`.
 */
function mergeDirInto(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (existsSync(to)) {
      rmSync(from, { recursive: true, force: true }); // keep canonical
    } else {
      renameSync(from, to);
    }
  }
  rmSync(src, { recursive: true, force: true });
}

/**
 * Ensure `<parent>/<key>` is an absolute symlink to `canonical`: create it if
 * absent, repoint a wrong symlink, or merge a real dir's files into canonical
 * and replace it with the link. Windows makes junctions, and an entry that
 * cannot be linked or is in use keeps its own dir.
 */
function mirrorLink(
  parent: string,
  key: string,
  canonical: string,
  platform: NodeJS.Platform,
): void {
  const link = join(parent, key);
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    stat = null;
  }
  if (!stat) {
    mkdirSync(parent, { recursive: true });
    if (platform === 'win32') createJunction(canonical, link);
    else symlinkSync(canonical, link);
    return;
  }
  if (stat.isSymbolicLink()) {
    let points: string | null;
    try {
      points = realpathSync(link);
    } catch {
      points = null; // dangling
    }
    const correct =
      points !== null &&
      (platform === 'win32' ? sameHostPath(points, canonical, platform) : points === canonical);
    if (!correct) {
      rmSync(link, { force: true });
      if (platform === 'win32') createJunction(canonical, link);
      else symlinkSync(canonical, link);
    }
    return;
  }
  // A real dir of the same key (e.g. an imported account) — fold it in.
  if (platform === 'win32') {
    junctionInPlaceOf(link, canonical);
    return;
  }
  mergeDirInto(link, canonical);
  symlinkSync(canonical, link);
}

// --- Windows -----------------------------------------------------------------

/** A junction staged beside its final name; one left behind by a crash is removed at boot. */
const STAGED_LINK = /^\..+\.puddle-link-[0-9a-f]{8}$/;

/** Sharing violations: a file in the tree is open without FILE_SHARE_DELETE, or the tree is in use. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Store dirs already reported busy, so a retry on every status flip logs once. */
const reportedBusy = new Set<string>();

type JunctionOutcome = 'linked' | 'busy' | 'unlinkable';

/** A junction at `link` to `canonical`; false, with the reason logged, when none can be made. */
function createJunction(canonical: string, link: string): boolean {
  try {
    symlinkSync(canonical, link, 'junction');
    return true;
  } catch (error) {
    console.warn(
      `conversation sharing is off for ${link}: cannot create a junction (${errorCode(error)})`,
    );
    return false;
  }
}

/**
 * Replaces the real store dir `dir` with a junction to `canonical`, moving its
 * entries there. The junction is created first under a staging name, so a
 * volume that cannot hold one leaves `dir` untouched. A file a live agent
 * holds open fails the move: whatever had moved goes back, and the caller
 * retries later. Nothing is ever copied.
 */
function junctionInPlaceOf(dir: string, canonical: string): JunctionOutcome {
  const staged = join(
    dirname(dir),
    `.${basename(dir)}.puddle-link-${randomBytes(4).toString('hex')}`,
  );
  if (!createJunction(canonical, staged)) return 'unlinkable';
  let undo: () => void;
  try {
    undo = moveStoreDir(dir, canonical);
  } catch (error) {
    rmSync(staged, { force: true });
    if (!BUSY.has(errorCode(error))) throw error;
    if (!reportedBusy.has(dir)) {
      reportedBusy.add(dir);
      console.warn(
        `conversation store ${dir} is in use (${errorCode(error)}); adoption will retry`,
      );
    }
    return 'busy';
  }
  try {
    renameSync(staged, dir);
  } catch (error) {
    undo();
    rmSync(staged, { force: true });
    if (!BUSY.has(errorCode(error))) throw error;
    return 'busy';
  }
  reportedBusy.delete(dir);
  return 'linked';
}

/**
 * Moves `dir` to `canonical` whole, or merges its entries into an existing
 * one (keeping canonical's copy of a duplicate), and returns how to put the
 * moved entries back. Any failure restores what had moved before rethrowing.
 */
function moveStoreDir(dir: string, canonical: string): () => void {
  if (!existsSync(canonical)) {
    renameSync(dir, canonical);
    return () => renameSync(canonical, dir);
  }
  const moved: string[] = [];
  const undo = () => {
    mkdirSync(dir, { recursive: true });
    for (const name of moved.reverse()) renameSync(join(canonical, name), join(dir, name));
  };
  try {
    for (const name of readdirSync(dir)) {
      if (existsSync(join(canonical, name))) continue; // a duplicate, removed with `dir`
      renameSync(join(dir, name), join(canonical, name));
      moved.push(name);
    }
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    undo();
    throw error;
  }
  return undo;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? String(error);
}

/** Find the canonical store dir under `storeRoot` that holds `ref`, or null. */
function scanStoreRoot(
  hooks: ConversationShareHooks,
  ref: string,
  account: Account,
  storeRoot: string,
): string | null {
  if (!existsSync(storeRoot)) return null;
  for (const key of readdirSync(storeRoot)) {
    const dir = join(storeRoot, key);
    if (!isDir(dir)) continue;
    if (hooks.sessionFiles(ref, dir, account).inStore.some((p) => existsSync(p))) return dir;
  }
  return null;
}

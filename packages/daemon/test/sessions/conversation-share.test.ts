import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Account } from '@puddle/shared';
import { describe, expect, it } from 'vitest';
import type { ShareSession } from '../../src/sessions/conversation-share.js';
import { removeDirWithin } from '../../src/http/fs-cleanup.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';

/** Path is a symlink (regardless of whether its target exists). */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The link/dir entry exists on disk (does not follow the link). */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Hand-craft a conversation store dir + a per-account todo file. */
function writeConv(configDir: string, key: string, ref: string): void {
  const dir = join(configDir, 'projects', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ref}.jsonl`), '{"cwd":"/x"}\n');
  mkdirSync(join(configDir, 'todos'), { recursive: true });
  writeFileSync(join(configDir, 'todos', `${ref}.json`), '[]');
}

/** A second/third account in the fixture's profile for the fake agent. */
function addAccount(f: Fixture, label: string): Account {
  const dir = f.paths.accountConfigDir(f.ids.profile, 'fake', label);
  mkdirSync(dir, { recursive: true });
  return f.stores.accounts.create({
    profile_id: f.ids.profile,
    agent_type: 'fake',
    label,
    config_dir: dir,
    skip_permissions_default: false,
  });
}

/** A real (FK-satisfying) session row, returned as the share manager sees it. */
function makeSession(f: Fixture, accountId: number, ref: string): ShareSession {
  const id = randomUUID();
  f.stores.sessions.create({
    id,
    project_id: f.ids.project,
    account_id: accountId,
    worktree_path: '/tmp/wt',
    base_branch: 'main',
    branch: `b-${id}`,
    separate_branch: true,
    kind: 'agent',
    agent_type: 'fake',
    title: null,
    skip_permissions: false,
  });
  f.stores.sessions.setAgentSessionRef(id, ref);
  return { id, agent_type: 'fake', account_id: accountId, agent_session_ref: ref };
}

function storeRootOf(f: Fixture): string {
  return f.paths.profileSessionsDir(f.ids.profile, 'fake');
}

function cfg(f: Fixture, accountId: number): string {
  return f.stores.accounts.get(accountId).config_dir;
}

describe('ConversationShare adoption (live agent)', () => {
  it('moves the conversation dir into the canonical store, symlinks it back, and live writes land in the canonical file', async () => {
    const f = fixture({ share: true });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'adopt',
    });
    const ref = session.agent_session_ref!;
    const storeRoot = storeRootOf(f);
    // Auto-adoption fires on the first waiting_input flip.
    await waitFor(() => existsSync(storeRoot) && readdirSync(storeRoot).length > 0);
    const key = readdirSync(storeRoot)[0];
    const canonical = join(storeRoot, key);
    const jsonl = join(canonical, `${ref}.jsonl`);
    await waitFor(() => isSymlink(join(cfg(f, f.ids.account), 'projects', key)));
    expect(existsSync(jsonl)).toBe(true);
    expect(f.stores.events.list(session.id).map((e) => e.type)).toContain('conversation_adopted');

    // A continued write by the live agent grows the CANONICAL file (moved inode).
    const before = readFileSync(jsonl, 'utf8').length;
    f.ptys.write(session.id, 'agent', 'GROW-LINE\n');
    await waitFor(() => readFileSync(jsonl, 'utf8').includes('GROW-LINE'));
    expect(readFileSync(jsonl, 'utf8').length).toBeGreaterThan(before);
    await f.service.kill(session.id);
  });
});

describe('ConversationShare manager', () => {
  it('mirrors the adopted conversation into every other account of the profile', async () => {
    const f = fixture({ share: true });
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    const done = await f.share.adoptIfNeeded(makeSession(f, a.id, 'refA'));
    expect(done).toBe(true);

    const canonical = join(storeRootOf(f), 'k1');
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(true);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
    expect(isSymlink(join(b.config_dir, 'projects', 'k1'))).toBe(true);
    expect(f.adapters.get('fake').hasConversation!('refA', b)).toBe(true);
  });

  it('merges without loss when two accounts hold real dirs of the same key', async () => {
    const f = fixture({ share: true });
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    writeConv(b.config_dir, 'k1', 'refB');
    await f.share.adoptIfNeeded(makeSession(f, a.id, 'refA'));
    // B's real dir is folded into canonical during A's adoption; adopting B again is a no-op.
    await f.share.adoptIfNeeded(makeSession(f, b.id, 'refB'));

    const canonical = join(storeRootOf(f), 'k1');
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(true);
    expect(existsSync(join(canonical, 'refB.jsonl'))).toBe(true);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
    expect(isSymlink(join(b.config_dir, 'projects', 'k1'))).toBe(true);
  });

  it('backfills a new account with existing canonical keys, folding in an imported real dir', async () => {
    const f = fixture({ share: true });
    const a = f.stores.accounts.get(f.ids.account);
    writeConv(a.config_dir, 'k1', 'refA');
    await f.share.adoptIfNeeded(makeSession(f, a.id, 'refA'));
    const canonical = join(storeRootOf(f), 'k1');

    // Plain new account → gets a symlink.
    const c = addAccount(f, 'third');
    await f.share.backfillAccount(c);
    expect(isSymlink(join(c.config_dir, 'projects', 'k1'))).toBe(true);
    expect(f.adapters.get('fake').hasConversation!('refA', c)).toBe(true);

    // Imported account already holding a real dir of the same key → merged in.
    const d = addAccount(f, 'imported');
    writeConv(d.config_dir, 'k1', 'refD');
    await f.share.backfillAccount(d);
    expect(isSymlink(join(d.config_dir, 'projects', 'k1'))).toBe(true);
    expect(existsSync(join(canonical, 'refD.jsonl'))).toBe(true);
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(true);
  });

  it('reconcile repairs a deleted symlink and removes links whose canonical dir vanished', async () => {
    const f = fixture({ share: true });
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    await f.share.adoptIfNeeded(makeSession(f, a.id, 'refA'));
    const storeRoot = storeRootOf(f);

    // A deleted mirror link is recreated.
    rmSync(join(b.config_dir, 'projects', 'k1'), { force: true });
    await f.share.reconcile();
    expect(isSymlink(join(b.config_dir, 'projects', 'k1'))).toBe(true);

    // Canonical dir gone → both links are dangling → removed.
    rmSync(join(storeRoot, 'k1'), { recursive: true, force: true });
    await f.share.reconcile();
    expect(lexists(join(a.config_dir, 'projects', 'k1'))).toBe(false);
    expect(lexists(join(b.config_dir, 'projects', 'k1'))).toBe(false);
  });

  it('removeSessionData deletes exactly the session files and drops the dir only when empty', async () => {
    const f = fixture({ share: true });
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    const sA = makeSession(f, a.id, 'refA');
    await f.share.adoptIfNeeded(sA);
    const canonical = join(storeRootOf(f), 'k1');

    // A second conversation shares the same store key.
    writeFileSync(join(canonical, 'refB.jsonl'), '{"cwd":"/x"}\n');
    writeFileSync(join(a.config_dir, 'todos', 'refB.json'), '[]');
    const sB = makeSession(f, a.id, 'refB');

    // Archiving A removes only refA's files; the dir + links survive.
    await f.share.removeSessionData(sA);
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(false);
    expect(existsSync(join(a.config_dir, 'todos', 'refA.json'))).toBe(false);
    expect(existsSync(join(canonical, 'refB.jsonl'))).toBe(true);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
    expect(isSymlink(join(b.config_dir, 'projects', 'k1'))).toBe(true);

    // Archiving B empties the dir → dir and every account's link go.
    await f.share.removeSessionData(sB);
    expect(existsSync(canonical)).toBe(false);
    expect(lexists(join(a.config_dir, 'projects', 'k1'))).toBe(false);
    expect(lexists(join(b.config_dir, 'projects', 'k1'))).toBe(false);
  });

  it('deleting an account leaves the canonical store intact and resolvable by its sibling', async () => {
    const f = fixture({ share: true });
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    const sA = makeSession(f, a.id, 'refA');
    await f.share.adoptIfNeeded(sA);
    const canonical = join(storeRootOf(f), 'k1');

    // Account deletion requires archived sessions, then removes its config dir.
    f.stores.sessions.setStatus(sA.id, 'archived');
    const removed = f.stores.removals.deleteAccount(a.id);
    removeDirWithin(f.paths.profilesDir, removed.config_dir);

    // The rm -rf of A's config dir unlinks its symlink but never follows it.
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(true);
    expect(f.adapters.get('fake').hasConversation!('refA', b)).toBe(true);
  });

  it('adoptIfNeeded is idempotent — a second call records no new event and keeps the symlink', async () => {
    const f = fixture({ share: true });
    const a = f.stores.accounts.get(f.ids.account);
    writeConv(a.config_dir, 'k1', 'refA');
    const sA = makeSession(f, a.id, 'refA');
    await f.share.adoptIfNeeded(sA);
    const adoptEvents = () =>
      f.stores.events.list(sA.id).filter((e) => e.type === 'conversation_adopted').length;
    expect(adoptEvents()).toBe(1);

    expect(await f.share.adoptIfNeeded(sA)).toBe(true);
    expect(adoptEvents()).toBe(1);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
  });
});

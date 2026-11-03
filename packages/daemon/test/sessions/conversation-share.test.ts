import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Account } from '@puddle/shared';
import { describe, expect, it, vi } from 'vitest';
import { KeyedMutex } from '../../src/git/mutex.js';
import { ConversationShare, type ShareSession } from '../../src/sessions/conversation-share.js';
import { removeDirWithin } from '../../src/http/fs-cleanup.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';
import { nodeFakeAdapter } from '../agents/node-fake-agent.js';

/** The share-capable fake agent, run by Node so the live paths work on every OS. */
function shareFixture(): Fixture {
  return fixture({ adapter: nodeFakeAdapter({ share: true }) });
}

/** Path is a symlink or, on Windows, a junction (regardless of whether its target exists). */
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

/** The fixture's manager, or one forced onto the Windows junction paths. */
function managerFor(f: Fixture, platform: 'native' | 'win32'): ConversationShare {
  if (platform === 'native') return f.share;
  return new ConversationShare({
    accounts: f.stores.accounts,
    adapters: f.adapters,
    paths: f.paths,
    mutex: new KeyedMutex(),
    events: f.stores.events,
    platform: 'win32',
  });
}

// Windows runs the junction paths natively; elsewhere they run on symlinks too.
const PLATFORMS =
  process.platform === 'win32' ? (['native'] as const) : (['native', 'win32'] as const);

describe('ConversationShare adoption (live agent)', () => {
  it('moves the conversation dir into the canonical store, symlinks it back, and live writes land in the canonical file', async () => {
    const f = shareFixture();
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

describe.each(PLATFORMS)('ConversationShare manager (%s)', (platform) => {
  const share = (f: Fixture) => managerFor(f, platform);
  it('mirrors the adopted conversation into every other account of the profile', async () => {
    const f = shareFixture();
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    const done = await share(f).adoptIfNeeded(makeSession(f, a.id, 'refA'));
    expect(done).toBe(true);

    const canonical = join(storeRootOf(f), 'k1');
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(true);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
    expect(isSymlink(join(b.config_dir, 'projects', 'k1'))).toBe(true);
    expect(f.adapters.get('fake').hasConversation!('refA', b)).toBe(true);
  });

  it('merges without loss when two accounts hold real dirs of the same key', async () => {
    const f = shareFixture();
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    writeConv(b.config_dir, 'k1', 'refB');
    await share(f).adoptIfNeeded(makeSession(f, a.id, 'refA'));
    // B's real dir is folded into canonical during A's adoption; adopting B again is a no-op.
    await share(f).adoptIfNeeded(makeSession(f, b.id, 'refB'));

    const canonical = join(storeRootOf(f), 'k1');
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(true);
    expect(existsSync(join(canonical, 'refB.jsonl'))).toBe(true);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
    expect(isSymlink(join(b.config_dir, 'projects', 'k1'))).toBe(true);
  });

  it('backfills a new account with existing canonical keys, folding in an imported real dir', async () => {
    const f = shareFixture();
    const a = f.stores.accounts.get(f.ids.account);
    writeConv(a.config_dir, 'k1', 'refA');
    await share(f).adoptIfNeeded(makeSession(f, a.id, 'refA'));
    const canonical = join(storeRootOf(f), 'k1');

    // Plain new account → gets a symlink.
    const c = addAccount(f, 'third');
    await share(f).backfillAccount(c);
    expect(isSymlink(join(c.config_dir, 'projects', 'k1'))).toBe(true);
    expect(f.adapters.get('fake').hasConversation!('refA', c)).toBe(true);

    // Imported account already holding a real dir of the same key → merged in.
    const d = addAccount(f, 'imported');
    writeConv(d.config_dir, 'k1', 'refD');
    await share(f).backfillAccount(d);
    expect(isSymlink(join(d.config_dir, 'projects', 'k1'))).toBe(true);
    expect(existsSync(join(canonical, 'refD.jsonl'))).toBe(true);
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(true);
  });

  it('reconcile repairs a deleted symlink and removes links whose canonical dir vanished', async () => {
    const f = shareFixture();
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    await share(f).adoptIfNeeded(makeSession(f, a.id, 'refA'));
    const storeRoot = storeRootOf(f);

    // A deleted mirror link is recreated.
    rmSync(join(b.config_dir, 'projects', 'k1'), { force: true });
    await share(f).reconcile();
    expect(isSymlink(join(b.config_dir, 'projects', 'k1'))).toBe(true);

    // Canonical dir gone → both links are dangling → removed.
    rmSync(join(storeRoot, 'k1'), { recursive: true, force: true });
    await share(f).reconcile();
    expect(lexists(join(a.config_dir, 'projects', 'k1'))).toBe(false);
    expect(lexists(join(b.config_dir, 'projects', 'k1'))).toBe(false);
  });

  it('removeSessionData deletes exactly the session files and drops the dir only when empty', async () => {
    const f = shareFixture();
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    const sA = makeSession(f, a.id, 'refA');
    await share(f).adoptIfNeeded(sA);
    const canonical = join(storeRootOf(f), 'k1');

    // A second conversation shares the same store key.
    writeFileSync(join(canonical, 'refB.jsonl'), '{"cwd":"/x"}\n');
    writeFileSync(join(a.config_dir, 'todos', 'refB.json'), '[]');
    const sB = makeSession(f, a.id, 'refB');

    // Archiving A removes only refA's files; the dir + links survive.
    await share(f).removeSessionData(sA);
    expect(existsSync(join(canonical, 'refA.jsonl'))).toBe(false);
    expect(existsSync(join(a.config_dir, 'todos', 'refA.json'))).toBe(false);
    expect(existsSync(join(canonical, 'refB.jsonl'))).toBe(true);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
    expect(isSymlink(join(b.config_dir, 'projects', 'k1'))).toBe(true);

    // Archiving B empties the dir → dir and every account's link go.
    await share(f).removeSessionData(sB);
    expect(existsSync(canonical)).toBe(false);
    expect(lexists(join(a.config_dir, 'projects', 'k1'))).toBe(false);
    expect(lexists(join(b.config_dir, 'projects', 'k1'))).toBe(false);
  });

  it('deleting an account leaves the canonical store intact and resolvable by its sibling', async () => {
    const f = shareFixture();
    const a = f.stores.accounts.get(f.ids.account);
    const b = addAccount(f, 'work');
    writeConv(a.config_dir, 'k1', 'refA');
    const sA = makeSession(f, a.id, 'refA');
    await share(f).adoptIfNeeded(sA);
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
    const f = shareFixture();
    const a = f.stores.accounts.get(f.ids.account);
    writeConv(a.config_dir, 'k1', 'refA');
    const sA = makeSession(f, a.id, 'refA');
    await share(f).adoptIfNeeded(sA);
    const adoptEvents = () =>
      f.stores.events.list(sA.id).filter((e) => e.type === 'conversation_adopted').length;
    expect(adoptEvents()).toBe(1);

    expect(await share(f).adoptIfNeeded(sA)).toBe(true);
    expect(adoptEvents()).toBe(1);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
  });
});

describe('ConversationShare on Windows', () => {
  it('removes a staged junction a crash left behind', async () => {
    const f = shareFixture();
    const manager = managerFor(f, 'win32');
    const a = f.stores.accounts.get(f.ids.account);
    writeConv(a.config_dir, 'k1', 'refA');
    await manager.adoptIfNeeded(makeSession(f, a.id, 'refA'));
    const staged = join(a.config_dir, 'projects', '.k1.puddle-link-0123abcd');
    symlinkSync(join(storeRootOf(f), 'k1'), staged, 'junction');
    await manager.reconcile();
    expect(lexists(staged)).toBe(false);
    expect(isSymlink(join(a.config_dir, 'projects', 'k1'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'leaves a store dir a live agent holds open in place and adopts it once released',
    async () => {
      const f = shareFixture();
      const a = f.stores.accounts.get(f.ids.account);
      writeConv(a.config_dir, 'k1', 'refA');
      const session = makeSession(f, a.id, 'refA');
      const projects = join(a.config_dir, 'projects');
      const held = openSync(join(projects, 'k1', 'refA.jsonl'), 'a');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await f.share.adoptIfNeeded(session)).toBe(false);
        expect(isSymlink(join(projects, 'k1'))).toBe(false);
        expect(readdirSync(projects)).toEqual(['k1']); // no staged junction left behind
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('is in use'));
      } finally {
        closeSync(held);
        warn.mockRestore();
      }
      expect(await f.share.adoptIfNeeded(session)).toBe(true);
      expect(isSymlink(join(projects, 'k1'))).toBe(true);
      expect(existsSync(join(storeRootOf(f), 'k1', 'refA.jsonl'))).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps sharing off, without moving anything, where no link can be made',
    async () => {
      // A read-only parent stands in for a volume that cannot hold a junction.
      const f = shareFixture();
      const manager = managerFor(f, 'win32');
      const a = f.stores.accounts.get(f.ids.account);
      writeConv(a.config_dir, 'k1', 'refA');
      const projects = join(a.config_dir, 'projects');
      chmodSync(projects, 0o555);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await manager.adoptIfNeeded(makeSession(f, a.id, 'refA'))).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot create a junction'));
      } finally {
        chmodSync(projects, 0o755);
        warn.mockRestore();
      }
      expect(isSymlink(join(projects, 'k1'))).toBe(false);
      expect(existsSync(join(projects, 'k1', 'refA.jsonl'))).toBe(true);
      expect(existsSync(join(storeRootOf(f), 'k1'))).toBe(false);
    },
  );
});

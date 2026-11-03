import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@puddle/shared';
import { codex } from '../../src/agents/codex/index.js';
import { codexAppServerSpawnOptions, codexRemoteArgs } from '../../src/agents/codex/lifecycle.js';
import { newestRolloutFor, renderRollout } from '../../src/agents/codex/rollout.js';
import { StatusDetector } from '../../src/pty/status-detector.js';

function account(configDir: string): Account {
  return {
    id: 1,
    profile_id: 'p',
    agent_type: 'codex',
    label: 'personal',
    config_dir: configDir,
    logged_in: true,
    skip_permissions_default: false,
    created_at: new Date().toISOString(),
  } as Account;
}

/** Writes a rollout in codex's real layout: sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl */
function writeRollout(
  configDir: string,
  id: string,
  cwd: string,
  records: unknown[] = [],
  day = '01',
  opts: { timestamp?: string; parentThreadId?: string } = {},
): string {
  const dir = join(configDir, 'sessions', '2026', '07', day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-${day}T10-00-00-${id}.jsonl`);
  const timestamp = opts.timestamp ?? `2026-07-${day}T10:00:00.000Z`;
  const meta = {
    timestamp: `2026-07-${day}T10:00:00.000Z`,
    type: 'session_meta',
    payload: {
      id,
      timestamp,
      cwd,
      cli_version: '0.147.0',
      ...(opts.parentThreadId === undefined
        ? { thread_source: 'user' }
        : { thread_source: 'subagent', parent_thread_id: opts.parentThreadId }),
    },
  };
  writeFileSync(path, [meta, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

const UUID_A = '019b746c-0713-7b11-a6b7-a812f20db547';
const UUID_B = '019b64f3-f981-74a3-9606-132bdae0f80c';

it('reads a bounded exact Codex reply without exposing tools, reasoning or another conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-codex-preview-'));
  writeRollout(dir, UUID_A, '/project', [
    {
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Old output. '.repeat(30_000) },
    },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Fix notification routing' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        channel: 'final',
        content: [
          { type: 'output_text', text: 'Notifications now open the correct conversation.' },
        ],
      },
    },
    { type: 'response_item', payload: { type: 'reasoning', text: 'Private reasoning' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  writeRollout(dir, UUID_B, '/project', [
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Other conversation' } },
  ]);
  await newestRolloutFor(dir, '/project'); // Populate the adapter's metadata-only path cache.
  expect(await codex.notificationOutput!(UUID_A, account(dir))).toBe(
    'Notifications now open the correct conversation.',
  );
  expect(await codex.notificationOutput!('missing', account(dir))).toBeNull();
});

describe('codex adapter — args', () => {
  const opts = { worktreePath: '/wt', sessionId: 's1', skipPermissions: false };
  afterEach(() => vi.unstubAllEnvs());

  it('isolates state and enables terminal clipboard forwarding without inherited SSH state', () => {
    vi.stubEnv('SSH_TTY', undefined);
    vi.stubEnv('SSH_CONNECTION', undefined);
    expect(codex.env(account('/cfg'))).toEqual({ CODEX_HOME: '/cfg', SSH_TTY: '' });
    // The compatibility marker belongs to the TUI, not the app-server which
    // executes agent tools. Do not modify the daemon's process environment.
    expect(process.env['SSH_TTY']).toBeUndefined();
    expect(codexAppServerSpawnOptions({ account: account('/cfg'), opts }).env).not.toHaveProperty(
      'SSH_TTY',
    );
  });

  it('preserves a real inherited SSH tty', () => {
    vi.stubEnv('SSH_TTY', '/dev/pts/7');
    expect(codex.env(account('/cfg'))['SSH_TTY']).toBe('/dev/pts/7');
  });

  it('launches bare, and only adds the bypass flag when skipping', () => {
    expect(codex.launchArgs(opts)).toEqual([]);
    expect(codex.launchArgs({ ...opts, skipPermissions: true })).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    // Verified 0.146.0: --yolo does NOT exist, only the long form.
    expect(codex.launchArgs({ ...opts, skipPermissions: true })).not.toContain('--yolo');
  });

  it('passes the initial prompt as a positional', () => {
    expect(codex.launchArgs({ ...opts, prompt: 'do the thing' })).toEqual(['do the thing']);
  });

  it('resumes as `codex resume <id>`, flags before the positionals', () => {
    expect(codex.resumeArgs(UUID_A, opts)).toEqual(['resume', UUID_A]);
    expect(
      codex.resumeArgs(UUID_A, { ...opts, skipPermissions: true, prompt: 'carry on' }),
    ).toEqual(['resume', '--dangerously-bypass-approvals-and-sandbox', UUID_A, 'carry on']);
  });

  it('logs in with `codex login`', () => {
    // Bare TUI: `codex login` renders nothing in a PTY (browser + localhost
    // callback on the daemon host), so login runs the first-run sign-in screen.
    expect(codex.loginArgs()).toEqual([]);
  });

  it('cannot preset its session id', () => {
    expect(codex.capabilities.presetSessionId).toBe(false);
  });

  it('starts the lifecycle app-server in the agent worktree', () => {
    const spawn = codexAppServerSpawnOptions({ account: account('/cfg'), opts });
    expect(spawn.cwd).toBe('/wt');
    expect(spawn.env?.['CODEX_HOME']).toBe('/cfg');
  });

  it('pins the remote TUI to the agent worktree before launch or resume args', () => {
    expect(codexRemoteArgs('ws://bridge', { opts, args: [] })).toEqual([
      '--remote',
      'ws://bridge',
      '-C',
      '/wt',
    ]);
    expect(
      codexRemoteArgs('ws://bridge', {
        opts,
        args: ['resume', UUID_A],
      }),
    ).toEqual(['--remote', 'ws://bridge', '-C', '/wt', 'resume', UUID_A]);
  });
});

describe('codex adapter — status', () => {
  it('recognises the live 0.146.0 composer as waiting for input', () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const detector = new StatusDetector(
      codex.statusPatterns,
      { onStatus: (status) => statuses.push(status) },
      2000,
    );

    detector.feed('Working (4s • esc to interrupt)');
    expect(statuses).toEqual(['running']);
    detector.feed('› Explain this codebasegpt-5.6-sol default fast · ~/src/puddle');
    vi.advanceTimersByTime(2100);
    expect(statuses).toEqual(['running', 'waiting_input']);

    detector.dispose();
    vi.useRealTimers();
  });
});

describe('codex adapter — rollout discovery', () => {
  it('finds the newest rollout recorded against the worktree', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt', [], '01');
    writeRollout(cfg, UUID_B, '/other', [], '02');
    expect((await newestRolloutFor(cfg, '/wt'))?.id).toBe(UUID_A);
    expect((await newestRolloutFor(cfg, '/other'))?.id).toBe(UUID_B);
    expect(await newestRolloutFor(cfg, '/nope')).toBeUndefined();
  });

  it('ignores newer sub-agent rollouts in the same worktree', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt', [], '01');
    writeRollout(cfg, UUID_B, '/wt', [], '02', { parentThreadId: UUID_A });
    expect((await newestRolloutFor(cfg, '/wt'))?.id).toBe(UUID_A);
    expect(await codex.hasConversation?.(UUID_B, account(cfg))).toBe(false);
  });

  it('captures only the rollout created after launch when the cwd has history', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt');
    const excluded = await codex.existingSessionRefs?.('/wt', account(cfg));
    setTimeout(() => writeRollout(cfg, UUID_B, '/wt', [], '02'), 20);

    await expect(
      codex.resolveSessionRef(
        { worktreePath: '/wt', sessionId: 'puddle-id', skipPermissions: false },
        account(cfg),
        excluded,
      ),
    ).resolves.toBe(UUID_B);
  });

  it('uses Codex’s state index before rollout metadata is readable', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    const db = new Database(join(cfg, 'state_5.sqlite'));
    db.exec(`
      create table threads (
        id text primary key,
        cwd text not null,
        created_at integer not null,
        created_at_ms integer,
        rollout_path text not null,
        thread_source text,
        source text not null
      )
    `);
    const insert = db.prepare(
      `insert into threads
       (id, cwd, created_at, created_at_ms, rollout_path, thread_source, source)
       values (?, '/wt', ?, ?, ?, ?, ?)`,
    );
    const oldAt = Date.parse('2026-07-01T10:00:05.000Z');
    insert.run(UUID_A, oldAt / 1000, oldAt, '/not-readable-yet-a', 'user', 'cli');
    const excluded = await codex.existingSessionRefs?.('/wt', account(cfg));
    const newAt = Date.parse('2026-07-01T10:01:05.000Z');
    insert.run(UUID_B, newAt / 1000, newAt, '/not-readable-yet-b', 'user', 'cli');
    insert.run(
      '019b5a74-f981-74a3-9606-132bdae0f80c',
      newAt / 1000,
      newAt,
      '/child',
      'subagent',
      '{"subagent":{}}',
    );
    db.close();

    await expect(
      codex.resolveSessionRef(
        { worktreePath: '/wt', sessionId: 'puddle-id', skipPermissions: false },
        account(cfg),
        excluded,
      ),
    ).resolves.toBe(UUID_B);
  });

  it('catalogues top-level state rows with native titles and fork parentage', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    const firstPath = writeRollout(cfg, UUID_A, '/wt');
    const secondPath = writeRollout(cfg, UUID_B, '/wt', [], '02', { parentThreadId: UUID_A });
    const db = new Database(join(cfg, 'state_5.sqlite'));
    db.exec(`create table threads (
      id text primary key, cwd text, created_at integer, created_at_ms integer,
      rollout_path text, name text, title text, thread_source text, source text
    )`);
    const insert = db.prepare(
      `insert into threads values (?, '/wt', 1, ?, ?, ?, ?, 'user', 'cli')`,
    );
    insert.run(UUID_A, 1_000, firstPath, 'first', null);
    insert.run(UUID_B, 2_000, secondPath, null, 'fork title');
    db.close();
    const rows = await codex.conversationDiscovery?.discover(account(cfg));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: UUID_A, title: 'first', parentRef: null }),
        expect.objectContaining({ ref: UUID_B, title: 'fork title', parentRef: UUID_A }),
      ]),
    );
  });

  it('catalogues a top-level rollout omitted from an available state index', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/daemon/home', [], '01');
    writeRollout(cfg, UUID_B, '/daemon/home', [], '02', { parentThreadId: UUID_A });
    const db = new Database(join(cfg, 'state_5.sqlite'));
    db.exec(`create table threads (
      id text primary key, cwd text, created_at integer, created_at_ms integer,
      rollout_path text, name text, title text, thread_source text, source text
    )`);
    db.close();

    const rows = await codex.conversationDiscovery?.discover(account(cfg));
    expect(rows?.map((row) => row.ref)).toEqual([UUID_A]);
  });

  it('recovers the rollout born with the puddle session, not the newest cwd match', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt', [], '01', { timestamp: '2026-07-01T10:00:05.000Z' });
    writeRollout(cfg, UUID_B, '/wt', [], '02', { timestamp: '2026-07-02T10:00:05.000Z' });
    const context = {
      sessionId: 'puddle-id',
      worktreePath: '/wt',
      createdAt: '2026-07-01T10:00:00.000Z',
    };
    expect(await codex.discoverSessionRef?.('/wt', account(cfg), context)).toBe(UUID_A);
    expect(await codex.sessionRefMatches?.(UUID_A, context, account(cfg))).toBe(true);
    expect(await codex.sessionRefMatches?.(UUID_B, context, account(cfg))).toBe(false);
  });

  it('matches a catalogue placement against the native creation time', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt', [], '01', { timestamp: '2026-07-01T10:00:05.000Z' });
    const context = {
      sessionId: 'catalogue-placement',
      worktreePath: '/wt',
      createdAt: '2026-07-03T10:00:00.000Z',
      nativeCreatedAt: '2026-07-01T10:00:05.000Z',
    };
    expect(await codex.sessionRefMatches?.(UUID_A, context, account(cfg))).toBe(true);
    expect(await codex.discoverSessionRef?.('/wt', account(cfg), context)).toBe(UUID_A);
  });

  it('recovers a unique top-level ref recorded under the daemon cwd by the old bridge', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/daemon/home', [], '01', {
      timestamp: '2026-07-01T10:00:05.000Z',
    });
    writeRollout(cfg, UUID_B, '/daemon/home', [], '02', {
      timestamp: '2026-07-01T10:00:05.500Z',
      parentThreadId: UUID_A,
    });
    const context = {
      sessionId: 'puddle-id',
      worktreePath: '/wt',
      createdAt: '2026-07-01T10:00:00.000Z',
    };
    expect(await codex.discoverSessionRef?.('/wt', account(cfg), context)).toBe(UUID_A);
    expect(await codex.sessionRefMatches?.(UUID_A, context, account(cfg))).toBe(true);
  });

  it('recovers a wrong-cwd rollout omitted from Codex’s current state index', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/daemon/home', [], '01', {
      timestamp: '2026-07-01T10:00:05.000Z',
    });
    const db = new Database(join(cfg, 'state_5.sqlite'));
    db.exec(`create table threads (
      id text primary key, cwd text, created_at integer, created_at_ms integer,
      rollout_path text, thread_source text, source text
    )`);
    db.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?)').run(
      UUID_B,
      '/other',
      Date.parse('2026-07-02T10:00:00.000Z') / 1000,
      Date.parse('2026-07-02T10:00:00.000Z'),
      '/other-rollout',
      'user',
      'cli',
    );
    db.close();

    const context = {
      sessionId: 'puddle-id',
      worktreePath: '/wt',
      createdAt: '2026-07-01T10:00:00.000Z',
    };
    expect(await codex.discoverSessionRef?.('/wt', account(cfg), context)).toBe(UUID_A);
    expect(await codex.sessionRefMatches?.(UUID_A, context, account(cfg))).toBe(true);
  });

  it('refuses an ambiguous creation-time recovery', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt', [], '01', { timestamp: '2026-07-01T10:00:05.000Z' });
    writeRollout(cfg, UUID_B, '/wt', [], '02', { timestamp: '2026-07-01T10:00:10.000Z' });
    expect(
      await codex.discoverSessionRef?.('/wt', account(cfg), {
        sessionId: 'puddle-id',
        worktreePath: '/wt',
        createdAt: '2026-07-01T10:00:00.000Z',
      }),
    ).toBeNull();
    expect(
      await codex.sessionRefMatches?.(
        UUID_A,
        {
          sessionId: 'puddle-id',
          worktreePath: '/another-worktree',
          createdAt: '2026-07-01T10:00:00.000Z',
        },
        account(cfg),
      ),
    ).toBe(false);
  });

  it('reports a conversation by id, and misses an unknown one', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt');
    expect(await codex.hasConversation?.(UUID_A, account(cfg))).toBe(true);
    expect(await codex.hasConversation?.(UUID_B, account(cfg))).toBe(false);
  });

  it('falls back to the puddle session id when no rollout appears', async () => {
    // Keep fs/setImmediate real: only accelerate the adapter's polling delay.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
      const pending = codex.resolveSessionRef(
        { worktreePath: '/wt', sessionId: 'puddle-id', skipPermissions: false },
        account(cfg),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(10_100);
      const ref = await pending;
      // Deliberate: hasConversation reports it missing, so resume re-discovers.
      expect(ref).toBe('puddle-id');
      expect(await codex.hasConversation?.('puddle-id', account(cfg))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a missing or malformed sessions tree', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    expect(await newestRolloutFor(cfg, '/wt')).toBeUndefined();
    const dir = join(cfg, 'sessions', '2026', '07', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-x-${UUID_A}.jsonl`), 'not json\n');
    expect(await newestRolloutFor(cfg, '/wt')).toBeUndefined();
  });

  it('yields the daemon event loop while indexing a large imported history', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    for (let day = 1; day <= 24; day++) {
      writeRollout(
        cfg,
        `019b746c-0713-7b11-a6b7-a812f20d${String(day).padStart(4, '0')}`,
        day === 24 ? '/wt' : '/other',
        [{ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(256_000) } }],
        String(day).padStart(2, '0'),
      );
    }
    let eventLoopTurn = false;
    const turn = new Promise<void>((resolve) =>
      setImmediate(() => {
        eventLoopTurn = true;
        resolve();
      }),
    );
    const pending = codex.existingSessionRefs?.('/wt', account(cfg));
    expect(pending).toBeInstanceOf(Promise);
    await turn;
    expect(eventLoopTurn).toBe(true);
    expect((await pending)?.size).toBe(1);
  });
});

describe('codex adapter — transcript export', () => {
  it('renders the user/agent pair and collapses tool calls', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    const path = writeRollout(cfg, UUID_A, '/wt', [
      { type: 'event_msg', payload: { type: 'user_message', message: 'add a test' } },
      { type: 'response_item', payload: { type: 'function_call' } },
      { type: 'response_item', payload: { type: 'custom_tool_call' } },
      { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'private thinking' } },
      { type: 'response_item', payload: { type: 'reasoning' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
    ]);
    const text = await renderRollout(path);
    expect(text).toContain('## User\n\nadd a test');
    expect(text).toContain('## Assistant\n\ndone');
    expect(text).toContain('_(ran 2 tool calls)_');
    // Tier 2 is degraded by design: the agent's private reasoning never travels.
    expect(text).not.toContain('private thinking');
  });

  it('exports through the adapter hook, and empty for an unknown ref', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt', [
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
    ]);
    expect(await codex.exportTranscript?.(UUID_A, account(cfg), '/wt')).toContain('hello');
    expect(await codex.exportTranscript?.(UUID_B, account(cfg), '/wt')).toBe('');
  });
});

describe('codex adapter — session title', () => {
  /** A minimal stand-in for codex's own `state_<n>.sqlite` thread index. */
  function writeStateDb(
    configDir: string,
    version: number,
    rows: Array<[string, string | null, string | null]>,
  ) {
    const db = new Database(join(configDir, `state_${version}.sqlite`));
    db.exec('create table threads (id text primary key, name text, title text)');
    const insert = db.prepare('insert into threads (id, name, title) values (?, ?, ?)');
    for (const [id, name, title] of rows) insert.run(id, name, title);
    db.close();
  }

  it('prefers the thread NAME — the thing a rename sets', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeStateDb(cfg, 5, [[UUID_A, 'auth refactor', 'some long opening message']]);
    expect(codex.sessionTitle?.(UUID_A, account(cfg))).toBe('auth refactor');
  });

  it('falls back to the opening message, cut to one ≤80-char line', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    // Codex stores the first user message verbatim and untruncated here.
    const opening = `===== Chat history ====\n\nPrompt:\n${'x'.repeat(200)}`;
    writeStateDb(cfg, 5, [[UUID_A, '', opening]]);
    const title = codex.sessionTitle?.(UUID_A, account(cfg));
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(80);
    expect(title).not.toContain('\n');
    expect(title!.startsWith('===== Chat history ==== Prompt:')).toBe(true);
  });

  it('reads the highest schema version present', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeStateDb(cfg, 5, [[UUID_A, 'old schema', null]]);
    writeStateDb(cfg, 12, [[UUID_A, 'new schema', null]]);
    expect(codex.sessionTitle?.(UUID_A, account(cfg))).toBe('new schema');
  });

  it('returns null rather than throwing when the index is absent or unusable', () => {
    const bare = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    expect(codex.sessionTitle?.(UUID_A, account(bare))).toBeNull();

    // An unknown thread, and a file whose schema has drifted out from under us.
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeStateDb(cfg, 5, [[UUID_A, 'known', null]]);
    expect(codex.sessionTitle?.(UUID_B, account(cfg))).toBeNull();

    const drifted = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    const db = new Database(join(drifted, 'state_9.sqlite'));
    db.exec('create table something_else (x text)');
    db.close();
    expect(codex.sessionTitle?.(UUID_A, account(drifted))).toBeNull();
  });
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account } from '@puddle/shared';
import { geminiCli } from '../../src/agents/gemini-cli/index.js';
import { opencode } from '../../src/agents/opencode/index.js';

function account(configDir: string, agentType: string): Account {
  return {
    id: 1,
    profile_id: 'p',
    agent_type: agentType,
    label: 'personal',
    config_dir: configDir,
    logged_in: true,
    skip_permissions_default: false,
    created_at: new Date().toISOString(),
  } as Account;
}

const OPTS = { worktreePath: '/wt', sessionId: 'puddle-uuid', skipPermissions: false };

describe('opencode adapter', () => {
  it('isolates every XDG root, since auth.json lives under the DATA root', () => {
    // Verified against opencode 1.18.10 `debug paths`: OPENCODE_CONFIG_DIR
    // relocates nothing, so all four XDG roots must be redirected.
    const env = opencode.env(account('/cfg', 'opencode'));
    expect(env).toEqual({
      XDG_CONFIG_HOME: '/cfg/config',
      XDG_DATA_HOME: '/cfg/data',
      XDG_CACHE_HOME: '/cfg/cache',
      XDG_STATE_HOME: '/cfg/state',
    });
    expect(env['OPENCODE_CONFIG_DIR']).toBeUndefined();
  });

  it('creates the XDG roots when preparing a fresh config dir', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    opencode.prepareConfigDir?.(cfg);
    for (const sub of ['config', 'data', 'cache', 'state']) {
      expect(() => mkdirSync(join(cfg, sub), { recursive: false })).toThrow(); // already exists
    }
    const plugin = readFileSync(
      join(cfg, 'config', 'opencode', 'plugins', 'puddle-sync.js'),
      'utf8',
    );
    expect(plugin).toContain("event?.type === 'session.created'");
    expect(plugin).toContain('info.parentID');
  });

  it('skips permissions with --auto and seeds the prompt with --prompt', () => {
    expect(opencode.launchArgs(OPTS)).toEqual([]);
    expect(opencode.launchArgs({ ...OPTS, skipPermissions: true, prompt: 'go' })).toEqual([
      '--auto',
      '--prompt',
      'go',
    ]);
    // SPEC §5 used to claim opencode could not flag permissions; --auto exists.
    expect(opencode.capabilities.skipPermissions).toBe(true);
  });

  it('resumes with --session <ses_id>', () => {
    expect(opencode.resumeArgs('ses_abc', OPTS)).toEqual(['--session', 'ses_abc']);
    expect(opencode.loginArgs()).toEqual(['auth', 'login']);
  });

  it('discovers the newest session recorded against the worktree', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    const store = join(cfg, 'data', 'opencode', 'storage', 'session', 'proj');
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, 'ses_old.json'),
      JSON.stringify({ id: 'ses_old', directory: '/wt', time: { updated: 100 } }),
    );
    writeFileSync(
      join(store, 'ses_new.json'),
      JSON.stringify({ id: 'ses_new', directory: '/wt', time: { updated: 200 } }),
    );
    writeFileSync(
      join(store, 'ses_other.json'),
      JSON.stringify({ id: 'ses_other', directory: '/elsewhere', time: { updated: 300 } }),
    );
    writeFileSync(
      join(store, 'ses_child.json'),
      JSON.stringify({
        id: 'ses_child',
        directory: '/wt',
        title: 'child',
        parentID: 'ses_new',
        time: { updated: 400 },
      }),
    );
    expect(await opencode.discoverSessionRef?.('/wt', account(cfg, 'opencode'))).toBe('ses_new');
    expect(await opencode.discoverSessionRef?.('/nope', account(cfg, 'opencode'))).toBeNull();
    const catalogue = await opencode.conversationDiscovery?.discover(account(cfg, 'opencode'));
    expect(catalogue?.map((row) => row.ref)).not.toContain('ses_child');
  });

  it('captures only a newly minted session when the cwd already has history', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    const store = join(cfg, 'data', 'opencode', 'storage', 'session', 'proj');
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, 'ses_old.json'),
      JSON.stringify({ id: 'ses_old', directory: '/wt', time: { created: 100, updated: 100 } }),
    );
    const excluded = await opencode.existingSessionRefs?.('/wt', account(cfg, 'opencode'));
    setTimeout(
      () =>
        writeFileSync(
          join(store, 'ses_new.json'),
          JSON.stringify({
            id: 'ses_new',
            directory: '/wt',
            time: { created: 200, updated: 200 },
          }),
        ),
      20,
    );

    await expect(
      opencode.resolveSessionRef(OPTS, account(cfg, 'opencode'), excluded),
    ).resolves.toBe('ses_new');
  });

  it('recovers by creation time and validates a stored ref', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    const store = join(cfg, 'data', 'opencode', 'storage', 'session', 'proj');
    mkdirSync(store, { recursive: true });
    const firstCreated = Date.parse('2026-07-01T10:00:05.000Z');
    const secondCreated = Date.parse('2026-07-02T10:00:05.000Z');
    writeFileSync(
      join(store, 'ses_first.json'),
      JSON.stringify({
        id: 'ses_first',
        directory: '/wt',
        time: { created: firstCreated, updated: firstCreated },
      }),
    );
    writeFileSync(
      join(store, 'ses_second.json'),
      JSON.stringify({
        id: 'ses_second',
        directory: '/wt',
        time: { created: secondCreated, updated: secondCreated },
      }),
    );
    const context = {
      sessionId: 'puddle-id',
      worktreePath: '/wt',
      createdAt: '2026-07-01T10:00:00.000Z',
    };
    expect(await opencode.discoverSessionRef?.('/wt', account(cfg, 'opencode'), context)).toBe(
      'ses_first',
    );
    expect(await opencode.sessionRefMatches?.('ses_first', context, account(cfg, 'opencode'))).toBe(
      true,
    );
    expect(
      await opencode.sessionRefMatches?.('ses_second', context, account(cfg, 'opencode')),
    ).toBe(false);
    expect(await opencode.hasConversation?.('ses_first', account(cfg, 'opencode'))).toBe(true);
  });

  it('matches a catalogue placement against the native creation time', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    const store = join(cfg, 'data', 'opencode', 'storage', 'session', 'proj');
    mkdirSync(store, { recursive: true });
    const nativeCreatedAt = '2026-07-01T10:00:05.000Z';
    writeFileSync(
      join(store, 'ses_catalogued.json'),
      JSON.stringify({
        id: 'ses_catalogued',
        directory: '/wt',
        time: {
          created: Date.parse(nativeCreatedAt),
          updated: Date.parse(nativeCreatedAt),
        },
      }),
    );
    const context = {
      sessionId: 'catalogue-placement',
      worktreePath: '/wt',
      createdAt: '2026-07-03T10:00:00.000Z',
      nativeCreatedAt,
    };
    expect(
      await opencode.sessionRefMatches?.('ses_catalogued', context, account(cfg, 'opencode')),
    ).toBe(true);
    expect(await opencode.discoverSessionRef?.('/wt', account(cfg, 'opencode'), context)).toBe(
      'ses_catalogued',
    );
  });

  it('refuses an ambiguous creation-time recovery', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    const store = join(cfg, 'data', 'opencode', 'storage', 'session', 'proj');
    mkdirSync(store, { recursive: true });
    const createdAt = Date.parse('2026-07-01T10:00:00.000Z');
    for (const [id, offset] of [
      ['ses_first', 5_000],
      ['ses_second', 10_000],
    ] as const) {
      writeFileSync(
        join(store, `${id}.json`),
        JSON.stringify({
          id,
          directory: '/wt',
          time: { created: createdAt + offset, updated: createdAt + offset },
        }),
      );
    }
    expect(
      await opencode.discoverSessionRef?.('/wt', account(cfg, 'opencode'), {
        sessionId: 'puddle-id',
        worktreePath: '/wt',
        createdAt: '2026-07-01T10:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('returns null rather than guessing when the store is absent', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    expect(await opencode.discoverSessionRef?.('/wt', account(cfg, 'opencode'))).toBeNull();
  });

  it('yields the daemon event loop while indexing a large imported history', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    const store = join(cfg, 'data', 'opencode', 'storage', 'session', 'proj');
    mkdirSync(store, { recursive: true });
    for (let i = 0; i < 200; i++) {
      writeFileSync(
        join(store, `ses_${i}.json`),
        JSON.stringify({
          id: `ses_${i}`,
          directory: i === 199 ? '/wt' : '/other',
          time: { created: i, updated: i },
        }),
      );
    }
    let eventLoopTurn = false;
    const turn = new Promise<void>((resolve) =>
      setImmediate(() => {
        eventLoopTurn = true;
        resolve();
      }),
    );
    const pending = opencode.existingSessionRefs?.('/wt', account(cfg, 'opencode'));
    expect(pending).toBeInstanceOf(Promise);
    await turn;
    expect(eventLoopTurn).toBe(true);
    expect(await pending).toEqual(new Set(['ses_199']));
  });
});

describe('gemini-cli adapter', () => {
  it('installs additive native lifecycle hooks in the isolated Gemini home', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'gm-cfg-'));
    geminiCli.prepareConfigDir?.(cfg);
    const settings = JSON.parse(readFileSync(join(cfg, '.gemini', 'settings.json'), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'AfterAgent',
      'BeforeAgent',
      'SessionEnd',
      'SessionStart',
    ]);
    expect(readFileSync(join(cfg, '.gemini', 'puddle-signal.mjs'), 'utf8')).toContain(
      'PUDDLE_AGENT_SIGNAL_NONCE',
    );
  });

  it('isolates via GEMINI_CLI_HOME, never GEMINI_CONFIG_DIR', () => {
    // Verified 0.53.1: GEMINI_CONFIG_DIR is ignored and the CLI falls back to
    // the real ~/.gemini, which would breach SPEC §2.
    const env = geminiCli.env(account('/cfg', 'gemini-cli'));
    expect(env).toEqual({ GEMINI_CLI_HOME: '/cfg' });
    expect(env['GEMINI_CONFIG_DIR']).toBeUndefined();
  });

  it('presets the session id and stays interactive when seeding a prompt', () => {
    expect(geminiCli.launchArgs(OPTS)).toEqual(['--session-id', 'puddle-uuid']);
    // -p/--prompt is headless and would exit immediately; -i keeps the TUI.
    const withPrompt = geminiCli.launchArgs({ ...OPTS, prompt: 'go' });
    expect(withPrompt).toContain('--prompt-interactive');
    expect(withPrompt).not.toContain('--prompt');
    expect(geminiCli.capabilities.presetSessionId).toBe(true);
  });

  it('skips permissions with the explicit approval mode', () => {
    expect(geminiCli.launchArgs({ ...OPTS, skipPermissions: true })).toEqual([
      '--session-id',
      'puddle-uuid',
      '--approval-mode',
      'yolo',
    ]);
  });

  it('resumes by ref and logs in via a bare launch (it has no auth subcommand)', () => {
    expect(geminiCli.resumeArgs('abc-123', OPTS)).toEqual(['--resume', 'abc-123']);
    expect(geminiCli.loginArgs()).toEqual([]);
  });

  it('echoes the preset id as the session ref', async () => {
    expect(await geminiCli.resolveSessionRef(OPTS, account('/cfg', 'gemini-cli'))).toBe(
      'puddle-uuid',
    );
  });

  it('detects login from the credentials file, since there is no status command', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'gm-cfg-'));
    const dir = join(cfg, '.gemini');
    mkdirSync(dir, { recursive: true });
    expect(await geminiCli.checkLoggedIn?.(account(cfg, 'gemini-cli'))).toBe(false);
    writeFileSync(join(dir, 'oauth_creds.json'), '{}');
    expect(await geminiCli.checkLoggedIn?.(account(cfg, 'gemini-cli'))).toBe(true);
  });

  it('resolves and catalogues chats through the CLI’s own projects.json map', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'gm-cfg-'));
    const dir = join(cfg, '.gemini');
    mkdirSync(join(dir, 'tmp', 'puddle', 'chats'), { recursive: true });
    writeFileSync(
      join(dir, 'projects.json'),
      JSON.stringify({ projects: { '/wt': 'puddle' } }, null, 2),
    );
    writeFileSync(join(dir, 'tmp', 'puddle', 'chats', 'sess-1.json'), '{}');
    expect(geminiCli.discoverSessionRef?.('/wt', account(cfg, 'gemini-cli'))).toBe('sess-1');
    // An unmapped worktree is a miss, not a wrong answer.
    expect(geminiCli.discoverSessionRef?.('/other', account(cfg, 'gemini-cli'))).toBeNull();
    expect(await geminiCli.conversationDiscovery?.discover(account(cfg, 'gemini-cli'))).toEqual([
      expect.objectContaining({ ref: 'sess-1', cwd: '/wt' }),
    ]);
  });
});

import { prepareGeminiInteractive } from './control.js';
import { prepareGeminiHeadless } from './headless.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter } from '../adapter.js';
import { matchesAgentProcess } from '../process-match.js';
import { sameNativeCwd } from '../native-cwd.js';
import { installGeminiLifecycleHooks } from './hooks.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';

/** gemini-cli hardcodes this directory name under its (overridable) home. */
const GEMINI_DIR = '.gemini';

/**
 * Gemini CLI adapter.
 *
 * Verified against @google/gemini-cli 0.53.1 (2026-07-31) with `--help` and a
 * scratch-install probe:
 * - **Isolation is `GEMINI_CLI_HOME`, not a config-dir variable.** gemini-cli
 *   hardcodes `.gemini` and resolves its parent through its own `homedir()`,
 *   which checks `GEMINI_CLI_HOME` before `os.homedir()`. Verified: with it set,
 *   `<dir>/.gemini/{projects.json,history/,tmp/}` appeared there. The widely
 *   cited **`GEMINI_CONFIG_DIR` does NOTHING** — verified: with it set the CLI
 *   still read the real `~/.gemini/settings.json`, which would violate SPEC §2
 *   by writing into a config dir puddle did not create. Do not switch to it.
 * - `--session-id <uuid>` ("Start a new session with a manually provided UUID")
 *   means ids ARE presettable, so `presetSessionId: true` and
 *   `agent_session_ref === sessions.id`, as for claude-code.
 * - `-r/--resume` is documented as `latest` or an index (`--resume 5`). Whether
 *   it also accepts a full UUID is **unverified** (needs an authenticated run)
 *   and is the main open risk here — see docs/acceptance/phase-7-agents.md. If
 *   it turns out to be index-only, resume must map the ref to an index via
 *   `--list-sessions` instead.
 * - `-i/--prompt-interactive <text>` seeds a prompt and stays interactive.
 *   `-p/--prompt` is HEADLESS (prints and exits), so using it for a session
 *   would make every session exit immediately.
 * - Both `-y/--yolo` and `--approval-mode {default,auto_edit,yolo,plan}` exist;
 *   the explicit mode is used as the newer, unambiguous spelling.
 * - **There is no `auth` subcommand** (only mcp/extensions/skills/hooks/gemma),
 *   so there is no `gemini auth login` or `auth status`. Login is the first-run
 *   interactive picker: loginArgs launches the TUI bare and the user completes
 *   it, and checkLoggedIn inspects the credentials file instead of asking the
 *   CLI. Unauthenticated runs fail with "Please set an Auth method in your
 *   <home>/.gemini/settings.json …".
 * - Projects are keyed in `<home>/.gemini/projects.json` (absolute cwd → short
 *   name) with per-project `history/<name>/` and `tmp/<name>/` dirs. On
 *   Windows the keys are lower-cased (ProjectRegistry.normalizePath, read in
 *   gemini-cli's main branch 2026-11), so they are matched by sameNativeCwd.
 * - On Windows state also lives under `GEMINI_CLI_HOME` (default
 *   `%USERPROFILE%\.gemini`), as its homedir() override is platform-neutral,
 *   and hooks run through PowerShell; see hook-command.ts. Unverified live:
 *   no Gemini CLI was installed on the port machine.
 * - Additive SessionStart/SessionEnd hooks carry native identity without
 *   replacing user hooks. Fixtures pin their configuration shape; repeat the
 *   logged-in lifecycle acceptance when upgrading beyond 0.53.1.
 *
 * No `conversationShare` and `migratableSessions: false`: chats are per-project
 * files, not per-conversation directories.
 */
export const geminiCli: AgentAdapter = {
  scriptedTurns: true,
  prepareHeadlessLaunch: prepareGeminiHeadless,
  prepareLifecycleLaunch: prepareGeminiInteractive,
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  binary: 'gemini',
  matchesProcess: (command) =>
    matchesAgentProcess(command, 'gemini', ['@google/gemini-cli/dist/index.js']),
  capabilities: {
    resume: true,
    presetSessionId: true,
    skipPermissions: true,
    migratableSessions: false,
  },

  env(account) {
    return { GEMINI_CLI_HOME: account.config_dir };
  },

  prepareConfigDir(configDir) {
    installGeminiLifecycleHooks(configDir);
  },

  reconcileConfigDir(account) {
    if (existsSync(account.config_dir)) installGeminiLifecycleHooks(account.config_dir);
  },

  launchArgs(opts) {
    return [
      '--session-id',
      opts.sessionId,
      ...(opts.skipPermissions ? ['--approval-mode', 'yolo'] : []),
      // --prompt is headless and would exit immediately; -i stays interactive.
      ...(opts.prompt !== undefined ? ['--prompt-interactive', opts.prompt] : []),
    ];
  },

  resumeArgs(ref, opts) {
    return [
      '--resume',
      ref,
      ...(opts.skipPermissions ? ['--approval-mode', 'yolo'] : []),
      ...(opts.prompt !== undefined ? ['--prompt-interactive', opts.prompt] : []),
    ];
  },

  loginArgs() {
    // No auth subcommand: a bare launch shows the first-run auth picker.
    return [];
  },
  loginHint:
    'Complete the auth picker on Gemini’s own screen. When you are done, press Ctrl+C twice to close the agent and finish.',

  async checkLoggedIn(account) {
    // Asking the CLI is not an option (no status command), so the credential
    // file is the signal. Presence only — never read the token itself.
    const dir = geminiDir(account.config_dir);
    return (
      existsSync(join(dir, 'oauth_creds.json')) ||
      existsSync(join(dir, 'google_accounts.json')) ||
      settingsHasAuth(dir)
    );
  },

  async resolveSessionRef(opts) {
    return opts.sessionId; // preset via --session-id
  },

  conversationDiscovery: {
    watchRoots: (account) => [geminiDir(account.config_dir)],
    discover: (account) => discoverGeminiConversations(account.config_dir),
  },
  lifecycleSignals: true,
  checkLifecycleSupport: () => lifecycleVersionAtLeast('gemini', ['--version'], [0, 53, 1]),

  discoverSessionRef(worktreePath, account) {
    const dir = chatsDir(account.config_dir, worktreePath);
    if (dir === null) return null;
    let best: { id: string; mtimeMs: number } | null = null;
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const mtimeMs = statSync(join(dir, name)).mtimeMs;
        const id = name.slice(0, -'.json'.length);
        if (best === null || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
      } catch {
        /* vanished between readdir and stat */
      }
    }
    return best?.id ?? null;
  },

  /**
   * UNVERIFIED against a live session — gemini-cli needs an auth method before
   * it renders its composer. Confirm via docs/acceptance/phase-7-agents.md.
   * There is no hook side-channel, so these are the only status driver.
   */
  statusPatterns: {
    waitingInput: [/Type your message/i, /esc\s+to\s+cancel/i],
    busy: [/esc\s+to\s+cancel/i],
  },
};

function geminiDir(configDir: string): string {
  return join(configDir, GEMINI_DIR);
}

/** An API-key or Vertex auth method recorded in settings counts as logged in. */
function settingsHasAuth(dir: string): boolean {
  try {
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8');
    return /"(selectedAuthType|security)"/.test(raw);
  } catch {
    return false;
  }
}

/**
 * The chats directory for `worktreePath`, resolved through the CLI's own
 * `projects.json` map (absolute cwd → short project name) rather than by
 * recomputing its hashing. Null when the project has not been seen yet.
 */
function chatsDir(configDir: string, worktreePath: string): string | null {
  const dir = geminiDir(configDir);
  let name: string | undefined;
  try {
    const raw = readFileSync(join(dir, 'projects.json'), 'utf8');
    const map = (JSON.parse(raw) as { projects?: Record<string, string> }).projects ?? {};
    name =
      map[worktreePath] ??
      Object.entries(map).find(([cwd]) => sameNativeCwd(cwd, worktreePath))?.[1];
  } catch {
    return null;
  }
  if (name === undefined) return null;
  // Observed layout is tmp/<name>/; chats/ is the documented subdirectory.
  for (const candidate of [
    join(dir, 'tmp', name, 'chats'),
    join(dir, 'history', name, 'chats'),
    join(dir, 'tmp', name),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Async metadata-only Gemini catalogue; unchanged chat files are never read. */
async function discoverGeminiConversations(
  configDir: string,
): Promise<import('../adapter.js').NativeConversation[]> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const root = geminiDir(configDir);
  let projects: Record<string, string>;
  try {
    const raw = JSON.parse(await readFile(join(root, 'projects.json'), 'utf8')) as {
      projects?: Record<string, string>;
    };
    projects = raw.projects ?? {};
  } catch {
    return [];
  }
  const result: import('../adapter.js').NativeConversation[] = [];
  const seen = new Set<string>();
  for (const [cwd, name] of Object.entries(projects)) {
    for (const dir of [
      join(root, 'tmp', name, 'chats'),
      join(root, 'history', name, 'chats'),
      join(root, 'tmp', name),
    ]) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const filename of names) {
        if (!filename.endsWith('.json')) continue;
        const ref = filename.slice(0, -'.json'.length);
        if (seen.has(ref)) continue;
        try {
          const stats = await stat(join(dir, filename));
          if (!stats.isFile()) continue;
          seen.add(ref);
          result.push({
            ref,
            cwd,
            title: null,
            parentRef: null,
            createdAt: stats.birthtime.toISOString(),
            updatedAt: stats.mtime.toISOString(),
          });
        } catch {
          /* vanished during the scan */
        }
      }
    }
  }
  return result.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
}

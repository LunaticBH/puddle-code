// A real daemon (the built startDaemon) in a process of its own, for the
// Windows teardown tests (supervision/windows-daemon-teardown.test.ts):
//
//   node tree-daemon.mjs <agent script> <marker> <gui.exe> [orphans] [--no-helper]
//                                                     (PUDDLE_HOME: a temporary home)
//
// It seeds the home with a project, starts an agent session running the
// tree agent (test/helpers/process-trees.ts; its arguments passed on to
// it), prints one JSON line ({ pid, session }) and serves until it is asked
// over host control to shut down, or is terminated. `--no-helper` runs it
// without the ConPTY helper (src/pty/conpty-jobs.ts).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = (path) => new URL(`../../dist/${path}`, import.meta.url).href;
const { startDaemon } = await import(dist('daemon.js'));
const { openDatabase } = await import(dist('db/db.js'));
const { ensureHome, resolvePaths } = await import(dist('paths.js'));
const { ProfileStore } = await import(dist('db/stores/profiles.js'));
const { AccountStore } = await import(dist('db/stores/accounts.js'));
const { RepoStore } = await import(dist('db/stores/repos.js'));
const { ProjectStore } = await import(dist('db/stores/projects.js'));

const [script, marker, gui, ...flags] = process.argv.slice(2);
const home = process.env.PUDDLE_HOME;
if (!home || !script || !marker || !gui) {
  throw new Error('usage: tree-daemon.mjs <script> <marker> <gui.exe>');
}
const agentArgs = [script, marker, gui, ...flags.filter((flag) => flag === 'orphans')];

const paths = resolvePaths(home);
ensureHome(paths);
const repo = join(home, 'repo');
mkdirSync(repo, { recursive: true });
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
git('init', '-b', 'main');
git('config', 'user.email', 'alice@example.com');
git('config', 'user.name', 'alice');
writeFileSync(join(repo, 'README.md'), '# fixture\n');
git('add', '.');
git('commit', '-m', 'initial');
const db = openDatabase(paths.dbFile);
const profile = new ProfileStore(db).create({ name: 'alice', branch_prefix: 'alice/' });
const configDir = paths.accountConfigDir(profile.id, 'tree', 'personal');
mkdirSync(configDir, { recursive: true });
const account = new AccountStore(db).create({
  profile_id: profile.id,
  agent_type: 'tree',
  label: 'personal',
  config_dir: configDir,
  skip_permissions_default: false,
});
const repoRow = new RepoStore(db).create({
  path: repo,
  default_base_branch: 'main',
  onboarding_notes: '',
  fetch_enabled: false,
});
const project = new ProjectStore(db).create({
  profile_id: profile.id,
  repo_id: repoRow.id,
  name: 'demo',
});
db.close();

const daemon = await startDaemon({
  home,
  port: 0,
  version: 'tree-daemon',
  adapters: [
    {
      id: 'tree',
      displayName: 'Tree agent',
      binary: process.execPath,
      capabilities: {
        resume: true,
        presetSessionId: true,
        skipPermissions: false,
        migratableSessions: false,
      },
      env: () => ({}),
      launchArgs: () => agentArgs,
      resumeArgs: () => agentArgs,
      loginArgs: () => agentArgs,
      resolveSessionRef: async (options) => `tree-${options.sessionId}`,
      hasConversation: () => true,
      statusPatterns: { waitingInput: [/READY/] },
    },
  ],
  onShutdown: () => process.exit(0),
  ...(flags.includes('--no-helper') ? { conptyJobs: null } : {}),
});
const session = await daemon.service.create({ project_id: project.id, account_id: account.id });
process.stdout.write(JSON.stringify({ pid: process.pid, session: session.id }) + '\n');

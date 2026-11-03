import { existsSync, chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyAgentPath,
  loadConfig,
  readConfig,
  saveConfig,
  WINDOWS_AGENT_PATH,
} from '../../src/config.js';
import { canonicalHome, ensureHome, resolvePaths } from '../../src/paths.js';
import { ensureToken } from '../../src/security/token.js';

function freshPaths() {
  const p = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-home-')));
  ensureHome(p);
  return p;
}

describe('resolvePaths', () => {
  it('makes a legacy home private before loading configuration or opening host control', () => {
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-legacy-home-')));
    chmodSync(paths.home, 0o755);
    writeFileSync(paths.configFile, 'existing configuration');
    ensureHome(paths);
    // Windows has no mode bits: shared/test/windows-security.test.ts covers its ACL.
    if (process.platform !== 'win32') expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(readFileSync(paths.configFile, 'utf8')).toBe('existing configuration');
  });

  it('spells a Windows home canonically without resolving the home itself', () => {
    const parent = mkdtempSync(join(tmpdir(), 'puddle-home-parent-'));
    const typed = `${parent.replaceAll('\\', '/')}/.puddle/`;
    expect(canonicalHome(typed, 'linux')).toBe(typed);
    if (process.platform !== 'win32') return; // the rest needs real Windows paths
    expect(canonicalHome(typed.toLowerCase(), 'win32')).toBe(join(parent, '.puddle'));
    expect(resolvePaths(typed).worktreesDir).toBe(join(parent, '.puddle', 'worktrees'));
  });

  it('lays out every path under the given home', () => {
    const home = '/x/home';
    const p = resolvePaths(home);
    expect(p.dbFile).toBe(join(home, 'puddle.db'));
    expect(p.tokenFile).toBe(join(home, 'token'));
    expect(p.configFile).toBe(join(home, 'config.json'));
    expect(p.accountConfigDir('alice', 'claude-code', 'personal')).toBe(
      join(home, 'profiles', 'alice', 'accounts', 'claude-code', 'personal'),
    );
    expect(p.sessionWorktreeDir(3, 'abc')).toBe(join(home, 'worktrees', '3', 'abc'));
    expect(p.sessionLogDir('abc')).toBe(join(home, 'logs', 'abc'));
    expect(p.shellHooksDir).toBe(join(home, 'shell-hooks'));
  });

  it('honours PUDDLE_HOME when no explicit home is given', () => {
    process.env.PUDDLE_HOME = '/tmp/elsewhere';
    try {
      expect(resolvePaths().home).toBe('/tmp/elsewhere');
    } finally {
      delete process.env.PUDDLE_HOME;
    }
  });
});

describe('daemon config', () => {
  it('reads defaults and existing configuration without creating or rewriting the file', () => {
    const paths = freshPaths();
    expect(readConfig(paths).port).toBe(7434);
    expect(existsSync(paths.configFile)).toBe(false);
    const content = '{"configVersion":3,"displayName":"Test host"}';
    writeFileSync(paths.configFile, content);
    expect(readConfig(paths).displayName).toBe('Test host');
    expect(readFileSync(paths.configFile, 'utf8')).toBe(content);
  });
  it('returns defaults when config.json is absent and writes it', () => {
    const paths = freshPaths();
    const cfg = loadConfig(paths);
    expect(cfg).toEqual({
      port: 7434,
      autoResume: true,
      fetchIntervalMinutes: 15,
      logMaxBytes: 10 * 1024 * 1024,
      logRetentionDays: 3,
      replayBytes: 256 * 1024,
      uiStateRetentionDays: 90,
      agentPath:
        process.platform === 'win32'
          ? WINDOWS_AGENT_PATH
          : '~/.local/bin:~/bin:/opt/homebrew/bin:/usr/local/bin',
      displayName: '',
    });
    const onDisk = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    expect(onDisk.port).toBe(7434);
    expect(onDisk.configVersion).toBe(3);
  });

  it('migrates a pre-Phase-6 default port (7433, no marker) to 7434 exactly once', () => {
    const paths = freshPaths();
    writeFileSync(paths.configFile, JSON.stringify({ port: 7433 }) + '\n');
    expect(loadConfig(paths).port).toBe(7434);
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8')).configVersion).toBe(3);
  });

  it('migrates a pre-version-3 "autoResume": false (the old written-back default) to true', () => {
    const paths = freshPaths();
    writeFileSync(paths.configFile, JSON.stringify({ autoResume: false, configVersion: 2 }) + '\n');
    expect(loadConfig(paths).autoResume).toBe(true);
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8')).configVersion).toBe(3);
  });

  it('respects a deliberate post-migration autoResume: false (marker present)', () => {
    const paths = freshPaths();
    writeFileSync(paths.configFile, JSON.stringify({ autoResume: false, configVersion: 3 }) + '\n');
    expect(loadConfig(paths).autoResume).toBe(false);
    expect(saveConfig(paths, { displayName: 'box' }).autoResume).toBe(false);
  });

  it('respects a deliberate post-migration 7433 (marker present)', () => {
    const paths = freshPaths();
    writeFileSync(paths.configFile, JSON.stringify({ port: 7433, configVersion: 2 }) + '\n');
    expect(loadConfig(paths).port).toBe(7433);
    expect(saveConfig(paths, { autoResume: true }).port).toBe(7433);
  });

  it('keeps a custom pre-Phase-6 port through the migration', () => {
    const paths = freshPaths();
    writeFileSync(paths.configFile, JSON.stringify({ port: 7500 }) + '\n');
    expect(loadConfig(paths).port).toBe(7500);
  });

  it('never exposes the marker through the API shape', () => {
    const paths = freshPaths();
    loadConfig(paths);
    expect('configVersion' in loadConfig(paths)).toBe(false);
  });

  it('merges patches and persists them', () => {
    const paths = freshPaths();
    loadConfig(paths);
    const updated = saveConfig(paths, { autoResume: false });
    expect(updated.autoResume).toBe(false);
    expect(loadConfig(paths).autoResume).toBe(false);
  });

  it('rejects an invalid patch', () => {
    const paths = freshPaths();
    loadConfig(paths);
    expect(() => saveConfig(paths, { port: -1 })).toThrow();
  });
});

describe('ensureToken', () => {
  it('creates a 0600 hex token once and reuses it', () => {
    const paths = freshPaths();
    const first = ensureToken(paths);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // Windows has no mode bits; the private home's ACL guards the token there.
    if (process.platform !== 'win32') expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(ensureToken(paths)).toBe(first);
  });
});

describe('applyAgentPath', () => {
  it('prepends tilde-expanded, de-duplicated dirs to PATH', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applyAgentPath('~/.local/bin:/usr/bin', 'linux', env); // /usr/bin already present → not duplicated
    expect(env.PATH).toBe(`${homedir()}/.local/bin:/usr/bin:/bin`);
  });

  it('is a no-op for an empty agentPath', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    applyAgentPath('   ', 'linux', env);
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('applies to the live environment by default', () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin:/bin';
      applyAgentPath('   ');
      expect(process.env.PATH).toBe(process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin:/bin');
    } finally {
      process.env.PATH = saved;
    }
  });

  it('uses ; on Windows, expands ~ and %VAR%, and keeps the Path spelling', () => {
    const env: NodeJS.ProcessEnv = {
      USERPROFILE: 'C:\\Users\\a',
      APPDATA: 'C:\\Users\\a\\AppData\\Roaming',
      Path: 'C:\\Windows;c:\\users\\a\\.local\\bin\\',
    };
    applyAgentPath(`${WINDOWS_AGENT_PATH};%UNSET_DIR%\\bin;~/tools`, 'win32', env);
    expect(env).not.toHaveProperty('PATH');
    expect(env.Path).toBe(
      [
        'C:\\Users\\a\\AppData\\Roaming\\npm',
        'C:\\Users\\a\\.bun\\bin',
        'C:\\Users\\a\\scoop\\shims',
        'C:\\Users\\a\\tools',
        'C:\\Windows',
        'c:\\users\\a\\.local\\bin\\', // already present in another spelling: kept, not duplicated
      ].join(';'),
    );
  });
});

describe('agentPath default', () => {
  it('is the Windows search path on Windows, replacing an absent or POSIX value', () => {
    const paths = freshPaths();
    expect(readConfig(paths, 'win32').agentPath).toBe(WINDOWS_AGENT_PATH);
    writeFileSync(
      paths.configFile,
      JSON.stringify({ agentPath: '~/.local/bin:~/bin:/opt/homebrew/bin:/usr/local/bin' }),
    );
    expect(readConfig(paths, 'win32').agentPath).toBe(WINDOWS_AGENT_PATH);
    expect(readConfig(paths, 'linux').agentPath).toBe(
      '~/.local/bin:~/bin:/opt/homebrew/bin:/usr/local/bin',
    );
    writeFileSync(paths.configFile, JSON.stringify({ agentPath: 'D:\\tools' }));
    expect(readConfig(paths, 'win32').agentPath).toBe('D:\\tools');
  });
});

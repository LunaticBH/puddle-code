import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LogStore } from '../../src/logs/log-store.js';
import { PtyManager, type PtyCwdEvent, type PtyEnvDeltaEvent } from '../../src/pty/pty-manager.js';
import {
  ENV_CAPTURE_DENYLIST,
  installShellHooks,
  isDeniedEnvName,
} from '../../src/pty/shell-hooks.js';
import { resolvePaths } from '../../src/paths.js';

function which(bin: string): string | null {
  try {
    return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const zshPath = which('zsh');
const bashPath = which('bash');
const bashMajor = bashPath
  ? Number(execFileSync(bashPath, ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' }).trim())
  : 0;

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A PTY harness with the hooks armed and a fake $HOME containing known rc files. */
function harness(rcFiles: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-hook-home-'));
  for (const [name, content] of Object.entries(rcFiles)) {
    writeFileSync(join(home, name), content);
  }
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-hook-')));
  const hooks = installShellHooks(paths);
  const logsDir = mkdtempSync(join(tmpdir(), 'puddle-hook-logs-'));
  const logs = new LogStore(logsDir, 64 * 1024);
  const ptys = new PtyManager(logs);
  const historyFile = logs.historyFile('s1');
  const chunks: string[] = [];
  const deltas: PtyEnvDeltaEvent[] = [];
  const cwds: PtyCwdEvent[] = [];
  ptys.on('data', (e: { data: string }) => chunks.push(e.data));
  ptys.on('env-delta', (e: PtyEnvDeltaEvent) => deltas.push(e));
  ptys.on('cwd', (e: PtyCwdEvent) => cwds.push(e));

  function spawn(shellPath: string, extraEnv: Record<string, string> = {}) {
    const cfg = hooks.spawnConfig(shellPath, { captureEnv: true, historyFile });
    ptys.spawn('s1', 'shell-1', shellPath, cfg.args, {
      cwd: home,
      env: {
        ...cfg.env,
        HOME: home,
        // A bare, prompt-quiet environment so the shell reads only our rc files.
        TERM: 'xterm-256color',
        PS1: '$ ',
        ...extraEnv,
      },
    });
  }
  const write = (s: string) => ptys.write('s1', 'shell-1', s);
  const output = () => chunks.join('');
  const resetOutput = () => chunks.splice(0);
  const log = () => readFileSync(join(logsDir, 's1', 'shell-1.log'), 'utf8');
  const kill = () => ptys.killAll();
  const stopped = () => !ptys.has('s1', 'shell-1');
  return {
    home,
    paths,
    hooks,
    historyFile,
    spawn,
    write,
    output,
    resetOutput,
    log,
    deltas,
    cwds,
    kill,
    stopped,
  };
}

describe('installShellHooks', () => {
  it('writes the shim files with private modes, idempotently', () => {
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-hook-')));
    installShellHooks(paths);
    const hooks = installShellHooks(paths); // second run must not throw
    expect(hooks).toBeDefined();
    for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin', 'env-report.zsh']) {
      const st = statSync(join(paths.shellHooksDir, 'zsh', f));
      expect(st.mode & 0o777).toBe(0o600);
    }
    expect(statSync(join(paths.shellHooksDir, 'zsh')).mode & 0o777).toBe(0o700);
    expect(statSync(join(paths.shellHooksDir, 'bash', 'bashrc.bash')).mode & 0o777).toBe(0o600);
  });

  it('spawnConfig dispatches by shell basename', () => {
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-hook-')));
    const hooks = installShellHooks(paths);
    const zsh = hooks.spawnConfig('/bin/zsh');
    expect(zsh.env['ZDOTDIR']).toBe(join(paths.shellHooksDir, 'zsh'));
    expect(zsh.args).toEqual([]);
    const bash = hooks.spawnConfig('/opt/homebrew/bin/bash');
    expect(bash.args).toEqual(['--rcfile', join(paths.shellHooksDir, 'bash', 'bashrc.bash')]);
    expect(bash.env).toEqual({});
    expect(hooks.spawnConfig('/usr/bin/fish')).toEqual({ args: [], env: {} });

    const historyFile = join(paths.logsDir, 'session', 'shell-history');
    const sessionZsh = hooks.spawnConfig('/bin/zsh', { captureEnv: false, historyFile });
    expect(sessionZsh.env).toMatchObject({
      HISTFILE: historyFile,
      PUDDLE_HISTFILE: historyFile,
      PUDDLE_CAPTURE_ENV: '0',
    });
    expect(hooks.spawnConfig('/usr/bin/fish', { captureEnv: true, historyFile })).toEqual({
      args: [],
      env: { HISTFILE: historyFile },
    });
  });

  it('denies hook-control and terminal-state names', () => {
    expect(isDeniedEnvName('PUDDLE_ANYTHING')).toBe(true);
    expect(isDeniedEnvName('PWD')).toBe(true);
    expect(isDeniedEnvName('ZDOTDIR')).toBe(true);
    expect(isDeniedEnvName('HISTFILE')).toBe(true);
    expect(isDeniedEnvName('MY_TOKEN')).toBe(false);
    expect(ENV_CAPTURE_DENYLIST.has('PATH')).toBe(false); // deliberately capturable
  });
});

describe.skipIf(!zshPath)('zsh capture hook', () => {
  it('captures exports (incl. multiline), honours unset, chains the user rc, restores ZDOTDIR', async () => {
    const h = harness({
      '.zshrc': 'export RC_MARKER=from-user-rc\n',
      '.zshenv': '',
    });
    h.spawn(zshPath!);
    // The user's rc ran (chaining) — its export is visible in the shell…
    h.write('echo marker-$RC_MARKER\n');
    await waitFor(() => h.output().includes('marker-from-user-rc'));

    // …but rc-set exports are baseline, not deltas.
    h.write('true\n');
    await waitFor(() => h.output().split('marker-').length > 1);
    expect(h.deltas.map((d) => d.delta.name)).not.toContain('RC_MARKER');

    // A typed export is captured — value byte-exact through quotes and newlines.
    h.write(`export CAP_T1="$(printf 'a\\nb "q" done')"\n`);
    await waitFor(() => h.deltas.some((d) => d.delta.name === 'CAP_T1'));
    const set = h.deltas.find((d) => d.delta.name === 'CAP_T1')!.delta;
    expect(set).toEqual({ op: 'set', name: 'CAP_T1', value: 'a\nb "q" done' });

    // Overwrite → a second set with the new value (last write wins downstream).
    h.write('export CAP_T1=second\n');
    await waitFor(() =>
      h.deltas.some((d) => d.delta.name === 'CAP_T1' && d.delta.value === 'second'),
    );

    // unset → an unset delta.
    h.write('unset CAP_T1\n');
    await waitFor(() => h.deltas.some((d) => d.delta.op === 'unset' && d.delta.name === 'CAP_T1'));

    // ZDOTDIR is restored (unset here — the fake user never had one).
    h.write('echo "zdot-[${ZDOTDIR-none}]"\n');
    await waitFor(() => h.output().includes('zdot-[none]'));

    // The stream and log never contain the side-channel or its payloads.
    expect(h.output()).not.toContain('7733');
    expect(h.log()).not.toContain('7733');
    h.kill();
  });

  it('emits nothing for denylisted churn (cd, PS1) or a source that only reads', async () => {
    const h = harness({ '.zshrc': '' });
    h.spawn(zshPath!);
    h.write('cd / && export PS1="x$ " && true\n');
    h.write('echo done-probing\n');
    await waitFor(() => h.output().includes('done-probing'));
    expect(h.deltas).toEqual([]);
    h.kill();
  });

  it('captures exports made by a sourced script', async () => {
    const h = harness({ '.zshrc': '' });
    writeFileSync(join(h.home, 'setenv.sh'), 'export FROM_SOURCE=sourced-value\n');
    h.spawn(zshPath!);
    h.write('source ./setenv.sh\n');
    await waitFor(() => h.deltas.some((d) => d.delta.name === 'FROM_SOURCE'));
    expect(h.deltas.find((d) => d.delta.name === 'FROM_SOURCE')!.delta.value).toBe('sourced-value');
    h.kill();
  });

  it('keeps Up history navigation after generic environment activation', async () => {
    const h = harness({
      '.zshrc': `activate_env() {
  export VIRTUAL_ENV="$HOME/.envs/test"
  export PATH="$VIRTUAL_ENV/bin:$PATH"
  PS1='(test) $ '
}
activate_env
`,
    });
    h.spawn(zshPath!);
    h.write('echo history-navigation-probe\n');
    await waitFor(() => h.output().includes('history-navigation-probe'));
    h.resetOutput();
    h.write('\x1b[A\n');
    await waitFor(() => h.output().includes('history-navigation-probe'));
    h.kill();
  });

  it('reclaims history after a user hook repoints it around activation and cd', async () => {
    const h = harness({
      '.zshrc': `autoload -Uz add-zsh-hook
unsetopt APPEND_HISTORY
setopt INC_APPEND_HISTORY_TIME
foreign_history_context() {
  HISTFILE="$HOME/foreign-history"
}
add-zsh-hook precmd foreign_history_context
`,
    });
    h.spawn(zshPath!);
    await waitFor(() => h.cwds.some((e) => e.cwd === h.home));
    h.write('mkdir hook-nested && cd hook-nested\n');
    await waitFor(() => h.cwds.some((e) => e.cwd === join(h.home, 'hook-nested')));
    h.write('echo hook-history-probe\n');
    await waitFor(() => h.output().includes('hook-history-probe'));
    await waitFor(() => readFileSync(h.historyFile, 'utf8').includes('hook-history-probe'));
    expect(readFileSync(h.historyFile, 'utf8')).toContain('mkdir hook-nested && cd hook-nested');
    expect(readFileSync(h.historyFile, 'utf8')).toContain('echo hook-history-probe');
    const foreignHistory = join(h.home, 'foreign-history');
    expect(!existsSync(foreignHistory) || !readFileSync(foreignHistory, 'utf8').includes('probe'));
    h.kill();
  });

  it('does not replace history state initialised by the user rc', async () => {
    const h = harness({ '.zshrc': "print -s 'echo zsh-rc-history-probe'\n" });
    h.spawn(zshPath!);
    h.write('\x1b[A\n');
    await waitFor(() => h.output().includes('zsh-rc-history-probe'));
    h.kill();
  });

  it('reports cd and keeps restart history out of the user history', async () => {
    const h = harness({ '.zshrc': 'fc -R "$HISTFILE" 2>/dev/null || true\n' });
    writeFileSync(join(h.home, '.zsh_history'), 'global-history-contamination\n');
    h.spawn(zshPath!);
    await waitFor(() => h.cwds.some((e) => e.cwd === h.home));
    h.write('mkdir nested && cd nested\n');
    await waitFor(() => h.cwds.some((e) => e.cwd === join(h.home, 'nested')));

    h.write('echo session-history-probe\n');
    await waitFor(
      () =>
        existsSync(h.historyFile) &&
        readFileSync(h.historyFile, 'utf8').includes('session-history-probe'),
    );
    expect(readFileSync(h.historyFile, 'utf8')).not.toContain('global-history-contamination');

    h.kill();
    await waitFor(h.stopped);
    h.resetOutput();
    h.spawn(zshPath!);
    h.write('\x1b[A\n');
    await waitFor(() => h.output().includes('session-history-probe'));
    expect(h.output()).not.toContain('global-history-contamination');
    h.kill();
  });
});

describe.skipIf(!bashPath || bashMajor < 4)('bash capture hook (bash ≥ 4)', () => {
  it('captures exports and unsets; user bashrc chains; baseline is silent', async () => {
    const h = harness({ '.bashrc': 'export BRC_MARKER=bash-rc\n' });
    h.spawn(bashPath!);
    h.write('echo marker-$BRC_MARKER\n');
    await waitFor(() => h.output().includes('marker-bash-rc'));
    expect(h.deltas.map((d) => d.delta.name)).not.toContain('BRC_MARKER');

    h.write(`export CAP_B1="$(printf 'x\\ny')"\n`);
    await waitFor(() => h.deltas.some((d) => d.delta.name === 'CAP_B1'));
    expect(h.deltas.find((d) => d.delta.name === 'CAP_B1')!.delta.value).toBe('x\ny');

    h.write('unset CAP_B1\n');
    await waitFor(() => h.deltas.some((d) => d.delta.op === 'unset' && d.delta.name === 'CAP_B1'));
    expect(h.output()).not.toContain('7733');
    h.kill();
  });
});

describe.skipIf(!bashPath)('bash session state hook', () => {
  it('reports cd and isolates persistent history on every supported bash', async () => {
    const h = harness({ '.bashrc': 'history -r "$HISTFILE" 2>/dev/null || true\n' });
    writeFileSync(join(h.home, '.bash_history'), 'global-bash-contamination\n');
    h.spawn(bashPath!);
    await waitFor(() => h.cwds.some((e) => e.cwd === h.home));
    h.write('mkdir bash-nested && cd bash-nested\n');
    await waitFor(() => h.cwds.some((e) => e.cwd === join(h.home, 'bash-nested')));

    h.write('echo bash-session-history-probe\n');
    await waitFor(
      () =>
        existsSync(h.historyFile) &&
        readFileSync(h.historyFile, 'utf8').includes('bash-session-history-probe'),
    );
    expect(readFileSync(h.historyFile, 'utf8')).not.toContain('global-bash-contamination');
    h.kill();
    await waitFor(h.stopped);
    h.resetOutput();
    h.spawn(bashPath!);
    h.write('\x1b[A\n');
    await waitFor(() => h.output().includes('bash-session-history-probe'));
    h.kill();
  });

  it('keeps Up history navigation after generic environment activation', async () => {
    const h = harness({
      '.bashrc': `activate_env() {
  export VIRTUAL_ENV="$HOME/.envs/test"
  export PATH="$VIRTUAL_ENV/bin:$PATH"
  PS1='(test) $ '
}
activate_env
`,
    });
    h.spawn(bashPath!);
    h.write('echo bash-history-navigation-probe\n');
    await waitFor(() => h.output().includes('bash-history-navigation-probe'));
    h.resetOutput();
    h.write('\x1b[A\n');
    await waitFor(() => h.output().includes('bash-history-navigation-probe'));
    h.kill();
  });

  it('does not replace history state initialised by the user rc', async () => {
    const h = harness({ '.bashrc': "history -s 'echo bash-rc-history-probe'\n" });
    h.spawn(bashPath!);
    h.write('\x1b[A\n');
    await waitFor(() => h.output().includes('bash-rc-history-probe'));
    h.kill();
  });

  it('preserves every command in a prompt framework array', async () => {
    const h = harness({
      '.bashrc': "PROMPT_COMMAND=('echo prompt-array-first' 'echo prompt-array-second')\n",
    });
    h.spawn(bashPath!);
    await waitFor(
      () => h.output().includes('prompt-array-first') && h.output().includes('prompt-array-second'),
    );
    h.kill();
  });
});

// Target /bin/bash directly: on macOS it is the stuck-at-3.2 bash even when a
// newer Homebrew bash leads the PATH.
const systemBashMajor = which('/bin/bash')
  ? Number(
      execFileSync('/bin/bash', ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' }).trim(),
    )
  : 0;

describe.skipIf(systemBashMajor === 0 || systemBashMajor >= 4)('bash 3.2 degradation', () => {
  it('reaches a working prompt with no deltas and no error text', async () => {
    const h = harness({ '.bashrc': '' });
    h.spawn('/bin/bash');
    h.write('export OLD_BASH=1; echo degrade-ok\n');
    await waitFor(() => h.output().includes('degrade-ok'));
    h.write('echo still-$OLD_BASH-alive\n');
    await waitFor(() => h.output().includes('still-1-alive'));
    expect(h.deltas).toEqual([]);
    expect(h.output()).not.toMatch(/command not found|syntax error/i);
    h.kill();
  });
});

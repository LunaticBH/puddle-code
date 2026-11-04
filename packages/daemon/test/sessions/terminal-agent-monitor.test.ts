import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCode } from '../../src/agents/claude-code/index.js';
import { codex } from '../../src/agents/codex/index.js';
import { geminiCli } from '../../src/agents/gemini-cli/index.js';
import { opencode } from '../../src/agents/opencode/index.js';
import type { WindowsProcess } from '@puddle/shared/node/platform';
import { windowsDescendants } from '../../src/ports/process-tree.js';
import {
  parseProcessSnapshot,
  windowsProcessCommand,
  windowsProcessSnapshot,
} from '../../src/pty/foreground-process.js';
import { windowsCommandLine } from '../../src/pty/pty-spawn.js';
import {
  TerminalAgentMonitor,
  type TerminalAgentTarget,
} from '../../src/sessions/terminal-agent-monitor.js';
import { RUN_WRAPPER, type RunWrapperPlan } from '../../src/sessions/terminal-command.js';

const adapters = [claudeCode, codex, opencode, geminiCli];
const monitors: TerminalAgentMonitor[] = [];
afterEach(() => {
  monitors.splice(0).forEach((monitor) => monitor.dispose());
  vi.useRealTimers();
});

function fixture() {
  let targets: TerminalAgentTarget[] = [{ session: 'terminal', runtime: 'first', pid: 100 }];
  const snapshot = vi.fn(async () => parseProcessSnapshot(''));
  const changed = vi.fn();
  const notify = vi.fn();
  const monitor = new TerminalAgentMonitor({
    targets: () => targets,
    adapters,
    snapshot,
    changed,
    notify,
    quietMs: 20,
    // The fixtures below are macOS `ps` rows, on every host.
    platform: 'darwin',
  });
  monitors.push(monitor);
  return {
    monitor,
    snapshot,
    changed,
    notify,
    targets: (value: TerminalAgentTarget[]) => {
      targets = value;
    },
    async scan(rows: string, foreground = 200) {
      snapshot.mockResolvedValue(
        parseProcessSnapshot(`100 1 100 ${foreground} ttys000 Ss /bin/bash\n${rows}`),
      );
      await monitor.refresh();
      return monitor.get('terminal', 'first');
    },
  };
}

describe('adapter process recognition', () => {
  it.each([
    [claudeCode, '/usr/local/bin/claude --resume ref'],
    [claudeCode, 'node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
    [codex, '/opt/bin/codex resume ref'],
    [codex, 'node /opt/lib/node_modules/@openai/codex/bin/codex.js'],
    [opencode, '/opt/bin/opencode'],
    [opencode, 'bun /opt/lib/node_modules/opencode-ai/bin/opencode'],
    [geminiCli, 'gemini'],
    [geminiCli, 'node /opt/lib/node_modules/@google/gemini-cli/dist/index.js'],
    [geminiCli, 'node "/opt/with spaces/@google/gemini-cli/dist/index.js"'],
    [claudeCode, 'node /usr/local/bin/claude'],
  ])('recognises %s from its executable or entry point', (adapter, command) => {
    expect(
      adapters.filter((entry) => entry.matchesProcess?.(command)).map((entry) => entry.id),
    ).toEqual([adapter.id]);
  });

  it.each([
    'echo claude',
    '/bin/bash -c codex',
    'vim /tmp/claude',
    'node server.js --prompt codex',
    'node -e "claude"',
    'node --eval /usr/local/bin/claude',
    '/tmp/not-codex',
    'ssh host gemini',
    '',
  ])('does not infer an agent from arguments: %s', (command) => {
    expect(adapters.some((adapter) => adapter.matchesProcess?.(command))).toBe(false);
  });
});

describe('terminal foreground agent monitor', () => {
  it('notifies only on changes and returns to the terminal icon at the prompt', async () => {
    const f = fixture();
    expect(await f.scan('200 100 200 200 ttys000 S+ claude')).toBe('claude-code');
    expect(f.changed).toHaveBeenCalledExactlyOnceWith('terminal');
    await f.monitor.refresh();
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(await f.scan('', 100)).toBeNull();
    expect(f.changed).toHaveBeenCalledTimes(2);
  });

  it('excludes background, suspended, zombie, unrelated and other-PTY agents', async () => {
    const f = fixture();
    expect(
      await f.scan(
        [
          '200 100 200 200 ttys000 S+ sleep 30',
          '300 100 300 200 ttys000 S codex',
          '400 100 200 200 ttys000 T claude',
          '500 100 200 200 ttys000 Z gemini',
          '600 1 200 200 ttys000 S+ opencode',
          '700 100 200 200 ttys001 S+ codex',
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('follows nested shells and keeps the outer agent while it runs tools or subagents', async () => {
    const f = fixture();
    expect(
      await f.scan(
        [
          '150 100 150 200 ttys000 S /bin/zsh',
          '200 150 200 200 ttys000 S+ node /opt/@openai/codex/bin/codex.js',
          '210 200 200 200 ttys000 S+ /opt/codex',
          '220 210 200 200 ttys000 S+ claude',
        ].join('\n'),
      ),
    ).toBe('codex');
    expect(
      await f.scan(
        ['200 100 200 300 ttys000 S claude', '300 200 300 300 ttys000 S+ /bin/bash -c make'].join(
          '\n',
        ),
        300,
      ),
    ).toBe('claude-code');
  });

  it('recognises exec replacing the root shell and Linux pts names', async () => {
    const f = fixture();
    f.snapshot.mockResolvedValue(parseProcessSnapshot('100 1 100 100 pts/12 S+ opencode'));
    await f.monitor.refresh();
    expect(f.monitor.get('terminal', 'first')).toBe('opencode');
  });

  it('leaves ambiguous pipelines, missing roots and processes without a TTY unlabelled', async () => {
    const f = fixture();
    expect(
      await f.scan('200 100 200 200 ttys000 S+ claude\n201 100 200 200 ttys000 S+ codex'),
    ).toBeNull();
    expect(
      await f.scan(
        [
          '200 100 200 200 ttys000 S+ claude',
          '201 100 200 200 ttys000 S+ /bin/sh wrapper',
          '202 201 200 200 ttys000 S+ codex',
        ].join('\n'),
      ),
    ).toBeNull();
    for (const rows of ['', '100 1 100 -1 ? Ss claude', '100 1 100 0 ?? Ss claude']) {
      f.snapshot.mockResolvedValue(parseProcessSnapshot(rows));
      await f.monitor.refresh();
      expect(f.monitor.get('terminal', 'first')).toBeNull();
    }
  });

  it('shares one scan across terminals, coalesces overlapping polls and ignores replaced runtimes', async () => {
    const f = fixture();
    let resolve!: (entries: ReturnType<typeof parseProcessSnapshot>) => void;
    f.snapshot.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.targets([
      { session: 'terminal', runtime: 'first', pid: 100 },
      { session: 'second', runtime: 'other', pid: 500 },
    ]);
    const pending = f.monitor.refresh();
    await f.monitor.refresh();
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    f.targets([
      { session: 'terminal', runtime: 'replacement', pid: 100 },
      { session: 'second', runtime: 'other', pid: 500 },
    ]);
    resolve(
      parseProcessSnapshot(
        [
          '100 1 100 200 ttys000 Ss bash',
          '200 100 200 200 ttys000 S+ claude',
          '500 1 500 600 pts/1 Ss bash',
          '600 500 600 600 pts/1 S+ gemini',
        ].join('\n'),
      ),
    );
    await pending;
    expect(f.monitor.get('terminal', 'replacement')).toBeNull();
    expect(f.monitor.get('second', 'other')).toBe('gemini-cli');
    expect(f.changed).toHaveBeenCalledExactlyOnceWith('second');
  });

  it('clears failed inspections, forgets exited PTYs and does no work without terminals', async () => {
    const f = fixture();
    await f.scan('200 100 200 200 ttys000 S+ claude');
    f.snapshot.mockRejectedValue(new Error('ps unavailable'));
    await f.monitor.refresh();
    expect(f.monitor.get('terminal', 'first')).toBeNull();
    await f.scan('200 100 200 200 ttys000 S+ claude');
    f.monitor.forget('terminal');
    expect(f.monitor.get('terminal', 'first')).toBeNull();
    f.targets([]);
    f.snapshot.mockClear();
    await f.monitor.refresh();
    expect(f.snapshot).not.toHaveBeenCalled();
  });

  it('does not publish an in-flight scan after shutdown', async () => {
    const f = fixture();
    f.snapshot.mockImplementation(async () => {
      f.monitor.dispose();
      return parseProcessSnapshot('100 1 100 100 ttys000 S+ claude');
    });
    await f.monitor.refresh();
    expect(f.changed).not.toHaveBeenCalled();
  });
});

describe('Windows process recognition', () => {
  function windowsProcess(
    pid: number,
    ppid: number,
    name: string,
    commandLine: string | null,
    createdAtMs: number | null = 1_000 + pid,
  ): WindowsProcess {
    return {
      pid,
      ppid,
      name,
      command: name.replace(/\.exe$/i, '').toLowerCase(),
      commandLine,
      createdAtMs,
    };
  }

  it('gives adapters the POSIX command shape: lower-case image name, then / separated arguments', () => {
    expect(
      windowsProcessCommand(
        windowsProcess(
          1,
          0,
          'node.exe',
          '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js resume',
        ),
      ),
    ).toBe('node C:/Users/a/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js resume');
    expect(
      windowsProcessCommand(
        windowsProcess(2, 0, 'Claude.EXE', 'C:\\Users\\a\\.local\\bin\\claude.exe --resume ref'),
      ),
    ).toBe('claude --resume ref');
    expect(windowsProcessCommand(windowsProcess(3, 0, 'codex.exe', null))).toBe('codex');
    expect(
      windowsProcessCommand(
        windowsProcess(
          4,
          0,
          'node.exe',
          'node "C:\\with spaces\\@google\\gemini-cli\\dist\\index.js"',
        ),
      ),
    ).toBe('node "C:/with spaces/@google/gemini-cli/dist/index.js"');
  });

  function monitorOn(processes: WindowsProcess[]) {
    const changed = vi.fn();
    const notify = vi.fn();
    const snapshot = vi.fn(async () => windowsProcessSnapshot(processes));
    const monitor = new TerminalAgentMonitor({
      targets: () => [{ session: 'terminal', runtime: 'first', pid: 100 }],
      adapters,
      snapshot,
      changed,
      notify,
      quietMs: 20,
      platform: 'win32',
    });
    monitors.push(monitor);
    return {
      monitor,
      notify,
      async scan(next: WindowsProcess[]) {
        snapshot.mockResolvedValue(windowsProcessSnapshot(next));
        await monitor.refresh();
        return monitor.get('terminal', 'first');
      },
    };
  }

  const shell = windowsProcess(100, 1, 'pwsh.exe', '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"');

  it('treats every creation-consistent descendant of the PTY root as foreground', async () => {
    const codex = windowsProcess(
      200,
      100,
      'node.exe',
      'node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    );
    const tool = windowsProcess(210, 200, 'cmd.exe', 'cmd.exe /c npm test');
    const f = monitorOn([shell, codex, tool]);
    expect(await f.scan([shell, codex, tool])).toBe('codex');
    // Two agents side by side stay ambiguous, as on POSIX.
    const claude = windowsProcess(300, 100, 'claude.exe', 'claude');
    expect(await f.scan([shell, codex, claude])).toBeNull();
    // Another console's agent, or a pid recycled from before its parent, is not ours.
    expect(await f.scan([shell, windowsProcess(400, 1, 'claude.exe', 'claude')])).toBeNull();
    expect(await f.scan([shell, windowsProcess(500, 100, 'claude.exe', 'claude', 500)])).toBeNull();
  });

  it('reports an exit when the agent pid is gone or reused by a newer process', async () => {
    const claude = windowsProcess(200, 100, 'claude.exe', 'claude');
    const f = monitorOn([shell, claude]);
    expect(await f.scan([shell, claude])).toBe('claude-code');
    // Same pid, later creation time: the agent exited and Windows reused its pid.
    expect(await f.scan([shell, { ...claude, createdAtMs: claude.createdAtMs! + 5_000 }])).toBe(
      'claude-code',
    );
    expect(f.notify).toHaveBeenCalledExactlyOnceWith('terminal', 'exited');
  });

  it('sees through the programme terminal’s run wrapper, which stays the PTY root', async () => {
    // Windows has no exec: the Node run wrapper (terminal-command.ts) is the
    // parent of the programme and then of the session shell for the PTY's
    // whole life. Its plan names the programme, here an agent's own script.
    const step = (file: string, args: string[]) => ({ file, args });
    const codexScript = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
    const plan: RunWrapperPlan = {
      banner: `node ${codexScript}`,
      env: {},
      commands: [step('C:\\nodejs\\node.exe', [codexScript])],
      shell: step('C:\\Program Files\\PowerShell\\7\\pwsh.exe', ['-NoLogo']),
    };
    const encoded = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
    const node = 'C:\\Users\\a\\.puddle\\bin\\current\\bin\\node.exe';
    const wrapper = windowsProcess(
      100,
      1,
      'node.exe',
      windowsCommandLine([node, '-e', RUN_WRAPPER, encoded]),
    );
    const server = windowsProcess(200, 100, 'node.exe', 'node C:\\project\\server.js');
    const pwsh = windowsProcess(
      300,
      100,
      'pwsh.exe',
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"',
    );
    const claude = windowsProcess(400, 300, 'claude.exe', 'claude');
    const codex = windowsProcess(500, 300, 'node.exe', `node ${codexScript}`);

    const f = monitorOn([wrapper]);
    // Neither the wrapper itself (its command line, or only its image name)
    // nor an ordinary Node programme below it is an agent.
    expect(await f.scan([wrapper])).toBeNull();
    expect(await f.scan([{ ...wrapper, commandLine: null }])).toBeNull();
    expect(await f.scan([wrapper, server])).toBeNull();
    // Agents started from the session shell are recognised through it.
    expect(await f.scan([wrapper, pwsh, claude])).toBe('claude-code');
    expect(await f.scan([wrapper, pwsh, codex])).toBe('codex');
    // A port opened by the programme, or later from the shell, is the session's.
    const table = [wrapper, server, pwsh, codex];
    expect(windowsDescendants([wrapper.pid], table)).toEqual(new Set([100, 200, 300, 500]));
  });
});

describe('terminal agent notifications', () => {
  it('reports one busy-to-idle turn without notifying on the initial prompt or redraws', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.scan('200 100 200 200 ttys000 S+ codex');
    f.monitor.feed('terminal', '› question model · /repo');
    await vi.advanceTimersByTimeAsync(25);
    expect(f.notify).not.toHaveBeenCalled();
    f.monitor.feed('terminal', 'esc to interrupt');
    f.monitor.feed('terminal', '› next model · /repo');
    await vi.advanceTimersByTimeAsync(25);
    expect(f.notify).toHaveBeenCalledExactlyOnceWith('terminal', 'waiting_input');
    f.monitor.feed('terminal', '› next model · /repo');
    await vi.advanceTimersByTimeAsync(25);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('reports observed child exit once, but not suspension, backgrounding, or ps failure', async () => {
    const f = fixture();
    await f.scan('200 100 200 200 ttys000 S+ codex');
    await f.scan('200 100 200 100 ttys000 T codex', 100);
    await f.scan('200 100 200 100 ttys000 S codex', 100);
    f.snapshot.mockRejectedValue(new Error('ps failed'));
    await f.monitor.refresh();
    expect(f.notify).not.toHaveBeenCalled();
    await f.scan('', 100);
    await f.scan('', 100);
    expect(f.notify).toHaveBeenCalledExactlyOnceWith('terminal', 'exited');
  });

  it('cancels pending idle signals on suspension and forget, and scopes observations to a runtime', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.scan('200 100 200 200 ttys000 S+ codex');
    f.monitor.feed('terminal', 'esc to interrupt');
    f.monitor.feed('terminal', '› next model · /repo');
    await f.scan('200 100 200 100 ttys000 T codex', 100);
    await vi.advanceTimersByTimeAsync(25);
    f.monitor.forget('terminal');
    f.monitor.exited('terminal');
    expect(f.notify).not.toHaveBeenCalled();
    await f.scan('200 100 200 200 ttys000 S+ codex');
    f.targets([{ session: 'terminal', runtime: 'replacement', pid: 100 }]);
    await f.scan('', 100);
    expect(f.notify).not.toHaveBeenCalled();
  });
});

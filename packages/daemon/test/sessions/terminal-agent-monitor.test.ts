import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCode } from '../../src/agents/claude-code/index.js';
import { codex } from '../../src/agents/codex/index.js';
import { geminiCli } from '../../src/agents/gemini-cli/index.js';
import { opencode } from '../../src/agents/opencode/index.js';
import { parseProcessSnapshot } from '../../src/pty/foreground-process.js';
import {
  TerminalAgentMonitor,
  type TerminalAgentTarget,
} from '../../src/sessions/terminal-agent-monitor.js';

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

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { claudeCode } from '../../src/agents/claude-code/index.js';
import { AdapterRegistry } from '../../src/agents/registry.js';
import { LogStore } from '../../src/logs/log-store.js';
import { extractOscTitle, stripAnsi } from '../../src/pty/ansi.js';
import { EnvOscFilter, MAX_SEQ_BYTES, type ShellReport } from '../../src/pty/env-osc.js';
import { PtyManager, type PtyEnvDeltaEvent } from '../../src/pty/pty-manager.js';
import { StatusDetector } from '../../src/pty/status-detector.js';

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('claude-code adapter', () => {
  const account = {
    id: 1,
    profile_id: 1,
    agent_type: 'claude-code',
    label: 'personal',
    config_dir: '/home/alice/.puddle/profiles/alice/accounts/claude-code/personal',
    skip_permissions_default: false,
    logged_in: true,
    created_at: '2026-07-13T00:00:00Z',
  };

  it('isolates config via CLAUDE_CONFIG_DIR', () => {
    expect(claudeCode.env(account)).toEqual({ CLAUDE_CONFIG_DIR: account.config_dir });
  });

  it('presets the session id and appends the prompt', () => {
    const args = claudeCode.launchArgs({
      worktreePath: '/wt',
      sessionId: 'abc-123',
      prompt: 'do the thing',
      skipPermissions: false,
    });
    expect(args).toEqual(['--session-id', 'abc-123', 'do the thing']);
  });

  it('adds the skip flag only when requested', () => {
    const args = claudeCode.launchArgs({
      worktreePath: '/wt',
      sessionId: 'abc',
      skipPermissions: true,
    });
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('resumes by ref with an optional prompt', () => {
    expect(
      claudeCode.resumeArgs('ref-1', {
        worktreePath: '/wt',
        sessionId: 'x',
        skipPermissions: false,
        prompt: 'note',
      }),
    ).toEqual(['--resume', 'ref-1', 'note']);
  });

  it('echoes the preset session ref', async () => {
    await expect(
      claudeCode.resolveSessionRef(
        { worktreePath: '/wt', sessionId: 'sid-9', skipPermissions: false },
        account,
      ),
    ).resolves.toBe('sid-9');
  });

  it('registry resolves by id and rejects unknown types', () => {
    const registry = new AdapterRegistry([claudeCode]);
    expect(registry.get('claude-code').binary).toBe('claude');
    expect(() => registry.get('nonsense')).toThrow(/no adapter/);
  });
});

describe('stripAnsi', () => {
  it('removes colours, cursor movement and OSC titles', () => {
    expect(stripAnsi('\u001b[32m│ >\u001b[0m ready \u001b]0;title\u0007done')).toBe(
      '│ > ready done',
    );
  });
});

describe('extractOscTitle', () => {
  it('reads an OSC 0/1/2 title, BEL- or ST-terminated', () => {
    expect(extractOscTitle('before \u001b]0;my session\u0007 after')).toBe('my session');
    expect(extractOscTitle('\u001b]2;window\u001b\\')).toBe('window');
    expect(extractOscTitle('\u001b]1;icon\u0007')).toBe('icon');
  });

  it('strips a leading spinner/status glyph so the name is animation-stable', () => {
    // Braille spinner frames (Claude Code) and a symbol prefix both collapse.
    expect(extractOscTitle('\u001b]0;⠋ hey\u0007')).toBe('hey');
    expect(extractOscTitle('\u001b]0;⠙ hey\u0007')).toBe('hey');
    expect(extractOscTitle('\u001b]0;✳ hey\u0007')).toBe('hey');
  });

  it('takes the last title in the chunk and collapses whitespace', () => {
    expect(extractOscTitle('\u001b]0;first\u0007\u001b]0;  second  line \u0007')).toBe(
      'second line',
    );
  });

  it('returns null for no title, an empty title, or an unterminated one', () => {
    expect(extractOscTitle('plain output, no escapes')).toBeNull();
    expect(extractOscTitle('\u001b]0;\u0007')).toBeNull();
    expect(extractOscTitle('\u001b]0;⠋ \u0007')).toBeNull(); // spinner only
    expect(extractOscTitle('\u001b]0;partial no terminator')).toBeNull();
  });
});

describe('StatusDetector', () => {
  it('reports running on output, waiting_input after a quiet match', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const d = new StatusDetector(
      { waitingInput: [/│\s?>/], busy: [/esc to interrupt/i] },
      { onStatus: (s) => statuses.push(s) },
      2000,
    );
    d.feed('\u001b[1mworking… esc to interrupt\u001b[0m');
    expect(statuses).toEqual(['running']);
    vi.advanceTimersByTime(3000);
    expect(statuses).toEqual(['running']); // busy pattern suppressed waiting
    d.feed('\u001b[2J│ > ');
    vi.advanceTimersByTime(1500);
    expect(statuses).toEqual(['running']); // not quiet long enough yet
    vi.advanceTimersByTime(600);
    expect(statuses).toEqual(['running', 'waiting_input']);
    d.feed('tool output');
    expect(statuses).toEqual(['running', 'waiting_input', 'running']);
    d.dispose();
    vi.useRealTimers();
  });

  it('fires limitReached once', () => {
    const limits: number[] = [];
    const d = new StatusDetector(
      { waitingInput: [/never/], limitReached: [/usage limit reached/i] },
      { onStatus: () => undefined, onLimitReached: () => limits.push(1) },
    );
    d.feed('Usage limit reached — try later');
    d.feed('usage limit reached again');
    expect(limits).toHaveLength(1);
    d.dispose();
  });
});

/**
 * A PTY child that needs no shell: Node runs `source` (CommonJS) with
 * `process.argv.slice(1)` holding `extra`. Keeps these tests about the PTY
 * layer, and identical on POSIX and Windows.
 */
function nodeChild(source: string, ...extra: string[]): [string, string[]] {
  return [process.execPath, ['-e', source, ...extra]];
}

/** Print `banner`, then echo stdin back like `cat`. */
const echoAfter = (banner: string) =>
  nodeChild(
    `process.stdout.write(${JSON.stringify(`${banner}\n`)});` +
      "process.stdin.on('data', (d) => process.stdout.write(d));",
  );

/** Print the terminal size as `stty size` does (rows, then columns), then wait. */
const printSize = () =>
  nodeChild(
    "process.stdout.write(process.stdout.rows + ' ' + process.stdout.columns + '\\n');" +
      'setInterval(() => {}, 1000);',
  );

/** Write `text` verbatim, then wait. */
const writeThenWait = (text: string) =>
  nodeChild('process.stdout.write(process.argv[1]); setInterval(() => {}, 1000);', text);

describe('PtyManager', () => {
  function manager() {
    const logsDir = mkdtempSync(join(tmpdir(), 'puddle-logs-'));
    const logs = new LogStore(logsDir, 64 * 1024);
    return { logsDir, logs, ptys: new PtyManager(logs) };
  }

  it('spawns, streams, tees to the log, echoes stdin, and reports exit', async () => {
    const { logsDir, ptys } = manager();
    const chunks: string[] = [];
    let exitCode: number | null = null;
    ptys.on('data', (e: { data: string }) => chunks.push(e.data));
    ptys.on('exit', (e: { exitCode: number }) => (exitCode = e.exitCode));
    ptys.spawn('s1', 'agent', ...echoAfter('hello-from-pty'), { cwd: tmpdir() });
    await waitFor(() => chunks.join('').includes('hello-from-pty'));
    ptys.write('s1', 'agent', 'ping\n');
    await waitFor(() => chunks.join('').includes('ping'));
    expect(ptys.has('s1', 'agent')).toBe(true);
    expect(ptys.liveTerms('s1')).toEqual(['agent']);
    ptys.kill('s1', 'agent');
    await waitFor(() => exitCode !== null);
    expect(ptys.has('s1', 'agent')).toBe(false);
    const log = readFileSync(join(logsDir, 's1', 'agent.log'), 'utf8');
    expect(log).toContain('hello-from-pty');
  });

  it('pidsFor returns the OS pids of every live term on a stream, scoped to that stream', async () => {
    const { ptys } = manager();
    ptys.spawn('s3', 'agent', ...echoAfter('agent-ready'), { cwd: tmpdir() });
    ptys.spawn('s3', 'shell-1', ...echoAfter('shell-ready'), { cwd: tmpdir() });
    ptys.spawn('other-stream', 'agent', ...echoAfter('other-ready'), { cwd: tmpdir() });
    await waitFor(() => ptys.liveTerms('s3').length === 2 && ptys.has('other-stream', 'agent'));

    const pids = ptys.pidsFor('s3');
    expect(pids).toHaveLength(2);
    expect(pids.every((p) => typeof p === 'number' && p > 0)).toBe(true);

    // Scoped: an unrelated stream's pid must not leak in, and a stream with
    // no live PTYs returns [] rather than throwing.
    const otherPids = ptys.pidsFor('other-stream');
    expect(otherPids).toHaveLength(1);
    expect(pids).not.toContain(otherPids[0]);
    expect(ptys.pidsFor('no-such-stream')).toEqual([]);

    ptys.killAll();
  });

  it('starts a PTY at the size its viewer last asked for, live or not', async () => {
    const { ptys } = manager();
    const chunks: string[] = [];
    ptys.on('data', (e: { data: string }) => chunks.push(e.data));

    // A viewer attached to an EXITED session sizes a stream with nothing live:
    // the size must survive to the resume, which is the whole point (a migration
    // or a resume replaces the PTY under an attached viewer, and nothing
    // re-sends the size — no fresh attach, no container change).
    ptys.resize('s7', 'agent', 100, 40);
    ptys.spawn('s7', 'agent', ...printSize(), { cwd: tmpdir() });
    await waitFor(() => /40\s+100/.test(chunks.join('')));

    // A resize while live is remembered the same way, for the NEXT process.
    ptys.resize('s7', 'agent', 90, 30);
    ptys.kill('s7', 'agent');
    await waitFor(() => !ptys.has('s7', 'agent'));
    chunks.length = 0;
    ptys.spawn('s7', 'agent', ...printSize(), { cwd: tmpdir() });
    await waitFor(() => /30\s+90/.test(chunks.join('')));

    // A stream nobody sized starts at the default, and `forget` returns a
    // retired stream (a deleted account's login PTY) to it.
    chunks.length = 0;
    ptys.spawn('s8', 'agent', ...printSize(), { cwd: tmpdir() });
    await waitFor(() => /32\s+120/.test(chunks.join('')));
    ptys.resize('s8', 'agent', 70, 20);
    ptys.forget('s8');
    ptys.kill('s8', 'agent');
    await waitFor(() => !ptys.has('s8', 'agent'));
    chunks.length = 0;
    ptys.spawn('s8', 'agent', ...printSize(), { cwd: tmpdir() });
    await waitFor(() => /32\s+120/.test(chunks.join('')));
    ptys.killAll();
  });

  it('injects daemon notes into log and stream', async () => {
    const { logs, ptys } = manager();
    const chunks: string[] = [];
    ptys.on('data', (e: { data: string }) => chunks.push(e.data));
    ptys.note('s2', 'agent', 'skip-permissions not permitted; continuing with prompts on');
    expect(chunks.join('')).toContain('[puddle] skip-permissions not permitted');
    expect(logs.readTail('s2', 'agent')).toContain('[puddle]');
  });
});

describe('EnvOscFilter', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const seq = (op: string, name: string, value?: string, term = '\u0007') =>
    `\u001b]7733;${op};${b64(name)}${value === undefined ? '' : `;${b64(value)}`}${term}`;

  function pushAll(f: EnvOscFilter, chunks: string[]) {
    let data = '';
    const deltas: ShellReport[] = [];
    for (const c of chunks) {
      const r = f.push(c);
      data += r.data;
      deltas.push(...r.deltas);
    }
    return { data, deltas };
  }

  it('parses set/unset and strips them from the stream (BEL and ST)', () => {
    const f = new EnvOscFilter();
    const input = `before${seq('set', 'FOO', 'bar')}mid${seq('unset', 'FOO', undefined, '\u001b\\')}after`;
    const { data, deltas } = pushAll(f, [input]);
    expect(data).toBe('beforemidafter');
    expect(deltas).toEqual([
      { op: 'set', name: 'FOO', value: 'bar' },
      { op: 'unset', name: 'FOO' },
    ]);
  });

  it('handles sequences split across chunks at every byte boundary', () => {
    const whole = `a${seq('set', 'MULTI', 'line one\nline "two" ✓')}z`;
    for (let cut = 1; cut < whole.length; cut++) {
      const f = new EnvOscFilter();
      const { data, deltas } = pushAll(f, [whole.slice(0, cut), whole.slice(cut)]);
      expect(data).toBe('az');
      expect(deltas).toEqual([{ op: 'set', name: 'MULTI', value: 'line one\nline "two" ✓' }]);
    }
  });

  it('does not swallow a lone trailing ESC in plain output', () => {
    const f = new EnvOscFilter();
    const first = f.push('text\u001b');
    // The ESC is held as potential introducer head…
    expect(first.data).toBe('text');
    // …and released once the follow-up proves it ordinary.
    expect(f.push('[31mred').data).toBe('\u001b[31mred');
  });

  it('accepts an empty value (export FOO="")', () => {
    const f = new EnvOscFilter();
    const { deltas } = pushAll(f, [seq('set', 'EMPTY', '')]);
    expect(deltas).toEqual([{ op: 'set', name: 'EMPTY', value: '' }]);
  });

  it('parses an absolute cwd report and rejects unsafe paths', () => {
    const f = new EnvOscFilter('linux');
    const { data, deltas } = pushAll(f, [
      `a${seq('cwd', '/worktree/nested')}b${seq('cwd', 'relative/path')}c${seq('cwd', 'C:\\x')}`,
    ]);
    expect(data).toBe('abc');
    expect(deltas).toEqual([{ op: 'cwd', path: '/worktree/nested' }]);
  });

  it('accepts Windows drive and UNC directories on win32 only', () => {
    const f = new EnvOscFilter('win32');
    const reports = [
      'c:\\Users\\a\\wt', // PowerShell's ProviderPath
      'C:/Users/a/wt/sub',
      '\\\\server\\share\\dir',
      // `/`-rooted forms are no Windows path PowerShell reports.
      '/d/src/repo',
      '/e',
      '//server/share/dir',
      '/tmp/nested',
      '\\rootless', // relative to the current drive: never absolute
      'relative\\path',
    ];
    const { deltas } = pushAll(f, [reports.map((path) => seq('cwd', path)).join('')]);
    expect(deltas.map((delta) => (delta.op === 'cwd' ? delta.path : delta.op))).toEqual([
      'C:\\Users\\a\\wt',
      'C:\\Users\\a\\wt\\sub',
      '\\\\server\\share\\dir',
    ]);
  });

  it('drops malformed payloads without corrupting surrounding text', () => {
    const f = new EnvOscFilter();
    const bad = [
      '\u001b]7733;set;not-base64!;YQ==\u0007',
      '\u001b]7733;bogus;YQ==\u0007',
      `\u001b]7733;set;${Buffer.from('1BAD NAME').toString('base64')};YQ==\u0007`,
      '\u001b]7733;set\u0007',
    ].join('between');
    const { data, deltas } = pushAll(f, [`x${bad}y`]);
    expect(deltas).toEqual([]);
    expect(data).toBe('xbetweenbetweenbetweeny');
  });

  it('discards an oversized sequence and resyncs afterwards', () => {
    const f = new EnvOscFilter();
    const huge = '\u001b]7733;set;' + 'A'.repeat(MAX_SEQ_BYTES + 1024);
    const r1 = f.push(`ok1${huge}`);
    expect(r1.data).toBe('ok1');
    // Terminator arrives much later; nothing of the payload ever surfaces.
    const r2 = f.push('B'.repeat(2048) + '\u0007ok2' + seq('set', 'AFTER', '1'));
    expect(r2.data).toBe('ok2');
    expect(r2.deltas).toEqual([{ op: 'set', name: 'AFTER', value: '1' }]);
  });
});

describe('PtyManager shell reports', () => {
  function manager() {
    const logsDir = mkdtempSync(join(tmpdir(), 'puddle-logs-'));
    const logs = new LogStore(logsDir, 64 * 1024);
    return { logsDir, logs, ptys: new PtyManager(logs) };
  }

  it('emits env-delta and strips OSC 7733 from stream and log', async () => {
    const { logsDir, logs, ptys } = manager();
    const chunks: string[] = [];
    const deltas: PtyEnvDeltaEvent[] = [];
    ptys.on('data', (e: { data: string }) => chunks.push(e.data));
    ptys.on('env-delta', (e: PtyEnvDeltaEvent) => deltas.push(e));
    // Rk9P / YmFy are b64("FOO") / b64("bar").
    ptys.spawn('s9', 'shell-1', ...writeThenWait('\u001b]7733;set;Rk9P;YmFy\u0007visible\r\n'), {
      cwd: tmpdir(),
    });
    await waitFor(() => deltas.length === 1 && chunks.join('').includes('visible'));
    expect(deltas[0]).toMatchObject({
      stream: 's9',
      term: 'shell-1',
      delta: { op: 'set', name: 'FOO', value: 'bar' },
    });
    ptys.kill('s9', 'shell-1');
    const joined = chunks.join('');
    logs.flushAll(); // appends coalesce; force them out before reading the file raw
    const log = readFileSync(join(logsDir, 's9', 'shell-1.log'), 'utf8');
    for (const text of [joined, log]) {
      expect(text).toContain('visible');
      expect(text).not.toContain('7733');
      expect(text).not.toContain('YmFy');
    }
  });

  it('routes cwd reports separately from environment deltas', async () => {
    const { ptys } = manager();
    const cwds: Array<{ stream: string; term: string; cwd: string }> = [];
    const deltas: PtyEnvDeltaEvent[] = [];
    ptys.on('cwd', (e) => cwds.push(e));
    ptys.on('env-delta', (e: PtyEnvDeltaEvent) => deltas.push(e));
    // An absolute directory in this host's own form.
    const nested = process.platform === 'win32' ? 'C:\\tmp\\nested' : '/tmp/nested';
    const report = `\u001b]7733;cwd;${Buffer.from(nested).toString('base64')}\u0007`;
    ptys.spawn('s10', 'shell-1', ...writeThenWait(report), { cwd: tmpdir() });
    await waitFor(() => cwds.length === 1);
    expect(cwds).toEqual([{ stream: 's10', term: 'shell-1', cwd: nested }]);
    expect(deltas).toEqual([]);
    ptys.kill('s10', 'shell-1');
  });
});

describe('LogStore', () => {
  it('appends, tails and lists terms', () => {
    const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 16);
    logs.append('sid', 'agent', 'aaaaaaaaaaaaaaaaaaaaaaaaa');
    logs.append('sid', 'shell-1', 'bbb');
    logs.closeAll();
    expect(logs.readTail('sid', 'agent')).toBe('aaaaaaaaaaaaaaaa'); // capped at 16 bytes
    expect(logs.readTail('sid', 'missing')).toBe('');
    expect(logs.listTerms('sid').sort()).toEqual(['agent', 'shell-1']);
    expect(logs.historyFile('sid')).toMatch(/[\\/]sid[\\/]shell-history$/);
    expect(logs.listTerms('sid').sort()).toEqual(['agent', 'shell-1']);
  });

  it('rotates a log past maxBytes down to its newest tail', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'puddle-logs-'));
    const logs = new LogStore(logsDir, 8, 64); // replay 8, cap 64 → keeps 32
    logs.append('sid', 'agent', `${'x'.repeat(100)}END`);
    logs.flushAll();
    const file = readFileSync(join(logsDir, 'sid', 'agent.log'), 'utf8');
    expect(file.length).toBe(32); // max(replayBytes, maxBytes / 2)
    expect(file.endsWith('END')).toBe(true);
    expect(logs.readTail('sid', 'agent')).toBe('xxxxxEND');
    // Appends keep landing on the reopened fd after a rotation.
    logs.append('sid', 'agent', '+more');
    logs.closeAll();
    expect(readFileSync(join(logsDir, 'sid', 'agent.log'), 'utf8').endsWith('END+more')).toBe(true);
  });
});

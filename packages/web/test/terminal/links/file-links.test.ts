import { describe, expect, it, vi } from 'vitest';
import type { ResolvePathResponse } from '@puddle/shared';
import { bufferWithLines } from '../../helpers/terminal-buffer';
import {
  externalBrowseRoot,
  fileLinkTarget,
  findBufferPathCandidates,
  findPathCandidates,
  ResolveCache,
  type FileLinkTarget,
} from '../../../src/features/terminal/links/file-links';

describe('findPathCandidates', () => {
  it('captures a path with line and column, underlining the whole token', () => {
    expect(findPathCandidates('src/foo.ts:12:3')).toEqual([
      { path: 'src/foo.ts', line: 12, column: 3, start: 0, end: 15 },
    ]);
  });

  it('captures a ./relative path with no position', () => {
    expect(findPathCandidates('./a/b.py')).toEqual([
      { path: './a/b.py', line: undefined, column: undefined, start: 0, end: 8 },
    ]);
  });

  it('captures a ../relative path with a line only', () => {
    expect(findPathCandidates('../x/y.rs:7')).toEqual([
      { path: '../x/y.rs', line: 7, column: undefined, start: 0, end: 11 },
    ]);
  });

  it('captures an absolute path mid-sentence', () => {
    expect(findPathCandidates('open /wt/src/a.c now')).toEqual([
      { path: '/wt/src/a.c', line: undefined, column: undefined, start: 5, end: 16 },
    ]);
  });

  it('captures a path inside double quotes without the quotes', () => {
    expect(findPathCandidates('he said "src/foo.ts" ok')).toEqual([
      { path: 'src/foo.ts', line: undefined, column: undefined, start: 9, end: 19 },
    ]);
  });

  it('captures a path:line inside parens, leaving the closing paren out', () => {
    expect(findPathCandidates('(src/foo.ts:3)')).toEqual([
      { path: 'src/foo.ts', line: 3, column: undefined, start: 1, end: 13 },
    ]);
  });

  it('drops a trailing sentence full stop', () => {
    expect(findPathCandidates('see src/foo.ts. end')).toEqual([
      { path: 'src/foo.ts', line: undefined, column: undefined, start: 4, end: 14 },
    ]);
  });

  it('finds several candidates on one line', () => {
    expect(findPathCandidates('a.ts b.ts two')).toEqual([
      { path: 'a.ts', line: undefined, column: undefined, start: 0, end: 4 },
      { path: 'b.ts', line: undefined, column: undefined, start: 5, end: 9 },
    ]);
  });

  it('matches a bare filename because it carries an extension', () => {
    expect(findPathCandidates('bare foo.ts here')).toEqual([
      { path: 'foo.ts', line: undefined, column: undefined, start: 5, end: 11 },
    ]);
  });

  it('ignores an extension-less word but keeps a real filename beside it', () => {
    // LICENSE has no extension and no leading slash → quiet; README.md matches.
    expect(findPathCandidates('README.md and LICENSE')).toEqual([
      { path: 'README.md', line: undefined, column: undefined, start: 0, end: 9 },
    ]);
  });

  it('stays quiet for prose and decimal numbers', () => {
    expect(findPathCandidates('the value 3.14 is fine')).toEqual([]);
    expect(findPathCandidates('just some prose words')).toEqual([]);
  });

  it('captures an extension-less path under a ~/ home prefix', () => {
    expect(findPathCandidates('~/.claude/prompts/up-fix')).toEqual([
      { path: '~/.claude/prompts/up-fix', line: undefined, column: undefined, start: 0, end: 24 },
    ]);
  });

  it('captures an extension-less multi-segment relative path', () => {
    expect(findPathCandidates('cd .worktrees/hil-demos')).toEqual([
      { path: '.worktrees/hil-demos', line: undefined, column: undefined, start: 3, end: 23 },
    ]);
  });

  it('captures an extension-less absolute directory', () => {
    expect(findPathCandidates('/home/bios/waddle')).toEqual([
      { path: '/home/bios/waddle', line: undefined, column: undefined, start: 0, end: 17 },
    ]);
  });

  it("strips Claude Code's leading @ file-ref marker at line start", () => {
    expect(findPathCandidates('@~/notes.md')).toEqual([
      { path: '~/notes.md', line: undefined, column: undefined, start: 1, end: 11 },
    ]);
  });

  it('strips a leading @ mid-sentence, underlining only the path', () => {
    expect(findPathCandidates('see @.claude/prompts/up-fix here')).toEqual([
      { path: '.claude/prompts/up-fix', line: undefined, column: undefined, start: 5, end: 27 },
    ]);
  });

  it('produces a benign false positive for "e.g." that the server then rejects', () => {
    // ".g" is a legal one-letter extension (cf. .c, .h, .R); the regex cannot
    // tell it from prose, so a candidate is emitted and /resolve 404s it away.
    expect(findPathCandidates('e.g. this way')).toEqual([
      { path: 'e.g', line: undefined, column: undefined, start: 0, end: 3 },
    ]);
  });
});

describe('findPathCandidates on a Windows host', () => {
  const win = (text: string) => findPathCandidates(text, 'win32');

  it('captures a drive path with line and column, consuming the drive colon first', () => {
    expect(win('C:\\x\\y.ts:12:5')).toEqual([
      { path: 'C:\\x\\y.ts', line: 12, column: 5, start: 0, end: 14 },
    ]);
    expect(win('C:\\x\\y.ts:12')).toEqual([
      { path: 'C:\\x\\y.ts', line: 12, column: undefined, start: 0, end: 12 },
    ]);
  });

  it('captures a forward-slash drive path', () => {
    expect(win('open C:/x/y.ts now')).toEqual([
      { path: 'C:/x/y.ts', line: undefined, column: undefined, start: 5, end: 14 },
    ]);
  });

  it('captures backslash relative paths, with and without a ./ prefix', () => {
    expect(win('a\\b.ts')).toEqual([
      { path: 'a\\b.ts', line: undefined, column: undefined, start: 0, end: 6 },
    ]);
    expect(win('.\\a\\b.py:3')).toEqual([
      { path: '.\\a\\b.py', line: 3, column: undefined, start: 0, end: 10 },
    ]);
    expect(win('..\\x\\y')).toEqual([
      { path: '..\\x\\y', line: undefined, column: undefined, start: 0, end: 6 },
    ]);
    expect(win('~\\notes\\todo.md')).toEqual([
      { path: '~\\notes\\todo.md', line: undefined, column: undefined, start: 0, end: 15 },
    ]);
  });

  it('never offers a UNC or device path, whose lookup would reach another server', () => {
    for (const line of [
      'see \\\\server\\share\\x.txt',
      '\\\\server\\share\\x.txt:3',
      'see //server/share/x.txt',
      '"\\\\10.0.0.5\\c$\\notes.md"',
      'open \\\\?\\C:\\x\\y.ts',
      'pipe \\\\.\\pipe\\x',
    ]) {
      expect(win(line), line).toEqual([]);
    }
  });

  it('reads the tsc/MSVC file(line,col) position and underlines its parentheses', () => {
    expect(win('src\\a.ts(12,5): error TS2322')).toEqual([
      { path: 'src\\a.ts', line: 12, column: 5, start: 0, end: 14 },
    ]);
    expect(win('C:\\x\\y.cpp(7): error C2065')).toEqual([
      { path: 'C:\\x\\y.cpp', line: 7, column: undefined, start: 0, end: 13 },
    ]);
  });

  it('finds paths in Node stack frames and Python tracebacks', () => {
    expect(win('    at main (C:\\app\\index.js:3:9)')).toEqual([
      { path: 'C:\\app\\index.js', line: 3, column: 9, start: 13, end: 32 },
    ]);
    expect(win('  File "C:\\app\\main.py", line 4')).toEqual([
      { path: 'C:\\app\\main.py', line: undefined, column: undefined, start: 8, end: 22 },
    ]);
  });

  it('still finds the forward-slash paths git and agents print', () => {
    expect(win('src/foo.ts:12:3')).toEqual([
      { path: 'src/foo.ts', line: 12, column: 3, start: 0, end: 15 },
    ]);
    expect(win('@src\\foo.ts')).toEqual([
      { path: 'src\\foo.ts', line: undefined, column: undefined, start: 1, end: 11 },
    ]);
    expect(win('@C:\\notes.md')).toEqual([
      { path: 'C:\\notes.md', line: undefined, column: undefined, start: 1, end: 12 },
    ]);
  });

  it('stays quiet for prose and decimals', () => {
    expect(win('the build took 3.14 seconds')).toEqual([]);
  });

  it('leaves POSIX hosts on their own pattern: no Windows paths, no paren positions', () => {
    expect(findPathCandidates('C:\\x\\y.ts:12:5')).toEqual([]);
    expect(findPathCandidates('a.ts(12,5)')).toEqual([
      { path: 'a.ts', line: undefined, column: undefined, start: 0, end: 4 },
    ]);
  });
});

describe('findBufferPathCandidates on a Windows host', () => {
  it('joins a deliberate break after a backslash', () => {
    const buffer = bufferWithLines(
      [{ text: 'see C:\\src\\' }, { text: '  nested\\file.ts:4' }],
      80,
    );
    expect(findBufferPathCandidates(buffer, 1, 80, 'win32')[0]).toMatchObject({
      candidate: { path: 'C:\\src\\nested\\file.ts', line: 4 },
      start: { row: 0, col: 4 },
      end: { row: 1, col: 17 },
    });
    // A POSIX host never treats a backslash as a separator to continue after.
    expect(findBufferPathCandidates(buffer, 1, 80).map((link) => link.text)).not.toContain(
      'C:\\src\\nested\\file.ts:4',
    );
  });

  it('does not merge a new drive path into the previous line', () => {
    const buffer = bufferWithLines([{ text: 'src\\file.ts' }, { text: 'C:\\other.ts' }], 12);
    expect(findBufferPathCandidates(buffer, 1, 12, 'win32').map((link) => link.text)).toEqual([
      'C:\\other.ts',
    ]);
  });
});

describe('findBufferPathCandidates', () => {
  it('joins indented continuations with a right gutter and keeps the original coordinates', () => {
    const buffer = bufferWithLines(
      [
        { text: '  see src/features/' },
        { text: '    terminal/file-' },
        { text: '    links.ts:12:3' },
      ],
      22,
    );
    for (const row of [0, 1, 2]) {
      expect(findBufferPathCandidates(buffer, row, 22)[0]).toMatchObject({
        candidate: { path: 'src/features/terminal/file-links.ts', line: 12, column: 3 },
        start: { row: 0, col: 6 },
        end: { row: 2, col: 16 },
      });
    }
  });

  it('joins a deliberate line break at a directory separator away from the margin', () => {
    const buffer = bufferWithLines([{ text: 'see src/' }, { text: '  nested/file.ts:4' }], 80);
    expect(findBufferPathCandidates(buffer, 1, 80)[0]).toMatchObject({
      candidate: { path: 'src/nested/file.ts', line: 4 },
      start: { row: 0, col: 4 },
      end: { row: 1, col: 17 },
    });
  });

  it('preserves spaces at a soft wrap so separate tokens do not merge', () => {
    const buffer = bufferWithLines(
      [{ text: 'note' }, { text: 'src/file.ts', isWrapped: true }],
      12,
    );
    expect(findBufferPathCandidates(buffer, 1, 12)[0]).toMatchObject({
      candidate: { path: 'src/file.ts' },
      start: { row: 1, col: 0 },
      end: { row: 1, col: 10 },
    });
  });

  it('does not merge a new absolute path or cross blank lines', () => {
    const buffer = bufferWithLines(
      [{ text: 'src/file.ts' }, { text: '/other.ts' }, { text: '' }, { text: 'last.ts' }],
      12,
    );
    expect(findBufferPathCandidates(buffer, 1, 12).map((link) => link.text)).toEqual(['/other.ts']);
    expect(findBufferPathCandidates(buffer, 3, 12).map((link) => link.text)).toEqual(['last.ts']);
  });

  it('returns the same complete link from either row of a soft-wrapped path', () => {
    const buffer = bufferWithLines(
      [{ text: 'see src/long' }, { text: 'er/file.ts:3', isWrapped: true }],
      12,
    );

    const expected = {
      candidate: { path: 'src/longer/file.ts', line: 3, column: undefined, start: 4, end: 24 },
      start: { row: 0, col: 4 },
      end: { row: 1, col: 11 },
      text: 'src/longer/file.ts:3',
    };
    expect(findBufferPathCandidates(buffer, 0, 12)).toContainEqual(expected);
    expect(findBufferPathCandidates(buffer, 1, 12)).toContainEqual(expected);
  });

  it('joins a path hard-wrapped by a terminal UI at the right edge', () => {
    const buffer = bufferWithLines([{ text: 'see src/long' }, { text: 'er/file.ts:3' }], 12);

    const links = findBufferPathCandidates(buffer, 1, 12);
    expect(links[0]).toMatchObject({
      candidate: { path: 'src/longer/file.ts', line: 3 },
      start: { row: 0, col: 4 },
      end: { row: 1, col: 11 },
      text: 'src/longer/file.ts:3',
    });
  });

  it('uses the current terminal width when stored rows retain wider cells', () => {
    const buffer = bufferWithLines(
      [
        { text: 'src/long-paOLD-DATA', storedLength: 20 },
        { text: 'th/file.ts', isWrapped: true, storedLength: 20 },
      ],
      11,
    );

    expect(findBufferPathCandidates(buffer, 1, 11)[0]).toMatchObject({
      candidate: { path: 'src/long-path/file.ts' },
      start: { row: 0, col: 0 },
      end: { row: 1, col: 9 },
    });
  });

  it('keeps the final cell on the previous row when a path ends at the margin', () => {
    const buffer = bufferWithLines([{ text: 'src/file.ts' }, { text: 'next line' }], 11);

    expect(findBufferPathCandidates(buffer, 0, 11)).toContainEqual({
      candidate: {
        path: 'src/file.ts',
        line: undefined,
        column: undefined,
        start: 0,
        end: 11,
      },
      start: { row: 0, col: 0 },
      end: { row: 0, col: 10 },
      text: 'src/file.ts',
    });
  });
});

describe('fileLinkTarget', () => {
  it('keeps external-file coordinates and the requested editor position', () => {
    expect(
      fileLinkTarget({ kind: 'file', path: 'notes.md', root: '/shared', line: 4 }, 4, 2),
    ).toEqual({ kind: 'file', path: 'notes.md', root: '/shared', line: 4, column: 2 });
  });

  it('drops meaningless positions from a directory target', () => {
    expect(
      fileLinkTarget(
        { kind: 'dir', path: '/worktree/src', line: null, relative_path: 'src' },
        4,
        2,
      ),
    ).toEqual({ kind: 'dir', path: '/worktree/src', relativePath: 'src' });
  });
});

describe('externalBrowseRoot', () => {
  it('promotes an outside file directory, but not an already-current root', () => {
    const target: FileLinkTarget = { kind: 'file', path: 'notes.md', root: '/shared' };
    expect(externalBrowseRoot(target)).toBe('/shared');
    expect(externalBrowseRoot(target, '/shared')).toBeNull();
    expect(externalBrowseRoot({ kind: 'file', path: 'README.md' })).toBeNull();
  });
});

/** A deferred promise for driving fetcher timing in tests. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (path: string): ResolvePathResponse => ({ path, line: null });

describe('ResolveCache', () => {
  it('serves a positive result from cache until its 15s TTL lapses', async () => {
    let t = 0;
    const fetcher = vi.fn(async (_s: string, path: string) => ok(path));
    const cache = new ResolveCache({ fetcher, now: () => t });

    await cache.resolve('s', 'a.ts');
    await cache.resolve('s', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 14_999;
    await cache.resolve('s', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 15_001;
    await cache.resolve('s', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ages a negative result out after only 5s', async () => {
    let t = 0;
    const fetcher = vi.fn(async () => null);
    const cache = new ResolveCache({ fetcher, now: () => t });

    expect(await cache.resolve('s', 'x.ts')).toBeNull();
    t = 4_999;
    await cache.resolve('s', 'x.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);

    t = 5_001;
    await cache.resolve('s', 'x.ts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent asks for the same key into a single fetch', async () => {
    const d = deferred<ResolvePathResponse>();
    const fetcher = vi.fn(() => d.promise);
    const cache = new ResolveCache({ fetcher, now: () => 0 });

    const p1 = cache.resolve('s', 'a.ts');
    const p2 = cache.resolve('s', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);

    d.resolve(ok('a.ts'));
    expect(await p1).toEqual(ok('a.ts'));
    expect(await p2).toEqual(ok('a.ts'));
  });

  it('keys on (session, path) so different sessions do not collide', async () => {
    const fetcher = vi.fn(async (_s: string, path: string) => ok(path));
    const cache = new ResolveCache({ fetcher, now: () => 0 });
    await cache.resolve('s1', 'a.ts');
    await cache.resolve('s2', 'a.ts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry once the cap is exceeded', async () => {
    const fetcher = vi.fn(async (_s: string, path: string) => ok(path));
    const cache = new ResolveCache({ fetcher, now: () => 0, maxEntries: 2 });

    await cache.resolve('s', 'a.ts'); // oldest
    await cache.resolve('s', 'b.ts');
    await cache.resolve('s', 'c.ts'); // evicts a.ts
    expect(fetcher).toHaveBeenCalledTimes(3);

    await cache.resolve('s', 'b.ts'); // still warm
    await cache.resolve('s', 'c.ts'); // still warm
    expect(fetcher).toHaveBeenCalledTimes(3);

    await cache.resolve('s', 'a.ts'); // re-fetched, it was evicted
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('never runs more than maxConcurrent fetches at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const releasers: Array<() => void> = [];
    const fetcher = vi.fn((_s: string, path: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<ResolvePathResponse>((res) => {
        releasers.push(() => {
          inFlight--;
          res(ok(path));
        });
      });
    });
    const cache = new ResolveCache({ fetcher, now: () => 0, maxConcurrent: 4 });

    const asks = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => cache.resolve('s', `${n}.ts`));
    // Four slots fill synchronously; the last two queue behind the semaphore.
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(peak).toBe(4);

    // Drain: release one at a time, yielding so a queued fetch can take the slot.
    let settled = false;
    void Promise.all(asks).then(() => {
      settled = true;
    });
    for (let guard = 0; !settled && guard < 100; guard++) {
      await Promise.resolve();
      releasers.shift()?.();
    }

    await Promise.all(asks);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(peak).toBe(4);
  });
});

import { describe, expect, it } from 'vitest';
import {
  findBufferUrlCandidates,
  findUrlCandidates,
} from '../../../src/features/terminal/links/url-links';
import { normaliseCopiedLink } from '../../../src/features/terminal/clipboard/copy-text';
import { bufferWithLines } from '../../helpers/terminal-buffer';

const uri = 'http://100.122.14.32:8767/r/run_name_QRD/S02-yam/motion-profiles.png';

describe('terminal URLs', () => {
  it('joins an indented URL broken after a slash, from either row', () => {
    const rows = [
      { text: '  Open the profiles (http://100.122.14.32:8767/r/' },
      { text: '  run_name_QRD/S02-yam/motion-profiles.png) and the replay.' },
    ];
    const buffer = bufferWithLines(rows, 100);
    for (const row of [0, 1]) {
      expect(findBufferUrlCandidates(buffer, row, 100)[0]).toMatchObject({
        candidate: { uri },
        start: { row: 0, col: 21 },
        end: { row: 1, col: 41 },
      });
    }
  });

  it.each([false, true])('joins mid-token wraps (soft: %s)', (isWrapped) => {
    const buffer = bufferWithLines(
      [{ text: 'https://example.test/long' }, { text: 'er/file?q=1#part', isWrapped }],
      25,
    );
    for (const row of [0, 1])
      expect(findBufferUrlCandidates(buffer, row, 25)[0]?.candidate.uri).toBe(
        'https://example.test/longer/file?q=1#part',
      );
  });

  it('preserves whitespace at soft boundaries', () => {
    const buffer = bufferWithLines(
      [{ text: 'https://example.test/' }, { text: 'next/file.ts', isWrapped: true }],
      24,
    );
    expect(findBufferUrlCandidates(buffer, 0, 24)[0]?.candidate.uri).toBe('https://example.test/');
    expect(findBufferUrlCandidates(buffer, 1, 24)).toEqual([]);
  });

  it.each([
    ['https://example.', 'test/path'],
    ['https://example.test:87', '67/r/file.png'],
    ['https://example.test/path/file.', 'png'],
  ])('joins a hard wrap inside an unfinished URL: %s + %s', (left, right) => {
    const buffer = bufferWithLines([{ text: left }, { text: right }], left.length);
    for (const row of [0, 1])
      expect(findBufferUrlCandidates(buffer, row, left.length)[0]?.candidate.uri).toBe(
        left + right,
      );
  });

  it.each(['  https://other.test/next', '  Next sentence follows.', '', '  ./a/separate/path'])(
    'does not join an independent next line: %j',
    (next) => {
      const buffer = bufferWithLines([{ text: 'https://example.test/' }, { text: next }], 30);
      expect(findBufferUrlCandidates(buffer, 0, 30)[0]?.candidate.uri).toBe(
        'https://example.test/',
      );
    },
  );

  it('keeps neighbouring wrapped links separate', () => {
    const buffer = bufferWithLines(
      [
        { text: '(https://example.test/r/' },
        { text: '  first/image.png) and (https://example.test/r/' },
        { text: '  second/replay/).' },
      ],
      80,
    );
    expect(findBufferUrlCandidates(buffer, 1, 80).map(({ candidate }) => candidate.uri)).toEqual(
      expect.arrayContaining([
        'https://example.test/r/first/image.png',
        'https://example.test/r/second/replay/',
      ]),
    );
  });

  it('keeps query escapes, IPv6 and balanced parentheses, without prose punctuation', () => {
    const text = '(https://[::1]:8767/a_(b)?x=%2F&y=one_two#part).';
    expect(findUrlCandidates(text)).toEqual([
      { uri: text.slice(1, -2), start: 1, end: text.length - 2 },
    ]);
    expect(findUrlCandidates('https:// https://bad:port/path javascript:alert(1)')).toEqual([]);
  });

  it('bounds traversal of unusually long wrapped output', () => {
    const buffer = bufferWithLines(
      [
        { text: 'https://example.test/' },
        ...Array.from({ length: 40 }, () => ({ text: 'x'.repeat(80) })),
      ],
      80,
    );
    expect(findBufferUrlCandidates(buffer, 0, 80).every(({ text }) => text.length <= 2048)).toBe(
      true,
    );
    expect(findBufferUrlCandidates(buffer, 39, 80)).toEqual([]);
  });
});

describe('copying a standalone link', () => {
  it.each([
    `[${uri.replaceAll('_', '\\_')}](<${uri}>)`,
    `[motion profiles](${uri})`,
    `<${uri}>`,
    `  [motion profiles](<${uri}>)\n`,
  ])('copies only the destination of %s', (text) => {
    expect(normaliseCopiedLink(text)).toBe(uri);
  });

  it('unescapes Markdown destinations without decoding URL escapes', () => {
    expect(normaliseCopiedLink('[image](https://example.test/a\\_b?q=%2F)')).toBe(
      'https://example.test/a_b?q=%2F',
    );
    expect(normaliseCopiedLink('[image](https://example.test/a_(b))')).toBe(
      'https://example.test/a_(b)',
    );
  });

  it.each([
    `Open [image](<${uri}>) now.`,
    `[image](${uri}) [replay](https://example.test/)`,
    `[image](${uri})[replay](https://example.test/)`,
    '[file](src/a.ts)',
    '[unsafe](javascript:alert(1))',
    '`[example](https://example.test/)`',
    'first line\n  second line',
    '  literal whitespace  ',
    uri,
  ])('preserves other selections verbatim: %j', (text) => {
    expect(normaliseCopiedLink(text)).toBe(text);
  });
});

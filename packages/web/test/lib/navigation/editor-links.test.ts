/**
 * `editorLinkHost`/`captureHostParam` reach `window`/`localStorage`, which
 * this workspace's vitest project runs under plain Node (no jsdom — see
 * `worktree-queries.test.ts`'s header for the same limitation). What's
 * testable without a DOM: `editorDeepLink` (fully pure), `resolveEditorHost`
 * (the precedence rule, pure), and `parseHostParam` (the `?host=` extraction,
 * pure) — the stateful wrappers around them are thin and exercised manually
 * (see `docs/acceptance/phase-4.md`).
 */
import { describe, expect, it } from 'vitest';
import {
  editorDeepLink,
  parseHostParam,
  resolveEditorHost,
} from '../../../src/lib/navigation/editor-links';

describe('editorDeepLink', () => {
  it('builds a local vscode:// link from an absolute worktree path', () => {
    expect(editorDeepLink('vscode', '/Users/alice/proj', null)).toBe(
      'vscode://file/Users/alice/proj',
    );
  });

  it('builds a local cursor:// link from an absolute worktree path', () => {
    expect(editorDeepLink('cursor', '/Users/alice/proj', null)).toBe(
      'cursor://file/Users/alice/proj',
    );
  });

  it('builds an ssh-remote vscode:// link when a host is supplied', () => {
    expect(editorDeepLink('vscode', '/Users/alice/proj', 'alice@devbox')).toBe(
      'vscode://vscode-remote/ssh-remote+alice@devbox/Users/alice/proj',
    );
  });

  it('builds an ssh-remote cursor:// link when a host is supplied', () => {
    expect(editorDeepLink('cursor', '/Users/alice/proj', 'alice@devbox')).toBe(
      'cursor://vscode-remote/ssh-remote+alice@devbox/Users/alice/proj',
    );
  });

  it('percent-encodes path characters that would break the URI, keeping slashes', () => {
    expect(editorDeepLink('vscode', '/Users/al ice/my proj', null)).toBe(
      'vscode://file/Users/al%20ice/my%20proj',
    );
    // encodeURI would leave # and ? raw (reserved set) — the OS handler
    // would truncate the path at the first one, so they must be escaped.
    expect(editorDeepLink('vscode', '/Users/alice/a#b?c/proj', null)).toBe(
      'vscode://file/Users/alice/a%23b%3Fc/proj',
    );
    expect(editorDeepLink('vscode', '/Users/alice/100%/proj', null)).toBe(
      'vscode://file/Users/alice/100%25/proj',
    );
  });

  it('escapes URI-breaking host characters but keeps @ and : literal', () => {
    // A stray space or # in a free-text host must not truncate the URI…
    expect(editorDeepLink('vscode', '/proj', 'alice @dev#box')).toBe(
      'vscode://vscode-remote/ssh-remote+alice%20@dev%23box/proj',
    );
    // …but user@host:port stays raw — VS Code parses the ssh-remote
    // authority literally, so %40/%3A would break it.
    expect(editorDeepLink('cursor', '/proj', 'alice@devbox:2222')).toBe(
      'cursor://vscode-remote/ssh-remote+alice@devbox:2222/proj',
    );
  });
});

describe('resolveEditorHost', () => {
  it('prefers the client setting over the stored ?host= param', () => {
    expect(resolveEditorHost('alice@setting', 'alice@stored')).toBe('alice@setting');
  });

  it('falls back to the stored param when the setting is unset', () => {
    expect(resolveEditorHost('', 'alice@stored')).toBe('alice@stored');
  });

  it('returns null when neither is set', () => {
    expect(resolveEditorHost('', null)).toBeNull();
  });

  it('trims the setting and treats a whitespace-only setting as unset', () => {
    expect(resolveEditorHost('  alice@setting  ', null)).toBe('alice@setting');
    expect(resolveEditorHost('   ', 'alice@stored')).toBe('alice@stored');
    expect(resolveEditorHost('   ', null)).toBeNull();
  });
});

describe('parseHostParam', () => {
  it('extracts the host from a ?host= query string', () => {
    expect(parseHostParam('?host=alice%40devbox')).toBe('alice@devbox');
  });

  it('returns null when there is no host param', () => {
    expect(parseHostParam('?foo=bar')).toBeNull();
  });

  it('returns null for an empty or whitespace-only host param', () => {
    expect(parseHostParam('?host=')).toBeNull();
    expect(parseHostParam('?host=%20%20')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseHostParam('?host=%20alice%40devbox%20')).toBe('alice@devbox');
  });
});

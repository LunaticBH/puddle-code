import { describe, expect, it } from 'vitest';
import { rewriteTerminalUri } from '../../../src/features/terminal/links/proxy-links';
import { nextStoredHost } from '../../../src/lib/navigation/editor-links';

const SID = 'abc123';

describe('rewriteTerminalUri (SPEC §7 — SSH mode localhost rewrite)', () => {
  it('rewrites host-localhost URLs to the trusted cockpit forwarding landing page', () => {
    expect(rewriteTerminalUri('http://localhost:5173/', SID, true)).toBe(
      `/forward/${SID}/5173?path=%2F`,
    );
    expect(rewriteTerminalUri('http://127.0.0.1:3000/app?x=1#frag', SID, true)).toBe(
      `/forward/${SID}/3000?path=%2Fapp%3Fx%3D1%23frag`,
    );
  });

  it('defaults the port from the scheme when absent', () => {
    expect(rewriteTerminalUri('http://localhost/', SID, true)).toBe(`/forward/${SID}/80?path=%2F`);
  });

  it('leaves everything alone in local mode', () => {
    expect(rewriteTerminalUri('http://localhost:5173/', SID, false)).toBe('http://localhost:5173/');
  });

  it('leaves non-local and non-http URLs alone even in SSH mode', () => {
    expect(rewriteTerminalUri('https://example.com/x', SID, true)).toBe('https://example.com/x');
    expect(rewriteTerminalUri('vscode://file/x', SID, true)).toBe('vscode://file/x');
    expect(rewriteTerminalUri('not a url', SID, true)).toBe('not a url');
  });
});

describe('nextStoredHost (mode switching on the same origin)', () => {
  it('captures the ?host= a connect boot sends', () => {
    expect(nextStoredHost('?host=alice%40devbox', '#invite=abc', null)).toBe('alice@devbox');
  });

  it('clears a stale host on a local CLI boot (#invite= but no ?host=)', () => {
    expect(nextStoredHost('', '#invite=abc', 'alice@devbox')).toBe(null);
  });

  it('keeps the stored host across plain reloads (no token fragment)', () => {
    expect(nextStoredHost('', '', 'alice@devbox')).toBe('alice@devbox');
    expect(nextStoredHost('', '#other=1', 'alice@devbox')).toBe('alice@devbox');
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionGlyph } from '../../src/features/status/SessionGlyph';

describe('session glyph', () => {
  it('uses the foreground agent mark while retaining terminal status styling', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionGlyph, {
        status: 'running',
        kind: 'terminal',
        agentType: null,
        detectedAgentType: 'codex',
      }),
    );
    expect(markup).toContain('aria-label="codex in terminal — status: running"');
    expect(markup).toContain('data-kind="terminal"');
    expect(markup).not.toContain('lucide-square-terminal');
  });

  it.each([null, undefined])(
    'keeps the terminal mark when no agent is detected (%s)',
    (detectedAgentType) => {
      const markup = renderToStaticMarkup(
        createElement(SessionGlyph, {
          status: 'running',
          kind: 'terminal',
          detectedAgentType,
        }),
      );
      expect(markup).toContain('lucide-square-terminal');
      expect(markup).toContain('aria-label="terminal — status: running"');
    },
  );

  it('keeps managed agents tied to their own adapter', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionGlyph, {
        status: 'waiting_input',
        kind: 'agent',
        agentType: 'codex',
        detectedAgentType: 'claude-code',
      }),
    );
    expect(markup).toContain('aria-label="codex — status: waiting input"');
    expect(markup).toContain('data-kind="agent"');
  });
});

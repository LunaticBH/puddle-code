import { describe, expect, it } from 'vitest';
import { structuralCursorRole } from '../../src/features/cursor/use-custom-cursor';

function target(matches: (selector: string) => boolean): Pick<Element, 'closest'> {
  return {
    closest: (selector: string) => (matches(selector) ? ({} as Element) : null),
  };
}

describe('custom cursor roles', () => {
  it('treats every Monaco descendant as text before considering interactivity', () => {
    expect(
      structuralCursorRole(
        target((selector) => selector === '.monaco-editor' || selector.includes('button')),
        '.no-custom-caret',
      ),
    ).toBe('text');
  });

  it('retains interactive and default roles away from Monaco', () => {
    expect(
      structuralCursorRole(
        target((selector) => selector.includes('button')),
        '.no-custom-caret',
      ),
    ).toBe('interactive');
    expect(
      structuralCursorRole(
        target(() => false),
        '.no-custom-caret',
      ),
    ).toBe('default');
  });
});

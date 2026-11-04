import { describe, expect, it } from 'vitest';
import { savedTabPath } from '../../../src/features/workspace/tabs/untitled-save-path';

describe('savedTabPath', () => {
  const saved = (path: string) => ({ path, mtime_ms: 1, size: 0 });

  it("opens a Windows host's saved draft under the case the file is stored in", () => {
    expect(savedTabPath('Docs/notes.md', saved('docs/notes.md'), 'win32')).toBe('docs/notes.md');
  });

  it('keeps the typed path on POSIX, and wherever the answer carries no path', () => {
    expect(savedTabPath('Docs/notes.md', saved('docs/notes.md'), 'posix')).toBe('Docs/notes.md');
    expect(savedTabPath('Docs/notes.md', {}, 'win32')).toBe('Docs/notes.md');
    expect(savedTabPath('Docs/notes.md', saved(''), 'win32')).toBe('Docs/notes.md');
    expect(savedTabPath('Docs/notes.md', undefined, 'win32')).toBe('Docs/notes.md');
  });
});

import { describe, expect, it } from 'vitest';
import { fileTabRevealTarget } from '../../src/features/explorer/file-tab-reveal';

describe('file-tab reveal target', () => {
  it('keeps a worktree file relative to its current worktree root', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'file', session: 's1', path: 'packages/web/src/app.tsx' },
        '/worktrees/main',
        '/worktrees/main',
      ),
    ).toEqual({ directory: '/worktrees/main', path: 'packages/web/src/app.tsx' });
  });

  it('keeps a generated LaTeX PDF within the visible worktree tree', () => {
    expect(
      fileTabRevealTarget(
        {
          kind: 'external',
          session: 's1',
          root: '/worktrees/main/.puddle/latex/0123456789abcdef01234567/current',
          path: 'paper.pdf',
        },
        '/worktrees/main',
        '/worktrees/main',
      ),
    ).toEqual({
      directory: '/worktrees/main',
      path: '.puddle/latex/0123456789abcdef01234567/current/paper.pdf',
    });
  });

  it('keeps an external file within the current parent-directory browse', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'external', session: 's1', root: '/Users/me', path: 'notes/todo.md' },
        '/worktrees/main',
        '/Users',
      ),
    ).toEqual({ directory: '/Users', path: 'me/notes/todo.md' });
  });

  it('keeps a worktree file within the current parent-directory browse', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'file', session: 's1', path: 'src/app.ts' },
        '/worktrees/main',
        '/worktrees',
      ),
    ).toEqual({ directory: '/worktrees', path: 'main/src/app.ts' });
  });

  it('rebases an external file to its containing directory', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'external', session: 's1', root: '/Users/me', path: 'notes/todo.md' },
        '/worktrees/main',
        '/worktrees/main',
      ),
    ).toEqual({
      directory: '/Users/me/notes',
      path: 'todo.md',
      browseRoot: '/Users/me/notes',
    });
  });

  it('keeps an external root-level file at its existing browse root', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'external', session: 's1', root: '/', path: 'README.md' },
        '/worktrees/main',
        '/worktrees/main',
      ),
    ).toEqual({ directory: '/', path: 'README.md', browseRoot: '/' });
  });

  it('does not mistake a matching path prefix for containment', () => {
    expect(
      fileTabRevealTarget(
        { kind: 'external', session: 's1', root: '/worktrees/main-copy', path: 'paper.pdf' },
        '/worktrees/main',
        '/worktrees/main',
      ),
    ).toEqual({
      directory: '/worktrees/main-copy',
      path: 'paper.pdf',
      browseRoot: '/worktrees/main-copy',
    });
  });
});

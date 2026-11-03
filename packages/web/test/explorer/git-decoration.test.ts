import { describe, expect, it } from 'vitest';
import {
  buildStatusMap,
  folderStatus,
  gitDecoration,
} from '../../src/features/explorer/git-decoration';

describe('gitDecoration', () => {
  it('gives untracked/added a green U/A and modified an amber M', () => {
    expect(gitDecoration('untracked')).toEqual({ letter: 'U', colourClass: 'text-success' });
    expect(gitDecoration('added')).toEqual({ letter: 'A', colourClass: 'text-success' });
    expect(gitDecoration('modified')).toEqual({ letter: 'M', colourClass: 'text-warning' });
    expect(gitDecoration('deleted').colourClass).toBe('text-interrupted');
    expect(gitDecoration('conflicted')).toEqual({ letter: 'C', colourClass: 'text-interrupted' });
  });

  it('gives ignored no badge and a muted colour', () => {
    expect(gitDecoration('ignored')).toEqual({ letter: '', colourClass: 'text-fg-muted' });
  });
});

describe('folderStatus roll-up', () => {
  const map = buildStatusMap([
    { path: 'src/a.ts', status: 'modified' },
    { path: 'src/b.ts', status: 'untracked' },
    { path: 'src/deep/c.ts', status: 'conflicted' },
    { path: 'docs/readme.md', status: 'untracked' },
    { path: 'build/out.js', status: 'ignored' },
  ]);

  it('surfaces the highest-priority descendant status', () => {
    expect(folderStatus(map, 'src')).toBe('conflicted'); // beats modified + untracked
    expect(folderStatus(map, 'docs')).toBe('untracked');
  });

  it('does not tint a folder whose only descendants are ignored', () => {
    expect(folderStatus(map, 'build')).toBeNull();
  });

  it('returns null for a clean folder', () => {
    expect(folderStatus(map, 'nowhere')).toBeNull();
  });

  it('rolls the whole worktree up from the empty-string root', () => {
    expect(folderStatus(map, '')).toBe('conflicted');
  });

  it('does not match a sibling folder sharing a name prefix', () => {
    const m = buildStatusMap([{ path: 'source/x.ts', status: 'modified' }]);
    expect(folderStatus(m, 'src')).toBeNull(); // "source/" must not match "src"
  });
});

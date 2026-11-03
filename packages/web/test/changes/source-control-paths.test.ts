import { describe, expect, it } from 'vitest';
import type { GitChangeEntry } from '@puddle/shared';
import { gitEntryPaths } from '../../src/features/changes/source-control-paths';

const entry = (path: string, oldPath: string | null = null): GitChangeEntry => ({
  path,
  old_path: oldPath,
  status: oldPath === null ? 'modified' : 'renamed',
});

describe('gitEntryPaths', () => {
  it('keeps both literal paths for renames and de-duplicates directory descendants', () => {
    expect(
      gitEntryPaths([
        entry('src/a.ts'),
        entry('src/new.ts', 'legacy/old.ts'),
        entry('legacy/old.ts'),
      ]),
    ).toEqual(['src/a.ts', 'src/new.ts', 'legacy/old.ts']);
  });
});

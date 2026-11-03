import { QueryClient } from '@tanstack/react-query';
import type { UntitledFileResponse } from '@puddle/shared';
import { describe, expect, it } from 'vitest';
import { untitledQueryKey, updateCachedUntitled } from '../../../src/lib/queries/untitled-queries';

describe('updateCachedUntitled', () => {
  it('makes the latest Monaco edit the source for a tab remount', () => {
    const queryClient = new QueryClient();
    const key = untitledQueryKey('profile-1', 'untitled-1.md');
    queryClient.setQueryData<UntitledFileResponse>(key, {
      name: 'untitled-1.md',
      content: '',
      mtime_ms: 1,
    });

    updateCachedUntitled(queryClient, 'profile-1', 'untitled-1.md', 'kept across tabs');

    expect(queryClient.getQueryData<UntitledFileResponse>(key)).toEqual({
      name: 'untitled-1.md',
      content: 'kept across tabs',
      mtime_ms: 1,
    });
  });

  it('does not fabricate a loaded response before the GET completes', () => {
    const queryClient = new QueryClient();
    const key = untitledQueryKey('profile-1', 'untitled-1.md');

    updateCachedUntitled(queryClient, 'profile-1', 'untitled-1.md', 'draft');

    expect(queryClient.getQueryData(key)).toBeUndefined();
  });
});

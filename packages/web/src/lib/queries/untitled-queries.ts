import { useQuery, type QueryClient } from '@tanstack/react-query';
import type {
  CreateUntitledResponse,
  PutUntitledResponse,
  UntitledFileResponse,
} from '@puddle/shared';
import { api } from '../transport/api';

/**
 * Untitled drafts (protocol 10.3, SPEC §8): worktree-agnostic scratch files
 * in the profile's `untitled/` store. Created by a blank-strip double-click,
 * persisted continuously while edited, and deleted when saved into a worktree
 * or discarded with their tab.
 */

export function createUntitled(profileId: string): Promise<CreateUntitledResponse> {
  return api<CreateUntitledResponse>('POST', `/api/profiles/${profileId}/untitled`);
}

export function untitledQueryKey(profileId: string | null, name: string) {
  return ['untitled', profileId, name] as const;
}

export function useUntitledFile(profileId: string | null, name: string) {
  return useQuery({
    queryKey: untitledQueryKey(profileId, name),
    queryFn: () => api<UntitledFileResponse>('GET', `/api/profiles/${profileId}/untitled/${name}`),
    enabled: profileId !== null,
    // The open tab's model is the source of truth while editing; never let a
    // background refetch fight the debounced persistence writes.
    staleTime: Infinity,
  });
}

/**
 * Keep the loaded draft's client-side source of truth level with Monaco.
 *
 * Switching tabs unmounts the untitled editor and disposes its private model.
 * The next mount therefore starts from this query entry, which deliberately
 * remains fresh indefinitely while the tab is open. Updating it on every edit
 * prevents that remount from resurrecting the original GET response while the
 * debounced PUT continues to provide durable daemon-side persistence.
 */
export function updateCachedUntitled(
  queryClient: QueryClient,
  profileId: string,
  name: string,
  content: string,
): void {
  queryClient.setQueryData<UntitledFileResponse>(untitledQueryKey(profileId, name), (current) =>
    current === undefined ? current : { ...current, content },
  );
}

export function putUntitled(
  profileId: string,
  name: string,
  content: string,
): Promise<PutUntitledResponse> {
  return api<PutUntitledResponse>('PUT', `/api/profiles/${profileId}/untitled/${name}`, {
    content,
  });
}

export function deleteUntitled(profileId: string, name: string): Promise<void> {
  return api<void>('DELETE', `/api/profiles/${profileId}/untitled/${name}`);
}

import type { HostPathStyle, PutFileResponse } from '@puddle/shared';

/**
 * The path the tab replacing a saved draft opens. A Windows host answers the
 * case the file is stored in (`docs/notes.md` for a typed `Docs/notes.md`
 * saved into an existing `docs/`), which is the identity the file tree and
 * every other tab use; without it the draft's tab and a tab opened from the
 * tree would hold two buffers for one file. A POSIX host's answer echoes what
 * was typed, so the typed path is kept there.
 */
export function savedTabPath(
  typed: string,
  saved: Partial<PutFileResponse> | undefined,
  style: HostPathStyle,
): string {
  return style === 'win32' && typeof saved?.path === 'string' && saved.path !== ''
    ? saved.path
    : typed;
}

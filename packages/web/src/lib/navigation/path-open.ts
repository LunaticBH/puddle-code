/**
 * Bridge the shell-owned command palette to the routed workspace that owns
 * editor tabs and the file-tree browse state. Kept callback-only so shell
 * chrome never imports the workspace or its lazy editor/terminal surfaces.
 */
export type OpenPathHandler = (path: string) => Promise<void>;

let handler: OpenPathHandler | null = null;

/** Register the currently mounted workspace's path opener. */
export function registerOpenPathHandler(next: OpenPathHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Open a user-entered path through the active workspace. */
export async function openPath(path: string): Promise<void> {
  if (!handler) throw new Error('Open a project before opening a path.');
  await handler(path);
}

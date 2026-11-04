/**
 * Which buffer ⌘S saves when the caret is NOT inside Monaco (SPEC §8, §11).
 *
 * The save shortcut is an `editor: true` action: Monaco owns it, bound on the
 * editor instance itself. That is right while you are typing and wrong the
 * moment the focused pane's tab has no Monaco to bind — a rendered markdown or
 * HTML preview — or has one you have not clicked into (a pane focused by its tab
 * chip). ⌘S then fell through to the browser's Save Page, and a preview of a file
 * you were editing beside it simply could not be saved (reported 2026-08-05).
 *
 * So each mounted editor body publishes the save action for its buffer here, and
 * the shell dispatches `editor.save` to the FOCUSED pane's active tab whenever
 * the caret is outside Monaco (`HotkeysHost`). Keyed by the buffer's identity
 * rather than by tab, because a source tab and a preview tab of one file share
 * one buffer and therefore one save; whichever is mounted answers, and they do
 * the same thing.
 *
 * Deliberately monaco-free: the Workspace (eager) computes the key for the
 * focused tab, while the registrations come from inside the lazy editor chunk.
 */

/** The buffer identity a save is registered under — `bufferKey`'s shape, without monaco. */
export function saverKey(session: string, path: string, root?: string): string {
  const base = `${encodeURIComponent(session)}:${encodeURIComponent(path)}`;
  return root === undefined ? base : `${base}:${encodeURIComponent(root)}`;
}

export interface SaverTarget {
  session: string;
  path: string;
  root?: string;
}

type Saver = () => boolean | void | Promise<boolean | void>;
const savers = new Map<string, { target?: SaverTarget; save: Saver }>();

/**
 * Publish the save action for one buffer while its body is mounted. Two bodies
 * may hold the same buffer (source in one pane, preview in another), so the
 * cleanup only removes its OWN entry — a stale unmount must not disarm the
 * body that is still showing the file.
 */
export function registerSaver(key: string, save: Saver, target?: SaverTarget): () => void {
  const entry = { save, ...(target ? { target } : {}) };
  savers.set(key, entry);
  return () => {
    if (savers.get(key) === entry) savers.delete(key);
  };
}

/** Run the save for `key`. False when nothing is mounted for it (nothing happened). */
export function requestSave(key: string | null): boolean {
  if (key === null) return false;
  const entry = savers.get(key);
  if (!entry) return false;
  void entry.save();
  return true;
}

/**
 * Flush mounted, dirty provider inputs before a host-side compile. The entry
 * source is included even when a provider does not repeat its extension in
 * `inputExtensions`; unrelated buffers in the same worktree stay untouched.
 */
export async function saveCompilationInputs(
  source: SaverTarget,
  inputExtensions: ReadonlySet<string>,
): Promise<boolean> {
  const sourceKey = saverKey(source.session, source.path, source.root);
  const pending = [...savers.entries()].flatMap(([key, entry]) => {
    const target = entry.target;
    if (!target || target.session !== source.session || target.root !== source.root) return [];
    const extension = fileExtension(target.path);
    if (key !== sourceKey && !inputExtensions.has(extension)) return [];
    return [Promise.resolve(entry.save())];
  });
  const results = await Promise.all(pending);
  return results.every((result) => result !== false);
}

function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

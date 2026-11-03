import type { CompilationFileTarget } from '@puddle/shared';
import { saverKey } from '../buffers/save-registry';

const runners = new Map<string, Set<() => void>>();
/** The tab play button and notebook header dispatch the same interactive run. */
export function registerNotebookRunner(source: CompilationFileTarget, run: () => void): () => void {
  const key = saverKey(source.session, source.path, source.root);
  const entries = runners.get(key) ?? new Set();
  entries.add(run);
  runners.set(key, entries);
  return () => {
    entries.delete(run);
    if (!entries.size) runners.delete(key);
  };
}
export function runOpenNotebook(source: CompilationFileTarget): boolean {
  const run = runners
    .get(saverKey(source.session, source.path, source.root))
    ?.values()
    .next().value;
  if (!run) return false;
  run();
  return true;
}

import type { EditorTab } from '../editor/tabs/editor-tabs';
import {
  basename,
  dirOf,
  joinAbsolutePath,
  relativePathWithinAbsoluteRoot,
} from './explorer-paths';

export interface FileTabRevealTarget {
  /** Effective absolute root the receiving ExplorerProvider must represent. */
  directory: string;
  /** Root-relative row to expand, select, and scroll into view. */
  path: string;
  /** A browse rebase required before the reveal can be consumed. */
  browseRoot?: string;
}

/**
 * Translate a path-backed tab into the Files tree location that should reveal
 * it. A file already below the visible Files root stays in that tree, regardless
 * of whether its tab is worktree-backed or external. Only an external file
 * outside the visible tree temporarily rebases Files to its containing folder.
 */
export function fileTabRevealTarget(
  tab: EditorTab,
  worktreePath: string,
  currentFiletreeRoot: string | null,
): FileTabRevealTarget {
  const sourceRoot = tab.root ?? worktreePath;
  const absolutePath = joinAbsolutePath(sourceRoot, tab.path);
  if (currentFiletreeRoot !== null) {
    const visiblePath = relativePathWithinAbsoluteRoot(currentFiletreeRoot, absolutePath);
    if (visiblePath !== null) return { directory: currentFiletreeRoot, path: visiblePath };
  }

  if (tab.root === undefined) {
    return { directory: worktreePath, path: tab.path };
  }
  const browseRoot = joinAbsolutePath(tab.root, dirOf(tab.path));
  return { directory: browseRoot, path: basename(tab.path), browseRoot };
}

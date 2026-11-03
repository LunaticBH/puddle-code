import type { EditorTab } from '../tabs/editor-tabs';
import { tabKind } from '../tabs/editor-tabs';
import { requestSave, saverKey } from './save-registry';
import { requestUntitledSave, untitledContent } from './untitled-save-store';

/**
 * Save exactly the editor tab the layout identifies as active.
 *
 * Kept outside Monaco because DOM focus can legitimately lag logical pane
 * focus after clicking a draggable tab chip. Ordinary files publish a saver
 * by buffer identity; untitled drafts publish their live content separately
 * and open the workspace's save-as flow.
 */
export function requestActiveTabSave(tab: EditorTab | null): boolean {
  if (tab === null) return false;
  if (tabKind(tab) === 'untitled') {
    const content = untitledContent(tab.path);
    if (content === undefined) return false;
    requestUntitledSave({ name: tab.path, content });
    return true;
  }
  return requestSave(saverKey(tab.session, tab.path, tab.root));
}

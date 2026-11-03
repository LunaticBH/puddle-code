import type { EditorPosition } from '../../workspace/editor-context';
import { FindWidget } from '../../find/FindWidget';
import type { FindControls } from '../../find/use-find-controls';

/** Render fetched text without acquiring a Monaco model, saver or editor lock. */
export interface TextPreviewProps {
  session: string;
  path: string;
  text: string;
  root?: string;
  focused?: boolean;
  scrollDriver?: boolean;
  scrollReceiver?: boolean;
  scrollChannel?: string;
  onRevealSource?: (position: EditorPosition) => void;
  onOpenFile?: (path: string) => void;
  /** Touch navigation and a separately sandboxed document for the remote app's CSP. */
  mobile?: boolean;
}

export function FindOverlay({ controls }: { controls: FindControls }) {
  if (!controls.open) return null;
  return (
    <FindWidget
      query={controls.query}
      focusKey={controls.focusKey}
      options={controls.options}
      result={controls.result}
      onQueryChange={controls.setQuery}
      onOptionsChange={controls.setOptions}
      onNext={controls.next}
      onPrevious={controls.previous}
      onClose={controls.close}
    />
  );
}

export function editorLine(sourceLine: number, lineCount: number): number {
  return Math.min(lineCount, Math.max(1, Math.floor(sourceLine)));
}

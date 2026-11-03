import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SelectionActions } from '../../components/selection-actions';
import { attachFileTouchSelection } from './file-touch-selection';
import { bindScrollRestoration } from '../editor/previews/scroll-restoration';
import { useViewStateKey } from '../editor/tabs/view-state-context';

export function PhoneFileText({ content, target }: { content: string; target: unknown }) {
  const source = useRef<HTMLPreElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const viewKey = useViewStateKey('phone-source', target);
  const [selected, setSelected] = useState('');
  useLayoutEffect(() => {
    if (!scroller.current || !source.current) return;
    return bindScrollRestoration(scroller.current, source.current, viewKey).dispose;
  }, [viewKey, content]);
  useEffect(() => {
    const element = source.current;
    if (!element) return;
    setSelected('');
    return attachFileTouchSelection(element, setSelected);
  }, [content]);
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} className="h-full overflow-auto overscroll-contain">
        <pre ref={source} className="phone-file-source" tabIndex={0}>
          {content}
        </pre>
      </div>
      {selected && (
        <SelectionActions
          label="Selected file text"
          text={selected}
          clear={() => {
            window.getSelection()?.removeAllRanges();
            setSelected('');
          }}
        />
      )}
    </div>
  );
}

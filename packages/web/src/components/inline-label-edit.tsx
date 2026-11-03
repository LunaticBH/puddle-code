import { useState } from 'react';
import { cn } from '../lib/utils';

/**
 * An in-place editor for a label that is normally just text: it takes the
 * label's own typography and position, so editing happens where reading did —
 * no dialogue, no box (HUMANS.md). Commit on Enter or blur, Esc cancels.
 *
 * Keystrokes stop here: the global hotkey dispatcher listens on `window`, and a
 * name containing `b`, `t`, or a backquote would otherwise trip a shortcut.
 *
 * Used by every label the UI lets you rename in place — the project name and
 * abbreviation in the session sidebar, the host label and profile name in the
 * top bar — each opened by a double-click on the label (and, where there is a
 * menu to hang it on, by a menu item too).
 */
export function InlineLabelEdit({
  initial,
  maxLength,
  className,
  fitContent = false,
  onCommit,
  onCancel,
}: {
  initial: string;
  maxLength?: number;
  className?: string;
  /** Match the rendered text width, updating the surrounding layout while typing. */
  fitContent?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = (
    <input
      autoFocus
      value={value}
      maxLength={maxLength}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onCommit(value);
        else if (e.key === 'Escape') onCancel();
      }}
      className={cn(
        'bg-transparent outline-none',
        fitContent ? 'col-start-1 row-start-1 w-0 min-w-full p-0' : className,
      )}
    />
  );
  if (!fitContent) return input;
  return (
    <span className={cn('inline-grid min-w-px', className)}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre">
        {value || '\u200b'}
      </span>
      {input}
    </span>
  );
}

/**
 * Props for a label that a double-click edits in place. The label usually sits
 * inside something a click already acts on — a link home, a project link, a
 * popover trigger — and the FIRST click of the double-click still does that
 * (navigating, or opening the panel); the second is suppressed via
 * `defaultPrevented`, which both react-router's `Link` and Radix's triggers
 * honour, so the enclosing action does not fire twice.
 */
export function editOnDoubleClick(start: () => void): {
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
} {
  return {
    onClick: (e) => {
      if (e.detail === 2) e.preventDefault();
    },
    onDoubleClick: (e) => {
      e.preventDefault();
      start();
    },
  };
}

import { useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, TextCursorInput } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ImagePasteButton } from './ImagePasteButton';
import { keepTerminalFocus, TerminalKey } from './TerminalKey';
import { TOUCH_MODIFIERS } from '../terminal/input/touch-modifiers';
import {
  focusTerminal,
  sendTerminalInput,
  toggleTerminalModifier,
  useTerminalInputReady,
  useTerminalModifiers,
} from '../terminal/input/input';

export function TerminalKeys({
  session,
  term,
  connected,
  composing,
  toggleComposer,
  insertTarget,
}: {
  session: string;
  term: string;
  connected: boolean;
  composing: boolean;
  toggleComposer(): void;
  insertTarget?: () => ((text: string) => void) | undefined;
}) {
  const ready = useTerminalInputReady(session, term) && connected;
  const modifiers = useTerminalModifiers(session, term);
  const [error, setError] = useState('');
  const send = (data: string) => {
    focusTerminal(session, term);
    void sendTerminalInput(session, term, data).catch((error: Error) => setError(error.message));
  };
  return (
    <>
      <div
        className="phone-keys"
        role="toolbar"
        aria-label="Terminal keys"
        onTouchEnd={keepTerminalFocus(() => focusTerminal(session, term))}
      >
        <ImagePasteButton session={session} term={term} ready={ready} insertTarget={insertTarget} />
        <TerminalKey variant="ghost" disabled={!ready} activate={() => send('\x1b')}>
          Esc
        </TerminalKey>
        {(
          [
            ['Control', '⌃', TOUCH_MODIFIERS.ctrl],
            ['Option', '⌥', TOUCH_MODIFIERS.alt],
            ['Shift', '⇧', TOUCH_MODIFIERS.shift],
          ] as const
        ).map(([label, symbol, bit]) => (
          <TerminalKey
            key={bit}
            variant="ghost"
            disabled={!ready}
            aria-label={label}
            title={label}
            aria-pressed={(modifiers & bit) !== 0}
            activate={() => {
              toggleTerminalModifier(session, term, bit);
              focusTerminal(session, term);
            }}
          >
            <span aria-hidden="true" className="text-base leading-none">
              {symbol}
            </span>
          </TerminalKey>
        ))}
        {[
          { label: 'Left', icon: ArrowLeft, data: '\x1b[D' },
          { label: 'Down', icon: ArrowDown, data: '\x1b[B' },
          { label: 'Up', icon: ArrowUp, data: '\x1b[A' },
          { label: 'Right', icon: ArrowRight, data: '\x1b[C' },
        ].map(({ label, icon: Icon, data }) => (
          <TerminalKey
            key={label}
            variant="ghost"
            aria-label={label}
            disabled={!ready}
            activate={() => send(data)}
          >
            <Icon />
          </TerminalKey>
        ))}
        <TerminalKey variant="ghost" disabled={!ready} activate={() => send('\t')}>
          Tab
        </TerminalKey>
        <TerminalKey variant="ghost" disabled={!ready} activate={() => send('\r')}>
          Enter
        </TerminalKey>
        <TerminalKey variant="ghost" disabled={!ready} activate={() => send('\x03')}>
          Ctrl-C
        </TerminalKey>
        <Button
          variant="ghost"
          aria-label="Compose prompt"
          aria-pressed={composing}
          onClick={toggleComposer}
        >
          <TextCursorInput />
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-2 text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );
}

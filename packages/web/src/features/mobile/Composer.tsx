import { useEffect, useRef, useState } from 'react';
import { browserScope } from '../../lib/transport/browser-transport';
import { sendTerminalInput, useTerminalInputReady } from '../terminal/input/input';

import { Button } from '../../components/ui/button';
import { TerminalKeys } from './TerminalKeys';

/** Keyed by placement + terminal; draft storage never contains submitted history. */
export function Composer({
  session,
  term,
  connected,
  compact = false,
}: {
  session: string;
  term: string;
  connected: boolean;
  compact?: boolean;
}) {
  const ready = useTerminalInputReady(session, term) && connected;
  const storageKey = browserScope(`puddle.phone.draft:${session}:${term}`);
  const [draft, setDraft] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const draftRef = useRef(draft);
  const prompt = useRef<HTMLTextAreaElement>(null);
  // Chosen images go to whichever input was used last: this prompt or its terminal.
  const lastInput = useRef<'terminal' | 'prompt'>('terminal');
  useEffect(() => {
    const focused = (event: FocusEvent) => {
      if ((event.target as Element).classList?.contains('xterm-helper-textarea'))
        lastInput.current = 'terminal';
    };
    document.addEventListener('focusin', focused);
    return () => document.removeEventListener('focusin', focused);
  }, []);
  const [composing, setComposing] = useState(!compact || !!draft);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = (text: string) => {
    draftRef.current = text;
    setDraft(text);
    try {
      if (text) sessionStorage.setItem(storageKey, text);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* The live textarea still retains the draft. */
    }
  };
  // Insert at the draft's caret (or its end once the prompt has closed), never submitting.
  const insertIntoDraft = (text: string) => {
    const current = draftRef.current;
    let before = current.slice(0, prompt.current?.selectionStart ?? current.length);
    const after = current.slice(prompt.current?.selectionEnd ?? current.length);
    if (/\S$/.test(before)) before += ' ';
    if (/^\s/.test(after)) text = text.trimEnd();
    save(before + text + after);
    const caret = before.length + text.length;
    requestAnimationFrame(() => prompt.current?.setSelectionRange(caret, caret));
  };
  const send = async (data: string, paste = false) => {
    if (!ready || busy) return;
    setBusy(true);
    setMessage('');
    try {
      await sendTerminalInput(session, term, data, paste);
      if (paste) save('');
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Delivery is uncertain. Check the terminal before resending.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="phone-composer">
      <TerminalKeys
        session={session}
        term={term}
        connected={connected}
        composing={composing}
        toggleComposer={() => setComposing(!composing)}
        insertTarget={() =>
          composing && lastInput.current === 'prompt' ? insertIntoDraft : undefined
        }
      />
      {composing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft) void send(draft, true);
          }}
        >
          <textarea
            ref={prompt}
            onFocus={() => (lastInput.current = 'prompt')}
            className="rounded-md bg-surface p-2 text-base"
            aria-label="Prompt"
            rows={2}
            value={draft}
            onChange={(e) => save(e.target.value)}
            placeholder="Write a prompt…"
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
          />
          <Button type="submit" disabled={!ready || busy || !draft}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </form>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}

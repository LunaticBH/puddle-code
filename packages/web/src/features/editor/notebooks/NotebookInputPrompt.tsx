import { useEffect, useRef, useState } from 'react';
import type { CompilationFileTarget, NotebookExecution } from '@puddle/shared';
import { api } from '../../../lib/transport/api';

export function NotebookInputPrompt({
  source,
  execution,
  onInterrupt,
}: {
  source: CompilationFileTarget;
  execution: NotebookExecution;
  onInterrupt?: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = execution.input;
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
    field.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  if (!input) return null;
  return (
    <form
      className="mt-2 font-mono text-sm text-fg-secondary"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setPending(true);
        setError(null);
        void api('POST', '/api/notebooks/input', {
          source,
          run_id: execution.id,
          input_id: input.id,
          value,
        })
          .then(() => {
            if (input.password) setValue('');
          })
          .catch((error: unknown) => {
            setError(error instanceof Error ? error.message : 'Input failed');
            submitting.current = false;
            setPending(false);
          });
      }}
    >
      <label className="flex min-w-0 flex-wrap items-baseline">
        <span className="whitespace-pre-wrap break-words">{input.prompt}</span>
        <input
          ref={field}
          aria-label={input.prompt || 'Kernel input'}
          type={input.password ? 'password' : 'text'}
          value={value}
          readOnly={pending}
          maxLength={65536}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (
              onInterrupt &&
              event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.shiftKey &&
              event.key.toLowerCase() === 'c' &&
              event.currentTarget.selectionStart === event.currentTarget.selectionEnd
            ) {
              event.preventDefault();
              event.stopPropagation();
              onInterrupt();
            }
          }}
          className="min-w-16 flex-1 cursor-text bg-transparent p-0 text-fg outline-none read-only:opacity-60"
        />
      </label>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

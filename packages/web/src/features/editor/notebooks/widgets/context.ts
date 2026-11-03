import { createContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  notebookWidgetStateSchema,
  type CompilationFileTarget,
  type NotebookWidgetState,
} from '@puddle/shared';
import { useDaemonVersion } from '../../../../lib/queries/queries';
import { notebookWidgetsSupported } from '../../../../lib/transport/protocol-support';
import { browserTransport } from '../../../../lib/transport/browser-transport';
import type { Notebook } from '../notebook-format';
import { WidgetSession } from './session';

export const WidgetContext = createContext<{
  session: WidgetSession | null;
  saved?: NotebookWidgetState;
} | null>(null);

export function useNotebookWidgets(
  source: CompilationFileTarget,
  notebook: Notebook | null,
  update: ((notebook: Notebook) => void) | undefined,
  enabled: boolean,
) {
  const version = useDaemonVersion();
  const [saveWarning, setSaveWarning] = useState<string>();
  const supported =
    enabled && !browserTransport() && notebookWidgetsSupported(version.data?.protocol);
  const latest = useRef({ notebook, update });
  latest.current = { notebook, update };
  const session = useMemo(
    () =>
      supported
        ? new WidgetSession(source, (state) => {
            const current = latest.current;
            if (!current.notebook || !current.update) return;
            const widgets = current.notebook.metadata.widgets as
              Record<string, unknown> | undefined;
            if (
              JSON.stringify(widgets?.['application/vnd.jupyter.widget-state+json']) ===
              JSON.stringify(state)
            )
              return;
            const next = {
              ...current.notebook,
              metadata: {
                ...current.notebook.metadata,
                widgets: { ...widgets, 'application/vnd.jupyter.widget-state+json': state },
              },
            };
            // A live view remains usable if its state no longer fits the editor's save limit.
            if (JSON.stringify(next).length <= 5 * 1024 * 1024) {
              setSaveWarning(undefined);
              current.update(next);
            } else setSaveWarning('Widget state is too large to save with this notebook.');
          })
        : null,
    [supported, source],
  );
  useEffect(() => {
    session?.start();
    return () => session?.stop();
  }, [session]);
  const saved = useMemo(() => {
    const metadata = notebook?.metadata.widgets as Record<string, unknown> | undefined;
    const parsed = notebookWidgetStateSchema.safeParse(
      metadata?.['application/vnd.jupyter.widget-state+json'],
    );
    return parsed.success && !browserTransport() ? parsed.data : undefined;
  }, [notebook?.metadata.widgets]);
  return { session, saved, saveWarning };
}

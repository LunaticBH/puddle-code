import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CompilationFileTarget,
  NotebookExecutionResponse,
  NotebookExecute,
} from '@puddle/shared';
import { changeNotebookKernel } from '../../../lib/queries/notebook-queries';
import { api } from '../../../lib/transport/api';
import { useDaemonVersion } from '../../../lib/queries/queries';
import {
  notebookExecutionSupported,
  notebookIntelligenceSupported,
} from '../../../lib/transport/protocol-support';
import { browserTransport } from '../../../lib/transport/browser-transport';
import { notebookText, type Notebook } from './notebook-format';
import { mergeNotebookExecution } from './notebook-execution-results';
import { registerNotebookRunner } from './notebook-run-registry';

/** Observe the host's latest run; a lost request or reconnect never submits it again. */
export function useNotebookExecution(
  source: CompilationFileTarget,
  notebook: Notebook | null,
  onChange: ((notebook: Notebook) => void) | undefined,
  enabled: boolean,
) {
  const version = useDaemonVersion();
  const supported =
    enabled && !browserTransport() && notebookExecutionSupported(version.data?.protocol);
  const current = useRef({ notebook, onChange });
  current.current = { notebook, onChange };
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = ['notebook-execution', source];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<NotebookExecutionResponse>('POST', '/api/notebooks/execution', { source }),
    enabled: supported,
    retry: false,
    refetchInterval: (query) => (query.state.data?.execution?.state === 'running' ? 250 : 1500),
  });
  const execution = query.data?.execution;
  useEffect(() => {
    if (!execution || !current.current.notebook || !current.current.onChange) return;
    const next = mergeNotebookExecution(current.current.notebook, execution);
    if (next !== current.current.notebook) current.current.onChange(next);
  }, [execution]);
  const run = async (indices?: number[]) => {
    const document = current.current.notebook;
    if (!supported || !document || submittingRef.current || execution?.state === 'running') return;
    const cells = document.cells.flatMap((cell, index) =>
      cell.cell_type === 'code' &&
      notebookText(cell.source).trim() &&
      (!indices || indices.includes(index))
        ? [{ id: cell.id!, source: notebookText(cell.source) }]
        : [],
    );
    if (!cells.length) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    // Persist identities in the shared draft before asynchronous output can arrive.
    current.current.onChange?.(document);
    try {
      const kernel = document.metadata.kernelspec as { name?: string } | undefined;
      const request: NotebookExecute = {
        source,
        cells,
        ...(kernel?.name ? { kernel: kernel.name } : {}),
      };
      const response = await api<NotebookExecutionResponse>(
        'POST',
        '/api/notebooks/execute',
        request,
      );
      if (mounted.current) queryClient.setQueryData(key, response);
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : 'Notebook execution failed');
    } finally {
      submittingRef.current = false;
      if (mounted.current) {
        setSubmitting(false);
        void queryClient.invalidateQueries({ queryKey: key });
      }
    }
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(
    () =>
      supported
        ? registerNotebookRunner(source, () => {
            void runRef.current();
          })
        : undefined,
    [supported, source.session, source.path, source.root],
  );
  return {
    supported,
    intelligenceSupported: supported && notebookIntelligenceSupported(version.data?.protocol),
    run,
    interrupt: async () => {
      try {
        await changeNotebookKernel({ source, action: 'interrupt' });
      } catch (error) {
        if (mounted.current) setError(error instanceof Error ? error.message : 'Interrupt failed');
      } finally {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    execution,
    busy: submitting || execution?.state === 'running',
    error: error ?? (query.error instanceof Error ? query.error.message : execution?.error),
  };
}

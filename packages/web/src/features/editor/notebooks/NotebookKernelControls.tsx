import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cpu, MoreHorizontal, RotateCcw, Square, X } from 'lucide-react';
import type {
  CompilationFileTarget,
  NotebookKernelAction,
  NotebookKernelSpec,
} from '@puddle/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import {
  changeNotebookKernel,
  useNotebookKernels,
  useNotebookKernelStatus,
} from '../../../lib/queries/notebook-queries';
import {
  notebookKernelsSupported,
  notebookEnvironmentsSupported,
} from '../../../lib/transport/protocol-support';
import { useDaemonVersion } from '../../../lib/queries/queries';
import type { Notebook } from './notebook-format';
import { NotebookEnvironmentPicker } from './NotebookEnvironmentPicker';

const control =
  'flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-1.5 text-xs text-fg-secondary transition-colors hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40';

export function NotebookKernelControls({
  source,
  notebook,
  onSelect,
}: {
  source: CompilationFileTarget;
  notebook: Notebook;
  onSelect: (kernel: NotebookKernelSpec) => void;
}) {
  const selection = useRef(onSelect);
  selection.current = onSelect;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const version = useDaemonVersion();
  const supported = notebookKernelsSupported(version.data?.protocol);
  const environmentsSupported = notebookEnvironmentsSupported(version.data?.protocol);
  const catalogue = useNotebookKernels(supported);
  const status = useNotebookKernelStatus(source, supported);
  const query = useQueryClient();
  const [pendingAction, setPendingAction] = useState<NotebookKernelAction['action'] | null>(null);
  const pending = pendingAction !== null;
  const [error, setError] = useState<string | null>(null);
  if (!supported) return null;
  const metadata = notebook.metadata.kernelspec as { name?: unknown } | undefined;
  const name = status.data?.kernel ?? (typeof metadata?.name === 'string' ? metadata.name : '');
  const kernels = catalogue.data?.kernels ?? [];
  const current = kernels.find((kernel) => kernel.name === name);
  const environment = status.data?.environment;
  const missing =
    environment && !environment.error
      ? [!environment.ipykernel && 'ipykernel', !environment.nbconvert && 'nbconvert']
          .filter(Boolean)
          .join(' and ')
      : '';
  const live = status.data && status.data.state !== 'stopped' && status.data.state !== 'dead';
  const busy = status.data?.state === 'busy' || status.data?.state === 'starting';
  const act = async (action: NotebookKernelAction) => {
    setPendingAction(action.action);
    setError(null);
    try {
      const updated = await changeNotebookKernel(action);
      query.setQueryData(['notebook-kernel', source], updated);
      if (action.action === 'select-python' || action.action === 'install-python') {
        void query.invalidateQueries({ queryKey: ['notebook-environments'] });
        if (mounted.current)
          selection.current({ name: 'python3', display_name: 'Python 3', language: 'python' });
      }
      if (action.action === 'select') {
        const kernel = kernels.find((kernel) => kernel.name === action.kernel);
        if (kernel && mounted.current) selection.current(kernel);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Kernel operation failed');
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <>
      <div className="ml-auto flex items-center gap-1">
        {busy && (
          <button
            type="button"
            className={control}
            disabled={pending}
            onClick={() => void act({ source, action: 'interrupt' })}
          >
            <Square className="size-3.5" />
            Interrupt
          </button>
        )}
        <span className="text-xs text-fg-muted" role="status">
          {pending
            ? pendingAction === 'install-python'
              ? 'Installing…'
              : 'Updating…'
            : status.data?.state === 'dead'
              ? 'Kernel exited'
              : busy
                ? 'Busy'
                : live
                  ? 'Idle'
                  : ''}
        </span>
        {environmentsSupported ? (
          <NotebookEnvironmentPicker
            source={source}
            environment={environment}
            current={current}
            kernels={kernels}
            pending={pending}
            onAction={act}
          />
        ) : (
          <Select
            value={current?.name ?? ''}
            disabled={pending || !catalogue.data?.available || kernels.length === 0}
            onValueChange={(kernel) => void act({ source, action: 'select', kernel })}
          >
            <SelectTrigger
              className="h-7 max-w-52 gap-1.5 bg-transparent text-xs hover:bg-surface"
              aria-label="Select kernel"
              title="Kernels stay alive until shut down. Changing kernels starts fresh."
            >
              <Cpu className="size-3.5 shrink-0" />
              <SelectValue placeholder={name ? `${name} (not installed)` : 'Select Kernel'} />
            </SelectTrigger>
            <SelectContent>
              {kernels.map((kernel) => (
                <SelectItem key={kernel.name} value={kernel.name} detail={kernel.language}>
                  <span>{kernel.display_name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={control}
              disabled={pending}
              aria-label="Kernel actions"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!current && !environment}
              onSelect={() => void act({ source, action: 'restart' })}
            >
              <RotateCcw />
              Restart kernel
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!live}
              onSelect={() => void act({ source, action: 'shutdown' })}
            >
              <X />
              Shut down kernel
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {missing && (
        <div className="flex w-full flex-wrap items-center gap-2 px-2 text-xs text-fg-muted">
          <span className="break-all">
            {missing} missing from {environment?.python}.
          </span>
          <button
            type="button"
            className={control}
            disabled={pending}
            onClick={() => {
              if (environment)
                void act({ source, action: 'install-python', python: environment.python });
            }}
          >
            Install {missing}
          </button>
        </div>
      )}
      {(error ||
        status.data?.error ||
        (!environmentsSupported && (catalogue.data?.error || catalogue.isError)) ||
        status.isError) && (
        <p role="alert" className="w-full px-2 text-xs text-danger">
          {error ?? status.data?.error ?? catalogue.data?.error ?? 'Couldn’t load notebook kernels'}
        </p>
      )}
      {!environmentsSupported &&
        catalogue.data &&
        !catalogue.data.available &&
        !catalogue.data.error && (
          <p className="w-full px-2 text-xs text-fg-muted">
            Install Jupyter and a language kernel on this host to run notebooks.
          </p>
        )}
    </>
  );
}

import { useId, useState } from 'react';
import { Check, Cpu } from 'lucide-react';
import type {
  CompilationFileTarget,
  NotebookEnvironment,
  NotebookKernelAction,
  NotebookKernelSpec,
} from '@puddle/shared';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { Input } from '../../../components/ui/input';
import { useNotebookEnvironments } from '../../../lib/queries/notebook-queries';
import { useHostPathStyle } from '../../../lib/queries/queries';

export function NotebookEnvironmentPicker({
  source,
  environment,
  current,
  kernels,
  pending,
  onAction,
}: {
  source: CompilationFileTarget;
  environment?: NotebookEnvironment;
  current?: NotebookKernelSpec;
  kernels: NotebookKernelSpec[];
  pending: boolean;
  onAction: (action: NotebookKernelAction) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const pathId = useId();
  const windowsHost = useHostPathStyle() === 'win32';
  const catalogue = useNotebookEnvironments(source, open);
  const environments = [...(catalogue.data?.environments ?? [])];
  if (environment && !environments.some((item) => item.python === environment.python))
    environments.unshift(environment);
  const choose = (action: NotebookKernelAction) => {
    setOpen(false);
    void onAction(action);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          aria-label="Select Python environment"
          title={environment?.python ?? 'Changing environments starts a fresh kernel'}
          className="flex max-w-64 cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-fg-secondary hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40"
        >
          <Cpu className="size-3.5 shrink-0" />
          <span className="truncate">
            {environment?.label ?? current?.display_name ?? 'Select environment'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-3">
        <p className="mb-2 text-xs text-fg-muted">Python environments on this host</p>
        <div className="max-h-64 overflow-y-auto" aria-label="Python environments">
          {catalogue.isLoading && (
            <p role="status" className="py-2 text-xs text-fg-muted">
              Looking for environments…
            </p>
          )}
          {catalogue.isError && (
            <p role="alert" className="py-2 text-xs text-danger">
              Couldn’t discover environments. You can enter a path below.
            </p>
          )}
          {catalogue.data && !environments.length && (
            <p className="py-2 text-xs text-fg-muted">
              No Python environments found. Enter a path below.
            </p>
          )}
          {environments.map((item) => (
            <button
              type="button"
              key={item.python}
              disabled={pending}
              onClick={() => choose({ source, action: 'select-python', python: item.python })}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-surface disabled:cursor-default disabled:opacity-40"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs text-fg">{item.label}</p>
                <p className="break-all text-xs text-fg-muted">{item.python}</p>
                {(item.error || !item.ipykernel || !item.nbconvert) && (
                  <p className="text-xs text-fg-secondary">
                    {item.error
                      ? 'Couldn’t inspect this Python'
                      : !item.ipykernel
                        ? 'ipykernel not installed'
                        : 'nbconvert not installed'}
                  </p>
                )}
              </div>
              {environment?.python === item.python && (
                <Check className="size-3.5 shrink-0 text-accent" />
              )}
            </button>
          ))}
          {kernels.length > 0 && (
            <p className="mb-1 mt-3 text-xs text-fg-muted">Registered Jupyter kernels</p>
          )}
          {kernels.map((kernel) => (
            <button
              type="button"
              key={kernel.name}
              disabled={pending}
              className="flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-2 text-left text-xs text-fg-secondary hover:bg-surface hover:text-fg"
              onClick={() => choose({ source, action: 'select', kernel: kernel.name })}
            >
              {kernel.display_name}
              {!environment && current?.name === kernel.name && <Check className="size-3.5" />}
            </button>
          ))}
        </div>
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) choose({ source, action: 'select-python', python: path.trim() });
          }}
        >
          <label htmlFor={pathId} className="text-xs text-fg-secondary">
            Environment folder or Python executable
          </label>
          <Input
            id={pathId}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={
              windowsHost
                ? '.venv, ~\\miniforge3\\envs\\analysis, C:\\path\\to\\python.exe'
                : '.venv, ~/miniforge3/envs/analysis, /path/to/python'
            }
            disabled={pending}
          />
          <p className="text-xs text-fg-muted">
            Relative paths start beside this notebook. Switching starts fresh.
          </p>
          <button
            type="submit"
            disabled={pending || !path.trim()}
            className="cursor-pointer self-end rounded-sm px-2 py-1.5 text-xs text-fg-secondary hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-40"
          >
            Use path
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

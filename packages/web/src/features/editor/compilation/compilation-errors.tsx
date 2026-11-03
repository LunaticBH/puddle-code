import {
  compilationFailureDetailsSchema,
  compilationFailureSchema,
  type CompilationFailure,
} from '@puddle/shared';
import { toast } from 'sonner';
import { ApiError } from '../../../lib/transport/api';
import { setCompilationDiagnostics } from './compilation-diagnostics-store';
import { compilationSourceKey } from './compilation-kind';
import { Disclosure } from '../../../components/ui/disclosure';

/** Publish source markers and one expandable, deduplicated compiler notification. */
export function reportCompilationFailure(owner: string, error: unknown): CompilationFailure {
  const failure = failureFrom(error);
  const diagnosticOwner = failure.source
    ? compilationSourceKey(failure.source.session, failure.source.path, failure.source.root)
    : owner;
  setCompilationDiagnostics(diagnosticOwner, failure.diagnostics ?? []);
  const details = detailText(failure);
  toast.error(failure.message, {
    id: `err:${failure.message}`,
    duration: 20_000,
    ...(details
      ? {
          description: (
            <Disclosure
              summary={
                (failure.diagnostics?.length
                  ? `${failure.diagnostics.length} source diagnostic${failure.diagnostics.length === 1 ? '' : 's'} · `
                  : '') + 'Show compiler output'
              }
            >
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-snug text-fg-secondary">
                {details}
              </pre>
            </Disclosure>
          ),
        }
      : {}),
  });
  return failure;
}

export function failureFrom(error: unknown): CompilationFailure {
  const direct = compilationFailureSchema.safeParse(error);
  if (direct.success) return direct.data;
  if (error instanceof ApiError) {
    const details = compilationFailureDetailsSchema.safeParse(error.details);
    return details.success
      ? { message: error.message, ...details.data }
      : { message: error.message };
  }
  return {
    message:
      error instanceof Error && error.message.trim() !== ''
        ? error.message
        : typeof error === 'string' && error.trim() !== ''
          ? error
          : 'Compilation failed',
  };
}

function detailText(failure: CompilationFailure): string {
  if (failure.output?.trim()) return failure.output.trim();
  return (failure.diagnostics ?? [])
    .map(
      (diagnostic) =>
        `${diagnostic.source.path}:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}: ${diagnostic.message}`,
    )
    .join('\n');
}

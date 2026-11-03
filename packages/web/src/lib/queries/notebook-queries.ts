import { useQuery } from '@tanstack/react-query';
import type {
  CompilationFileTarget,
  NotebookKernelAction,
  NotebookKernelsResponse,
  NotebookKernelStatus,
  NotebookEnvironmentsResponse,
} from '@puddle/shared';
import { api } from '../transport/api';

export function useNotebookKernels(enabled: boolean) {
  return useQuery({
    queryKey: ['notebook-kernels'],
    queryFn: () => api<NotebookKernelsResponse>('GET', '/api/notebooks/kernels'),
    enabled,
    staleTime: 30_000,
  });
}
export function useNotebookKernelStatus(source: CompilationFileTarget, enabled: boolean) {
  return useQuery({
    queryKey: ['notebook-kernel', source],
    queryFn: () => api<NotebookKernelStatus>('POST', '/api/notebooks/status', { source }),
    enabled,
    refetchInterval: 1500,
    retry: false,
  });
}
export function changeNotebookKernel(request: NotebookKernelAction) {
  return api<NotebookKernelStatus>('POST', '/api/notebooks/kernel', request);
}

export function useNotebookEnvironments(source: CompilationFileTarget, enabled: boolean) {
  return useQuery({
    queryKey: ['notebook-environments', source],
    queryFn: () =>
      api<NotebookEnvironmentsResponse>('POST', '/api/notebooks/environments', { source }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

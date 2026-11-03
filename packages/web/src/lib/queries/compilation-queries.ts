import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  CompilationCapabilitiesResponse,
  CompilationDefaultsRequest,
  CompilationDefaultsResponse,
  UpdateCompilationDefaultsRequest,
  CompilationModeRequest,
  CompilationRunRequest,
  CompilationRunResponse,
  CompilationSettingsRequest,
  CompilationSettingsResponse,
  CompilationStatusResponse,
  CompilationTargetRequest,
  UpdateCompilationSettingsRequest,
} from '@puddle/shared';
import { api } from '../transport/api';

/** Providers available on the machine running puddled (which may be an SSH host). */
export function useCompilationCapabilities(enabled: boolean) {
  return useQuery({
    queryKey: ['compilation-capabilities'],
    queryFn: () => api<CompilationCapabilitiesResponse>('GET', '/api/compilation/capabilities'),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** One explicit provider run. */
export function useRunCompilation() {
  return useMutation({
    mutationFn: (request: CompilationRunRequest) =>
      api<CompilationRunResponse>('POST', '/api/compilation/run', request),
  });
}

/** Select on-demand or daemon-observed eager operation for a source. */
export function setCompilationMode(request: CompilationModeRequest) {
  return api<CompilationStatusResponse>('PUT', '/api/compilation/mode', request);
}

/** Poll one eager source without encoding absolute roots into a query string. */
export function compilationStatus(request: CompilationTargetRequest) {
  return api<CompilationStatusResponse>('POST', '/api/compilation/status', request);
}

/** Live status of one registered eager source. */
export function useCompilationStatus(request: CompilationTargetRequest, enabled: boolean) {
  return useQuery({
    queryKey: ['compilation-status', request],
    queryFn: () => compilationStatus(request),
    enabled,
    refetchInterval: 750,
    refetchIntervalInBackground: false,
    retry: 2,
  });
}

/** Project/file-specific command slots and their provider defaults. */
export function useCompilationSettings(request: CompilationSettingsRequest | null) {
  return useQuery({
    queryKey: ['compilation-settings', request],
    queryFn: () => api<CompilationSettingsResponse>('POST', '/api/compilation/settings', request!),
    enabled: request !== null,
    staleTime: 30_000,
  });
}

export function updateCompilationSettings(request: UpdateCompilationSettingsRequest) {
  return api<CompilationSettingsResponse>('PUT', '/api/compilation/settings', request);
}

/** Profile language defaults, available even without an open source file. */
export function useCompilationDefaults(request: CompilationDefaultsRequest | null) {
  return useQuery({
    queryKey: ['compilation-defaults', request],
    queryFn: () => api<CompilationDefaultsResponse>('POST', '/api/compilation/defaults', request!),
    enabled: request !== null,
    staleTime: 30_000,
  });
}

export function updateCompilationDefaults(request: UpdateCompilationDefaultsRequest) {
  return api<CompilationDefaultsResponse>('PUT', '/api/compilation/defaults', request);
}

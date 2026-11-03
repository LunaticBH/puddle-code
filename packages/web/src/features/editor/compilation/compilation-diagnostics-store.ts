import { useCallback, useSyncExternalStore } from 'react';
import type { CompilationDiagnostic, CompilationFileTarget } from '@puddle/shared';

const EMPTY: readonly CompilationDiagnostic[] = [];
const diagnosticsByOwner = new Map<string, readonly CompilationDiagnostic[]>();
const snapshots = new Map<string, readonly CompilationDiagnostic[]>();
const listeners = new Map<string, Set<() => void>>();

/** Replace every marker produced by one compilable source/build target. */
export function setCompilationDiagnostics(
  owner: string,
  diagnostics: readonly CompilationDiagnostic[],
): void {
  const previous = diagnosticsByOwner.get(owner) ?? EMPTY;
  if (diagnostics.length === 0) diagnosticsByOwner.delete(owner);
  else diagnosticsByOwner.set(owner, diagnostics);
  const changedFiles = new Set([
    ...previous.map((diagnostic) => fileKey(diagnostic.source)),
    ...diagnostics.map((diagnostic) => fileKey(diagnostic.source)),
  ]);
  for (const key of changedFiles) refreshFile(key);
}

export function clearCompilationDiagnostics(owner: string): void {
  setCompilationDiagnostics(owner, EMPTY);
}

export function useCompilationDiagnostics(
  session: string,
  path: string,
  root?: string,
): readonly CompilationDiagnostic[] {
  const key = fileKey({ session, path, ...(root !== undefined ? { root } : {}) });
  return useSyncExternalStore(
    useCallback((notify: () => void) => subscribe(key, notify), [key]),
    () => compilationDiagnosticsFor({ session, path, ...(root !== undefined ? { root } : {}) }),
  );
}

export function compilationDiagnosticsFor(
  target: CompilationFileTarget,
): readonly CompilationDiagnostic[] {
  return snapshots.get(fileKey(target)) ?? EMPTY;
}

function refreshFile(key: string): void {
  const next = [...diagnosticsByOwner.values()].flatMap((diagnostics) =>
    diagnostics.filter((diagnostic) => fileKey(diagnostic.source) === key),
  );
  if (next.length === 0) snapshots.delete(key);
  else snapshots.set(key, next);
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  const current = listeners.get(key) ?? new Set();
  current.add(listener);
  listeners.set(key, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

function fileKey(target: CompilationFileTarget): string {
  return JSON.stringify([target.session, target.root ?? null, target.path]);
}

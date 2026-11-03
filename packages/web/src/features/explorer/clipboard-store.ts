import { useSyncExternalStore } from 'react';
import type { HostInfo } from '@puddle/shared';
import { sameHostPath } from '../../lib/host-path';

const STORAGE_KEY = 'puddle.explorerClipboard.v1';

export interface ExplorerClipboardTarget {
  sid: string;
  root?: string;
  /** Effective absolute directory, so two sessions sharing one worktree remain one filetree. */
  directory: string;
  /** Stable daemon-machine identity; absent only while `/api/host` is loading. */
  host?: string;
}

export interface ExplorerClipboardState {
  id: string;
  paths: string[];
  mode: 'cut' | 'copy';
  source: ExplorerClipboardTarget;
}

function isTarget(value: unknown): value is ExplorerClipboardTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.sid === 'string' &&
    typeof target.directory === 'string' &&
    (target.root === undefined || typeof target.root === 'string') &&
    (target.host === undefined || typeof target.host === 'string')
  );
}

function parse(value: string | null): ExplorerClipboardState | null {
  if (value === null) return null;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string' ||
      (candidate.mode !== 'cut' && candidate.mode !== 'copy') ||
      !Array.isArray(candidate.paths) ||
      candidate.paths.length === 0 ||
      !candidate.paths.every((path) => typeof path === 'string') ||
      !isTarget(candidate.source)
    ) {
      return null;
    }
    return candidate as unknown as ExplorerClipboardState;
  } catch {
    return null;
  }
}

function readStored(): ExplorerClipboardState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

let snapshot = readStored();
const listeners = new Set<() => void>();

function emit(next: ExplorerClipboardState | null, persist: boolean): void {
  snapshot = next;
  if (persist && typeof localStorage !== 'undefined') {
    try {
      if (next === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage can be disabled. The in-memory clipboard still works.
    }
  }
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) emit(parse(event.newValue), false);
  });
}

function clipboardId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function hostIdentity(host: HostInfo | undefined): string | undefined {
  return host ? `${host.username}\0${host.hostname}\0${host.home}` : undefined;
}

/**
 * Session ids may differ while their effective worktree directory is
 * identical. Directories compare as host paths: exactly on POSIX, and on a
 * Windows host regardless of case or separator.
 */
export function sameFiletree(a: ExplorerClipboardTarget, b: ExplorerClipboardTarget): boolean {
  return sameHostPath(a.directory, b.directory);
}

/**
 * Never transfer a persisted clipboard to a daemon known to be another host.
 * An absent identity is tolerated only during the brief `/api/host` load.
 */
export function sameDaemonHost(a: ExplorerClipboardTarget, b: ExplorerClipboardTarget): boolean {
  return a.host === undefined || b.host === undefined || a.host === b.host;
}

/** Cross-filetree transfer waits for positive proof that both trees share a daemon host. */
export function confirmedSameDaemonHost(
  a: ExplorerClipboardTarget,
  b: ExplorerClipboardTarget,
): boolean {
  return a.host !== undefined && a.host === b.host;
}

export function setExplorerClipboard(
  paths: string[],
  mode: ExplorerClipboardState['mode'],
  source: ExplorerClipboardTarget,
): void {
  if (paths.length === 0) return;
  emit({ id: clipboardId(), paths, mode, source }, true);
}

/** Complete only the cut operation that started with `expectedId`. */
export function finishExplorerCut(expectedId: string, failedPaths: string[]): void {
  if (snapshot?.id !== expectedId || snapshot.mode !== 'cut') return;
  emit(failedPaths.length === 0 ? null : { ...snapshot, paths: failedPaths }, true);
}

export function getExplorerClipboard(): ExplorerClipboardState | null {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ExplorerClipboardState | null {
  return snapshot;
}

export function useExplorerClipboard(): ExplorerClipboardState | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

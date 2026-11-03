import type { VersionResponse } from '@puddle/shared';

/**
 * Feature gates against the DAEMON's protocol version (PROTOCOL.md rule 3: a
 * client must not send a request an older daemon would answer wrongly). Each
 * gate is named for the capability rather than the number, so a call site reads
 * as intent and the version arithmetic lives in exactly one place.
 *
 * Unknown (the version query still in flight) reads as SUPPORTED throughout —
 * the same stance every gate in the app has taken: skew is rare, the request
 * fails honestly if it turns out to be unsupported, and gating optimistically
 * keeps the UI from flickering its fallbacks on every load.
 */
export type Protocol = VersionResponse['protocol'] | undefined;

/** `protocol` is at least `major.minor` (or unknown — see above). */
export function atLeast(protocol: Protocol, major: number, minor: number): boolean {
  if (!protocol) return true;
  return protocol.major > major || (protocol.major === major && protocol.minor >= minor);
}

/** Empty repository defaults follow the clone's current branch (21.3). */
export const dynamicBaseBranchSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 21, 3);

/** Project name colours (24.5); older hosts silently discard unknown fields. */
export const projectColourSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 24, 5);

/** Modular host-side compilation providers and eager modes (protocol 17.1). */
export function compilationSupported(protocol: Protocol): boolean {
  return atLeast(protocol, 17, 1);
}

/** Per-project, canonical-file compilation command overrides (protocol 17.3). */
export function compilationSettingsSupported(protocol: Protocol): boolean {
  return atLeast(protocol, 17, 3);
}

/** Profile-wide language commands (24.4); never request defaults on an older host. */
export const compilationDefaultsSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 24, 4);

/** Worktree-agnostic untitled drafts in the profile store (10.3). */
export const untitledSupported = (p: Protocol): boolean => atLeast(p, 10, 3);

/** `?root=` on the file READ routes — the parent-directory browse tree (10.2). */
export const browseSupported = (p: Protocol): boolean => atLeast(p, 10, 2);

/**
 * `?root=` on the fs MUTATION routes (12.3). Between 10.2 and 12.3 the browse
 * tree is served but a create/rename/delete would resolve against the worktree,
 * so the tree goes read-only rather than touching the wrong files.
 */
export const browseMutationsSupported = (p: Protocol): boolean => atLeast(p, 12, 3);

/**
 * Directory targets: the nil session id + `?root=`, and `?root=` honoured by the
 * git routes (12.4). Without it the left sidebar has nothing to bind to in a
 * project with no session in focus — an older daemon 404s the nil id and would
 * answer git questions about the wrong repository.
 */
export const directoryTargetSupported = (p: Protocol): boolean => atLeast(p, 12, 4);

/** Multi-repository source control, Git mutations, and editor HEAD baselines (15.3). */
export const sourceControlSupported = (p: Protocol): boolean => atLeast(p, 15, 3);

/**
 * Server-local copy/move between independently addressed filetrees (16.3).
 * Unlike read-only or idempotent gates, unknown is deliberately false: an
 * unsupported cross-tree move must never be sent optimistically to an old
 * daemon. Same-tree paste continues using the pre-existing endpoints.
 */
export const crossFiletreeTransferSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 16, 3);

/** Native catalogue refresh and exact lifecycle switch messages (17.0). */
export const nativeConversationSyncSupported = (p: Protocol): boolean => atLeast(p, 16, 4);

/**
 * The daemon answers agents' OSC 10/11 colour queries from client-reported
 * theme colours (14.1). At or above it the web terminal must NOT answer them
 * itself — the agent would get two replies; below, viewer-side answering is
 * all there is (and misses queries fired before the viewer attached).
 */
export const daemonAnswersColourQueries = (p: Protocol): boolean => atLeast(p, 14, 1);

/** Persistent notebook kernels and lifecycle controls (24.6). */
export const notebookKernelsSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 24, 6);

/** Python environments and explicit package installation (25.1). */
export const notebookEnvironmentsSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 25, 1);

/** Live cell execution and kernel input (25.2). */
export const notebookExecutionSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 25, 2);

/** Kernel completion and inspection (25.3). */
export const notebookIntelligenceSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 25, 3);

/** Live widget comms and retained model state (25.4). */
export const notebookWidgetsSupported = (p: Protocol): boolean =>
  p !== undefined && atLeast(p, 25, 4);

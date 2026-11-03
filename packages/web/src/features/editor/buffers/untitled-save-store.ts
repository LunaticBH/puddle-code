/**
 * The seam between an untitled tab's body (which owns the live content) and
 * the Workspace (which owns the save-as dialogue and the layout tree) —
 * the same module-store pattern as scratchpad-store. ⌘S in an untitled tab
 * calls `requestUntitledSave`; the Workspace registers the handler that opens
 * the pick-a-path dialogue for the currently bound worktree (SPEC §8).
 */

export interface UntitledSaveRequest {
  name: string;
  content: string;
}

let handler: ((req: UntitledSaveRequest) => void) | null = null;
// Live content per open draft, published on every edit, so the discard
// confirmation (and any future save path) never needs to reach into Monaco.
const contents = new Map<string, string>();

export function setUntitledSaveHandler(h: ((req: UntitledSaveRequest) => void) | null): void {
  handler = h;
}

export function requestUntitledSave(req: UntitledSaveRequest): void {
  handler?.(req);
}

export function publishUntitledContent(name: string, content: string): void {
  contents.set(name, content);
}

export function untitledContent(name: string): string | undefined {
  return contents.get(name);
}

export function forgetUntitledContent(name: string): void {
  contents.delete(name);
}

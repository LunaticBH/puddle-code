/**
 * One shared opener for the command palette so any affordance (a ⌘K keypress,
 * the empty pane's ⌘K button, …) drives the single mounted `<CommandPalette>`
 * without faking a keyboard event. Mirrors the shared-mechanism approach of
 * hash-route's `openSettings`.
 */
type Opener = () => void;
let opener: Opener | null = null;

/** The mounted CommandPalette registers its open handler here. */
export function registerCommandPalette(open: Opener): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** Open the command palette from anywhere in the UI. */
export function openCommandPalette(): void {
  opener?.();
}

import type { RevealTarget } from '../../workspace/editor-context';

// A navigation request survives tab remounts in Workspace. Consume the request,
// not the mounted editor, so returning to the tab cannot repeat an old jump.
const consumed = new WeakSet<RevealTarget>();

export function consumeEditorReveal(reveal: RevealTarget): boolean {
  if (consumed.has(reveal)) return false;
  consumed.add(reveal);
  return true;
}

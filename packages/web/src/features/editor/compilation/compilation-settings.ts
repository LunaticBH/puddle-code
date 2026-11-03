import type { CompilationCommandSlot } from '@puddle/shared';

/** The inherited language command, falling back to the source-aware provider default. */
export function commandDefault(slot: CompilationCommandSlot): string | null {
  return slot.inherited_command ?? slot.default_command;
}

/** What the editable field displays: an explicit override, then the live provider default. */
export function commandDraft(slot: CompilationCommandSlot): string {
  return slot.override_command ?? commandDefault(slot) ?? '';
}

/** Saving the exact inherited default clears a redundant durable override. */
export function commandOverride(slot: CompilationCommandSlot, draft: string): string | null {
  const command = draft.trim();
  if (command === '') return null;
  return command === commandDefault(slot) ? null : command;
}

import { useState } from 'react';
import type { CompilationDefaultsResponse, CompilationMode } from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import { commandDefault, commandDraft, commandOverride } from './compilation-settings';

export type CommandChange = { mode: CompilationMode; command: string | null };

/** The same command controls for profile language defaults and per-file overrides. */
export function CompilationCommandForm({
  settings,
  onSave,
  onCancel,
}: {
  settings: CompilationDefaultsResponse;
  onSave: (changes: CommandChange[]) => Promise<void>;
  onCancel?: () => void;
}) {
  // Only edited fields live in state: background refetches can refresh untouched
  // defaults without replacing a command the user is currently writing.
  const [drafts, setDrafts] = useState<Partial<Record<CompilationMode, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = settings.commands.flatMap((slot) => {
    const draft = drafts[slot.mode];
    if (draft === undefined) return [];
    const command = commandOverride(slot, draft);
    return command === slot.override_command ? [] : [{ mode: slot.mode, command }];
  });

  const save = async () => {
    const empty = settings.commands.find(
      (slot) =>
        (drafts[slot.mode] ?? commandDraft(slot)).trim() === '' && commandDefault(slot) !== null,
    );
    if (empty) {
      setError(`${slotLabel(empty.mode)} needs a command or its default.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(changes);
      setDrafts({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t save compilation settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void save();
      }}
    >
      {settings.commands.map((slot) => {
        const value = drafts[slot.mode] ?? commandDraft(slot);
        const defaultCommand = commandDefault(slot);
        const usingDefault = value === (defaultCommand ?? '');
        return (
          <div key={slot.mode} className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-fg">{slotLabel(slot.mode)}</span>
              <span className="text-xs leading-relaxed text-fg-muted">
                {slot.mode === 'on_demand'
                  ? 'Runs when you click the play icon.'
                  : 'Runs when eager mode starts, then after the file or a discovered dependency changes on disk.'}
              </span>
              <textarea
                rows={3}
                spellCheck={false}
                disabled={saving}
                value={value}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [slot.mode]: event.target.value }))
                }
                className="resize-y rounded-md bg-surface px-2.5 py-2 font-mono text-xs leading-relaxed text-fg outline-none transition-colors hover:bg-ground focus:bg-ground disabled:opacity-50"
                aria-label={`${slotLabel(slot.mode)} command`}
              />
            </label>
            <div className="flex min-h-6 items-center justify-between gap-3 text-xs text-fg-muted">
              <span>
                {usingDefault
                  ? slot.inherited_command
                    ? 'Using the language default'
                    : defaultCommand
                      ? 'Using the provider default'
                      : 'No provider default available on this host'
                  : 'Custom command'}
              </span>
              {(!usingDefault || slot.override_command !== null) && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    setDrafts((current) => ({ ...current, [slot.mode]: defaultCommand ?? '' }))
                  }
                  className="cursor-pointer rounded-sm px-1.5 py-0.5 text-fg-secondary transition-colors hover:bg-surface hover:text-fg disabled:cursor-default disabled:opacity-50"
                >
                  Use default
                </button>
              )}
            </div>
          </div>
        );
      })}
      {settings.variables.length > 0 && (
        <p className="text-xs leading-relaxed text-fg-muted">
          Available values:{' '}
          {settings.variables.map((variable, index) => (
            <span key={variable.placeholder} title={variable.description}>
              {index > 0 && ' · '}
              <code className="font-mono text-fg-secondary">{variable.placeholder}</code>
            </span>
          ))}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={saving || (!onCancel && Object.keys(drafts).length === 0)}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

function slotLabel(mode: CompilationMode): string {
  return mode === 'on_demand' ? 'When clicked' : 'Upon file change';
}

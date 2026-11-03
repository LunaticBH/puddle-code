import { describe, expect, it } from 'vitest';
import {
  commandDraft,
  commandOverride,
} from '../../../src/features/editor/compilation/compilation-settings';

const slot = {
  mode: 'on_demand' as const,
  run_when: 'when_clicked' as const,
  default_command: 'latexmk {{source}}',
  override_command: null,
};

describe('compilation command drafts', () => {
  it('starts from an override, then a provider default', () => {
    expect(commandDraft(slot)).toBe('latexmk {{source}}');
    expect(commandDraft({ ...slot, override_command: 'tectonic {{source}}' })).toBe(
      'tectonic {{source}}',
    );
  });

  it('stores custom text and clears a redundant default override', () => {
    expect(commandOverride(slot, ' custom {{source}} ')).toBe('custom {{source}}');
    expect(
      commandOverride({ ...slot, override_command: 'custom {{source}}' }, 'latexmk {{source}}'),
    ).toBeNull();
  });

  it('shows language defaults below file overrides and resets back to inheritance', () => {
    const inherited = { ...slot, inherited_command: 'profile-tex {{source}}' };
    expect(commandDraft(inherited)).toBe('profile-tex {{source}}');
    expect(commandDraft({ ...inherited, override_command: 'file-tex {{source}}' })).toBe(
      'file-tex {{source}}',
    );
    expect(commandOverride(inherited, 'profile-tex {{source}}')).toBeNull();
    expect(commandOverride(inherited, 'latexmk {{source}}')).toBe('latexmk {{source}}');
    expect(commandDraft({ ...inherited, inherited_command: null })).toBe('latexmk {{source}}');
  });
});

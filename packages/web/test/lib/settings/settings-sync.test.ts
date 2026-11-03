import { describe, expect, it } from 'vitest';
import { decodeSettings, encodeSettings } from '../../../src/lib/settings/settings-sync';

describe('settings-sync codec', () => {
  const sample = {
    theme: 'dark',
    uiFontSize: 16,
    hotkeys: { 'tab.close': 'meta+alt+KeyW', 'nav.files': 'meta+shift+KeyE' },
    templates: { onboarding: 'read the notes — "quotes" & symbols ✓' },
    nested: { list: [1, 2, 3], flag: false },
  };

  it('round-trips an object exactly', async () => {
    const blob = await encodeSettings(sample);
    expect(await decodeSettings(blob)).toEqual(sample);
  });

  it('a fresh encode uses a random shift but still decodes', async () => {
    const a = await encodeSettings(sample);
    const b = await encodeSettings(sample);
    expect(await decodeSettings(a)).toEqual(sample);
    expect(await decodeSettings(b)).toEqual(sample);
  });

  it('rejects a corrupted blob via the checksum', async () => {
    const blob = await encodeSettings({ a: 1 });
    const last = blob.at(-1);
    const corrupt = blob.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    await expect(decodeSettings(corrupt)).rejects.toThrow(/corrupt|export/i);
  });

  it('rejects non-export text', async () => {
    await expect(decodeSettings('«not a settings export»')).rejects.toThrow(/export/i);
  });
});

/**
 * The native-DnD tab payload (SPEC §8): file rows and session rows encode a
 * TabRef on drag start; panes decode-and-validate on drop. Foreign or corrupt
 * data (another app's drag, a stale format) must decode to null, never throw.
 */
import { describe, expect, it } from 'vitest';
import type { TabRef } from '@puddle/shared';
import {
  decodeTabTransfer,
  encodeTabTransfer,
  hasTabTransfer,
  TAB_MIME,
} from '../../../src/features/workspace/tabs/tab-transfer';

const SID = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('tab transfer payload', () => {
  it('round-trips an editor ref and a terminal ref', () => {
    const file: TabRef = { type: 'editor', tab: { kind: 'file', session: SID, path: 'src/a.ts' } };
    const term: TabRef = { type: 'terminal', session: SID };
    expect(decodeTabTransfer(encodeTabTransfer(file))).toEqual(file);
    expect(decodeTabTransfer(encodeTabTransfer(term))).toEqual(term);
  });

  it('rejects foreign and corrupt payloads with null, never a throw', () => {
    expect(decodeTabTransfer('')).toBeNull();
    expect(decodeTabTransfer('{not json')).toBeNull();
    expect(
      decodeTabTransfer(JSON.stringify({ type: 'terminal', session: 'not-a-uuid' })),
    ).toBeNull();
    expect(decodeTabTransfer(JSON.stringify({ type: 'nonsense' }))).toBeNull();
  });

  it('detects the mime among dragover types', () => {
    expect(hasTabTransfer([TAB_MIME, 'text/plain'])).toBe(true);
    expect(hasTabTransfer(['text/plain', 'Files'])).toBe(false);
  });
});

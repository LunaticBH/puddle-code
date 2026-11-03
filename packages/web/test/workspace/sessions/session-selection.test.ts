import { describe, expect, it } from 'vitest';
import {
  decodeSessionDrag,
  encodeSessionDrag,
  hasSessionDrag,
  nextSessionSelection,
  retainVisibleSessions,
  sessionsForDrag,
  SESSION_DRAG_MIME,
} from '../../../src/features/workspace/sessions/session-selection';

const A = '3b241101-e2bb-4255-8caf-4136c566a961';
const B = '3b241101-e2bb-4255-8caf-4136c566a962';
const C = '3b241101-e2bb-4255-8caf-4136c566a963';
const D = '3b241101-e2bb-4255-8caf-4136c566a964';
const visible = [A, B, C, D];

describe('session sidebar selection', () => {
  it('makes an ordinary click the selection and range anchor', () => {
    const next = nextSessionSelection(visible, new Set([A, B]), A, C, {
      shift: false,
      toggle: false,
    });
    expect([...next.selection]).toEqual([C]);
    expect(next.anchor).toBe(C);
  });

  it('selects the inclusive visual range in either direction', () => {
    const forwards = nextSessionSelection(visible, new Set([B]), B, D, {
      shift: true,
      toggle: false,
    });
    expect([...forwards.selection]).toEqual([B, C, D]);
    expect(forwards.anchor).toBe(B);

    const backwards = nextSessionSelection(visible, forwards.selection, D, B, {
      shift: true,
      toggle: false,
    });
    expect([...backwards.selection]).toEqual([B, C, D]);
    expect(backwards.anchor).toBe(D);
  });

  it('toggles individual sessions with the platform modifier', () => {
    const added = nextSessionSelection(visible, new Set([A]), A, C, {
      shift: false,
      toggle: true,
    });
    expect([...added.selection]).toEqual([A, C]);

    const removed = nextSessionSelection(visible, added.selection, C, A, {
      shift: false,
      toggle: true,
    });
    expect([...removed.selection]).toEqual([C]);
  });

  it('falls back to the target when the range anchor is no longer visible', () => {
    const next = nextSessionSelection(visible, new Set([A]), 'gone', C, {
      shift: true,
      toggle: false,
    });
    expect([...next.selection]).toEqual([C]);
    expect(next.anchor).toBe(C);
  });

  it('prunes sessions that leave the visible list without churning an unchanged set', () => {
    const current = new Set([A, C]);
    expect(retainVisibleSessions(current, visible)).toBe(current);
    expect([...retainVisibleSessions(current, [B, C, D])]).toEqual([C]);
  });
});

describe('multi-session drag', () => {
  it('carries a selected batch in visual order and an unselected row alone', () => {
    const selected = new Set([D, B]);
    expect(sessionsForDrag(visible, selected, D)).toEqual([B, D]);
    expect(sessionsForDrag(visible, selected, A)).toEqual([A]);
  });

  it('round-trips valid ids, deduplicates them, and rejects corrupt payloads', () => {
    expect(decodeSessionDrag(encodeSessionDrag([A, B, A]))).toEqual([A, B]);
    expect(decodeSessionDrag('')).toEqual([]);
    expect(decodeSessionDrag(JSON.stringify([A, 'not-a-session-id']))).toEqual([]);
  });

  it('detects its MIME type among other native drag types', () => {
    expect(hasSessionDrag(['text/plain', SESSION_DRAG_MIME])).toBe(true);
    expect(hasSessionDrag(['text/plain'])).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { macLineEditSequence } from '../../../src/features/terminal/input/line-edit-shortcut';

function key(
  value: string,
  over: Partial<Parameters<typeof macLineEditSequence>[0]> = {},
): Parameters<typeof macLineEditSequence>[0] {
  return {
    type: 'keydown',
    key: value,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...over,
  };
}

describe('macLineEditSequence', () => {
  it('maps Command line-boundary and deletion gestures', () => {
    expect(macLineEditSequence(key('ArrowLeft', { metaKey: true }))).toBe('\x01');
    expect(macLineEditSequence(key('ArrowRight', { metaKey: true }))).toBe('\x05');
    expect(macLineEditSequence(key('Backspace', { metaKey: true }))).toBe('\x15');
    expect(macLineEditSequence(key('Delete', { metaKey: true }))).toBe('\x0b');
  });

  it('maps Option arrows to portable word movement', () => {
    expect(macLineEditSequence(key('ArrowLeft', { altKey: true }))).toBe('\x1bb');
    expect(macLineEditSequence(key('ArrowRight', { altKey: true }))).toBe('\x1bf');
  });

  it('leaves keyup, modified combinations, and unrelated keys to xterm', () => {
    expect(macLineEditSequence(key('ArrowLeft', { altKey: true, type: 'keyup' }))).toBeNull();
    expect(macLineEditSequence(key('ArrowLeft', { altKey: true, shiftKey: true }))).toBeNull();
    expect(macLineEditSequence(key('ArrowLeft', { altKey: true, ctrlKey: true }))).toBeNull();
    expect(macLineEditSequence(key('ArrowLeft', { altKey: true, metaKey: true }))).toBeNull();
    expect(macLineEditSequence(key('x', { altKey: true }))).toBeNull();
  });
});

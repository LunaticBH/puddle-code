import { describe, expect, it } from 'vitest';
import {
  TOUCH_MODIFIERS,
  touchModifiedInput,
} from '../../../src/features/terminal/input/touch-modifiers';

describe('touch terminal modifiers', () => {
  it('sends hardware-equivalent control and option chords', () => {
    expect(touchModifiedInput('c', 1)).toBe('\x03');
    expect(touchModifiedInput('D', 1)).toBe('\x04');
    expect(touchModifiedInput(' ', 1)).toBe('\x00');
    expect(touchModifiedInput('[', 1)).toBe('\x1b');
    expect(touchModifiedInput('b', 2)).toBe('\x1bb');
    expect(touchModifiedInput('c', 3)).toBe('\x1b\x03');
  });
  it('keeps Unicode intact and encodes modified arrow keys', () => {
    expect(touchModifiedInput('日本語 🌊', 0)).toBe('日本語 🌊');
    expect(touchModifiedInput('🌊', 1)).toBe('🌊');
    expect(touchModifiedInput('\x1b[D', 1)).toBe('\x1b[1;5D');
    expect(touchModifiedInput('\x1b[C', 2)).toBe('\x1b[1;3C');
    expect(touchModifiedInput('\x1b[A', 3)).toBe('\x1b[1;7A');
  });
  it.each([
    [TOUCH_MODIFIERS.shift, 2],
    [TOUCH_MODIFIERS.alt, 3],
    [TOUCH_MODIFIERS.shift | TOUCH_MODIFIERS.alt, 4],
    [TOUCH_MODIFIERS.ctrl, 5],
    [TOUCH_MODIFIERS.shift | TOUCH_MODIFIERS.ctrl, 6],
    [TOUCH_MODIFIERS.alt | TOUCH_MODIFIERS.ctrl, 7],
    [TOUCH_MODIFIERS.shift | TOUCH_MODIFIERS.alt | TOUCH_MODIFIERS.ctrl, 8],
  ])('encodes every arrow in normal and application mode (mask %s)', (mask, parameter) => {
    for (const direction of 'ABCD') {
      for (const introducer of ['[', 'O']) {
        expect(touchModifiedInput(`\x1b${introducer}${direction}`, mask)).toBe(
          `\x1b[1;${parameter}${direction}`,
        );
      }
    }
  });
  it('combines latched modifiers with already modified hardware arrows', () => {
    expect(touchModifiedInput('\x1b[1;2D', TOUCH_MODIFIERS.ctrl)).toBe('\x1b[1;6D');
    expect(touchModifiedInput('\x1b[1;2D', TOUCH_MODIFIERS.shift)).toBe('\x1b[1;2D');
  });
  it('encodes Shift-Tab, Shift-Enter, Opt-Enter and Opt-Escape', () => {
    expect(touchModifiedInput('\t', TOUCH_MODIFIERS.shift)).toBe('\x1b[Z');
    expect(touchModifiedInput('\r', TOUCH_MODIFIERS.shift)).toBe('\x1b[13;2u');
    expect(touchModifiedInput('\r', TOUCH_MODIFIERS.shift | TOUCH_MODIFIERS.ctrl)).toBe(
      '\x1b[13;6u',
    );
    expect(touchModifiedInput('\r', TOUCH_MODIFIERS.alt)).toBe('\x1b\r');
    expect(touchModifiedInput('\x1b', TOUCH_MODIFIERS.alt)).toBe('\x1b\x1b');
  });
  it('shifts single printable keys without changing composed text', () => {
    expect(touchModifiedInput('a', TOUCH_MODIFIERS.shift)).toBe('A');
    expect(touchModifiedInput('A', TOUCH_MODIFIERS.shift)).toBe('A');
    expect(touchModifiedInput('1', TOUCH_MODIFIERS.shift)).toBe('!');
    expect(touchModifiedInput('/', TOUCH_MODIFIERS.shift)).toBe('?');
    expect(touchModifiedInput('Hello 日本語 🌊', TOUCH_MODIFIERS.shift)).toBe('Hello 日本語 🌊');
  });
});

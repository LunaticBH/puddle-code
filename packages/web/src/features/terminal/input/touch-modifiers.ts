export const TOUCH_MODIFIERS = { ctrl: 1, alt: 2, shift: 4 } as const;

// Only recognised key sequences may consume modifiers; xterm also emits device
// replies and mouse reports through onData. CSI and SS3 are both cursor keys.
const ARROW = /^(?:\[[ABCD]|O[ABCD]|\[1;([2-8])[ABCD])$/;
const arrowMatch = (data: string) => (data.startsWith('\x1b') ? ARROW.exec(data.slice(1)) : null);
export function isModifiableInput(data: string): boolean {
  return (
    !data.startsWith('\x1b') || data === '\x1b' || arrowMatch(data) !== null || data === '\x1b[Z'
  );
}

/** One-shot touch modifiers: xterm cursor encoding and CSI-u for modified Enter. */
export function touchModifiedInput(data: string, modifiers: number): string {
  if (!modifiers) return data;
  const ctrl = (modifiers & TOUCH_MODIFIERS.ctrl) !== 0;
  const alt = (modifiers & TOUCH_MODIFIERS.alt) !== 0;
  const shift = (modifiers & TOUCH_MODIFIERS.shift) !== 0;
  const mask = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0);
  const arrow = arrowMatch(data);
  if (arrow) {
    const existing = arrow[1] ? Number(arrow[1]) - 1 : 0;
    return `\x1b[1;${1 + (mask | existing)}${data.slice(-1)}`;
  }
  if (!isModifiableInput(data)) return data;
  if (data === '\t' || data === '\x1b[Z') return shift || data === '\x1b[Z' ? '\x1b[Z' : '\t';
  if (data === '\r' && shift) return `\x1b[13;${1 + mask}u`;
  // Shift is a key modifier, not a transformation of pasted or composed text.
  if (shift && data.length === 1) {
    const plain = "`1234567890-=[]\\;',./";
    const shifted = '~!@#$%^&*()_+{}|:"<>?';
    const index = plain.indexOf(data);
    if (index !== -1) data = shifted[index]!;
    else if (/[a-z]/.test(data)) data = data.toUpperCase();
  }
  if (ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
    else if (data === ' ') data = '\x00';
    else if (data === '?') data = '\x7f';
  }
  return alt ? `\x1b${data}` : data;
}

export function isArrowInput(data: string): boolean {
  return (
    data.length === 3 &&
    (data.startsWith('\x1b[') || data.startsWith('\x1bO')) &&
    'ABCD'.includes(data[2]!)
  );
}

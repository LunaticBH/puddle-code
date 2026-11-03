import { browserScope, browserTransport } from '../../../lib/transport/browser-transport';
import { wsManager } from '../../../lib/transport/ws';
import { useSyncExternalStore } from 'react';
import { isArrowInput, isModifiableInput, touchModifiedInput } from './touch-modifiers';

type PasteEncoder = (text: string) => string;
const encoders = new Map<string, PasteEncoder>();
const focusers = new Map<string, () => void>();
const cursorModes = new Map<string, () => boolean>();
const modifiers = new Map<string, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const changed = () => {
  for (const listener of listeners) listener();
};
const key = (session: string, term: string) => browserScope(JSON.stringify([session, term]));
export function useTerminalInputReady(session: string, term: string): boolean {
  return useSyncExternalStore(subscribe, () => encoders.has(key(session, term)));
}
export function registerTerminalInput(
  session: string,
  term: string,
  encode: PasteEncoder,
  focus?: () => void,
  applicationCursorKeys?: () => boolean,
): () => void {
  const id = key(session, term);
  encoders.set(id, encode);
  if (focus) focusers.set(id, focus);
  if (applicationCursorKeys) cursorModes.set(id, applicationCursorKeys);
  else cursorModes.delete(id);
  changed();
  return () => {
    if (encoders.get(id) === encode) {
      encoders.delete(id);
      focusers.delete(id);
      cursorModes.delete(id);
      modifiers.delete(id);
      changed();
    }
  };
}
export function focusTerminal(session: string, term: string): void {
  focusers.get(key(session, term))?.();
}
export function useTerminalModifiers(session: string, term: string): number {
  return useSyncExternalStore(subscribe, () => modifiers.get(key(session, term)) ?? 0);
}
export function toggleTerminalModifier(session: string, term: string, bit: number): void {
  const id = key(session, term);
  modifiers.set(id, (modifiers.get(id) ?? 0) ^ bit);
  changed();
}
export function consumeTerminalModifiers(session: string, term: string, data: string): string {
  const id = key(session, term);
  const value = modifiers.get(id) ?? 0;
  if (!value) return data;
  // Device-query replies and mouse reports are not user keystrokes.
  if (!isModifiableInput(data)) return data;
  modifiers.delete(id);
  changed();
  return touchModifiedInput(data, value);
}
export async function sendTerminalInput(
  session: string,
  term: string,
  text: string,
  paste = false,
): Promise<void> {
  const id = key(session, term);
  const encode = encoders.get(id);
  if (!encode) throw new Error('Wait for the terminal to attach; nothing was sent');
  let data = paste ? `${encode(text)}\r` : consumeTerminalModifiers(session, term, text);
  if (!paste && isArrowInput(data) && cursorModes.get(id)?.()) data = `\x1bO${data.slice(-1)}`;
  await writeTerminalInput(session, term, data);
}

/** Explicit touch-menu paste: use xterm's encoder without the composer's trailing Enter. */
export async function pasteTerminalClipboard(
  session: string,
  term: string,
  active: () => boolean,
): Promise<void> {
  const id = key(session, term);
  const encode = encoders.get(id);
  const transport = browserTransport();
  const generation = transport?.generation;
  if (!encode || !active() || !wsManager.isConnected())
    throw new Error('Wait for the terminal to attach; nothing was pasted.');
  let text: string;
  try {
    // Start the read and focus inside the user's tap, before yielding to a browser permission prompt.
    const reading = navigator.clipboard.readText();
    focusTerminal(session, term);
    text = await reading;
  } catch {
    throw new Error(
      'Could not read the clipboard. Allow clipboard access or use your keyboard’s Paste action.',
    );
  }
  if (
    !active() ||
    encoders.get(id) !== encode ||
    browserTransport() !== transport ||
    transport?.generation !== generation ||
    !wsManager.isConnected()
  )
    throw new Error('The terminal changed; nothing was pasted. Try again in the active terminal.');
  if (text) await writeTerminalInput(session, term, encode(text));
}

async function writeTerminalInput(session: string, term: string, data: string): Promise<void> {
  const remote = browserTransport();
  if (remote) await remote.input(session, term, data);
  else {
    if (!wsManager.isConnected()) throw new Error('Terminal is disconnected; nothing was sent');
    wsManager.write(session, term, data);
  }
}

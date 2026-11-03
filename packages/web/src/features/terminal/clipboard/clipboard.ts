import { isControlC, isCopyShortcut, type CopyKeyEvent } from './copy-shortcut';
import { normaliseCopiedLink } from './copy-text';

interface ClipboardOptions {
  isMac: boolean;
  selection(): string;
  mouseTracking(): boolean;
  available(): boolean;
  writeInput(data: string): void;
  /** Called during the user gesture, including when the text arrives later. */
  writeClipboard(text: string | Promise<string>): void;
}

/**
 * Bridge explicit copy gestures to OSC 52 replies. Unsolicited writes remain
 * stashed: applications which copy on selection must not overwrite the browser
 * clipboard merely because the user highlighted text.
 */
export function terminalClipboard(options: ClipboardOptions) {
  let stash: string | null = null;
  let pending: { resolve(text: string): void; cancel(): void } | null = null;
  const cancel = () => {
    pending?.cancel();
    pending = null;
  };
  const reset = () => {
    cancel();
    stash = null;
  };
  const controller = {
    reset,
    input(data: string) {
      // Mouse reports (including wheel scrolling) do not dismiss selection.
      if (!data.startsWith('\x1b[<') && !data.startsWith('\x1b[M')) reset();
    },
    osc(data: string) {
      if (!options.available()) {
        reset();
        return true;
      }
      const semi = data.indexOf(';');
      if (semi < 0) return true;
      const payload = data.slice(semi + 1);
      if (payload === '?') return true; // never read or send the client clipboard
      if (!payload) {
        reset();
        return true;
      }
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        stash = normaliseCopiedLink(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (stash) pending?.resolve(stash);
        cancel();
      } catch {
        reset(); // malformed data must not leave an older selection available
      }
      return true;
    },
    key(event: CopyKeyEvent): boolean {
      const local = normaliseCopiedLink(options.selection());
      const text = local || stash;
      const copy = isCopyShortcut(event, options.isMac, !!text);
      const controlC = isControlC(event);
      if (!copy && !controlC) return false;
      if (local) {
        // Local scrollback remains copyable while the host is disconnected.
        cancel();
        options.writeClipboard(local);
        return true;
      }
      if (!options.available()) {
        reset();
        return copy;
      }
      if (text) {
        cancel();
        options.writeClipboard(text);
        return true;
      }
      if (!options.mouseTracking()) return false;

      cancel();
      // Reserve the clipboard write while browser user activation is live.
      // The application responds after a PTY/transport round trip. A single
      // bounded request cannot authorise later copies or survive other input.
      const response = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cancel();
        }, 2000);
        pending = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          cancel: () => {
            clearTimeout(timer);
            reject(new DOMException('Copy cancelled', 'AbortError'));
          },
        };
      });
      options.writeClipboard(response);
      // CSI-u preserves the actual copy chord. In particular Command+C must
      // never become Ctrl-C and accidentally interrupt an unselected TUI.
      options.writeInput(controlC ? '\x03' : options.isMac ? '\x1b[99;9u' : '\x1b[99;6u');
      return true;
    },
    copy(event: ClipboardEvent) {
      const local = normaliseCopiedLink(options.selection());
      const text = local || stash;
      if (!local && !options.available()) return;
      // Desktop Edit → Copy can arrive without a DOM keydown.
      if (!text) {
        if (
          controller.key({
            type: 'keydown',
            key: 'c',
            metaKey: options.isMac,
            ctrlKey: !options.isMac,
            shiftKey: !options.isMac,
            altKey: false,
          })
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      event.stopPropagation();
    },
  };
  return controller;
}

/** Start deferred writes inside the gesture for browsers requiring activation. */
export function writeTerminalClipboard(text: string | Promise<string>, failed: () => void): void {
  const writing = async () => {
    if (typeof text === 'string') await navigator.clipboard.writeText(text);
    else if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      // Also observe rejection if clipboard access fails before the browser
      // consumes the item's data promise.
      void blob.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
      await navigator.clipboard.writeText(await text);
    }
  };
  // Always observe cancellation even if clipboard API setup throws first.
  if (typeof text !== 'string') void text.catch(() => {});
  void writing().catch(async (error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (typeof text !== 'string') {
      // A bare Ctrl-C may only interrupt. Report denied access only when the
      // application actually supplied text, not for a cancelled/expired copy.
      try {
        await text;
      } catch {
        return;
      }
    }
    failed();
  });
}

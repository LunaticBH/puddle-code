const INTERACTION_MS = 5_000;
const SESSION_SELECTOR = '[data-notification-session]';

/** Notification focus follows recent human input, never a tab or DOM focus alone. */
export function trackNotificationFocus(doc: Document) {
  let last: { element: HTMLElement; session: string; at: number } | null = null;
  const clear = () => {
    last = null;
  };
  const sessionElement = (event: Event) =>
    event.target instanceof Element ? event.target.closest<HTMLElement>(SESSION_SELECTOR) : null;
  const interact = (event: Event) => {
    if (!event.isTrusted) return;
    const element = sessionElement(event);
    const session = element?.dataset.notificationSession;
    last = element && session ? { element, session, at: performance.now() } : null;
  };
  const focus = (event: Event) => {
    // Moving focus away ends interaction; restoring focus cannot start it.
    if (sessionElement(event) !== last?.element) clear();
  };
  const events = ['pointerdown', 'keydown', 'input', 'paste'] as const;
  for (const event of events) doc.addEventListener(event, interact, true);
  doc.addEventListener('focusin', focus, true);
  doc.addEventListener('visibilitychange', clear);
  doc.defaultView?.addEventListener('blur', clear);
  return {
    isInteracting(session: string): boolean {
      return (
        last !== null &&
        last.session === session &&
        performance.now() - last.at < INTERACTION_MS &&
        doc.visibilityState === 'visible' &&
        doc.hasFocus() &&
        last.element.isConnected &&
        last.element.dataset.notificationSession === session &&
        last.element.getClientRects().length > 0
      );
    },
    dispose() {
      clear();
      for (const event of events) doc.removeEventListener(event, interact, true);
      doc.removeEventListener('focusin', focus, true);
      doc.removeEventListener('visibilitychange', clear);
      doc.defaultView?.removeEventListener('blur', clear);
    },
  };
}

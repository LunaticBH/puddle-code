import { notificationTargetSchema, type NotificationTarget } from '@puddle/shared';
import { desktopBridge } from '../desktop';

/** Listen on mount, including after a reload with no notification callbacks in memory. */
export function onNotificationTarget(open: (target: NotificationTarget) => void): () => void {
  const receive = (value: unknown) => {
    const target = notificationTargetSchema.safeParse(value);
    if (target.success) open(target.data);
  };
  const off = desktopBridge()?.onNotificationClick?.((_id, target) => receive(target));
  const message = (event: MessageEvent) => {
    if (event.data?.t === 'notification-click') receive(event.data.target);
  };
  navigator.serviceWorker?.addEventListener('message', message);
  return () => {
    off?.();
    navigator.serviceWorker?.removeEventListener('message', message);
  };
}

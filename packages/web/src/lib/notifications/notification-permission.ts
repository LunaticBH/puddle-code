import { desktopBridge } from '../desktop';

export type EffectiveNotificationPermission = NotificationPermission | 'unsupported' | 'unverified';

/**
 * The permission the waiting-input notification actually runs under, shared
 * by delivery (use-waiting-notifications) and the settings row that surfaces
 * it. Native desktop delivery reports its own outcome; the shell's presence
 * never proves an OS permission grant. `unsupported` covers browsers without the API (e.g. iOS
 * Safari outside an installed PWA).
 */
export function notificationPermission(): EffectiveNotificationPermission {
  if (desktopBridge()?.showNotification) return 'unverified';
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

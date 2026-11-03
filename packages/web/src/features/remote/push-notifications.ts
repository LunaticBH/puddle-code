import {
  notificationDeliverySchema,
  pushPreferenceResultSchema,
  pushSubscriptionSchema,
  remoteServiceInfoSchema,
  versionResponseSchema,
} from '@puddle/shared';
import { setRemotePushReady } from '../../lib/notifications/remote-notification-status';
import { notificationWorker } from '../../lib/notifications/notification-worker';
import { waitForNotification } from '../../lib/notifications/notification-wait';
import { serviceOrigin, serviceRequest } from './service';
import type { RemoteClient } from './client';
import { notificationKey, forgetNotificationKeys } from './notification-keys';

const connections = new Set<RemoteClient>();
const registrations = new Map<string, string>();
const key = (account: string) => `puddle.push:${serviceOrigin}:${account}`;
export const pushEnabled = (account: string) => localStorage.getItem(key(account)) === 'true';

type Progress = (message: string) => void;

async function synchronise(client: RemoteClient, testing?: Progress): Promise<boolean> {
  if (client.state !== 'ready') return false;
  const generation = client.generation;
  const enabled = pushEnabled(client.host.account);
  const current = () =>
    client.state === 'ready' &&
    generation === client.generation &&
    pushEnabled(client.host.account) === enabled;
  testing?.('Checking host notification support…');
  const version = versionResponseSchema.parse(
    await (await client.request('GET', '/api/version')).json(),
  );
  if (!current() || !version.remote_notifications) return false;
  testing?.('Checking this device’s push subscription…');
  const registration = await notificationWorker();
  const subscription =
    enabled && registration
      ? await waitForNotification(
          registration.pushManager.getSubscription(),
          'The browser did not respond while checking its push subscription. Reload Puddle and try again.',
        )
      : null;
  if (!current()) return false;
  if (testing && !subscription)
    throw new Error(
      'This device has no active push subscription. Turn background notifications off and on, then try again.',
    );
  const value = subscription ? pushSubscriptionSchema.parse(subscription.toJSON()) : null;
  let previewKey;
  if (value && version.remote_notification_previews) {
    const info = remoteServiceInfoSchema.parse(
      await waitForNotification(
        serviceRequest('/remote/config'),
        'The remote service did not respond while checking notification previews. Try again.',
      ),
    );
    if (!current()) return false;
    if (info.push_encrypted_previews)
      previewKey = await notificationKey(serviceOrigin, client.host.account, client.host.host);
  }
  if (!current()) return false;
  const fingerprint = JSON.stringify([generation, value, previewKey?.id]);
  // An explicit test must confirm that the service still holds this subscription;
  // the local cache cannot prove it survived service recovery or expiry.
  if (!testing && registrations.get(client.scope) === fingerprint) return true;
  testing?.('Registering this device with the host…');
  const response = await client.request('POST', '/api/notifications/push', {
    subscription: value,
    ...(previewKey ? { preview_key: previewKey } : {}),
  });
  if (!response.ok) throw new Error('Could not enable background notifications on this host.');
  const result = pushPreferenceResultSchema.parse(await response.json());
  if (result.enabled !== !!value)
    throw new Error('The host did not confirm notification settings.');
  if (current()) {
    setRemotePushReady(client.scope, !!value);
    registrations.set(client.scope, fingerprint);
    if (registrations.size > 128) registrations.delete(registrations.keys().next().value!);
  }
  return current();
}

/** Catalogue and workspace connections each synchronise their own approved host/device. */
export function watchPushNotifications(client: RemoteClient): () => void {
  connections.add(client);
  const refresh = () => {
    void synchronise(client).catch(() => {});
  };
  const off = client.onState(refresh);
  refresh();
  return () => {
    connections.delete(client);
    off();
  };
}

export async function setPushEnabled(account: string, enabled: boolean): Promise<string> {
  if (!enabled) localStorage.setItem(key(account), 'false');
  if (enabled) {
    if (typeof Notification === 'undefined' || !('PushManager' in window))
      throw new Error(
        'This browser does not support background notifications. On iPhone or iPad, add Puddle to the Home Screen and open it there.',
      );
    // The permission prompt must start directly from the user's click, before network work.
    if ((await Notification.requestPermission()) !== 'granted')
      throw new Error('Allow notifications for Puddle in this device’s browser settings.');
  }
  const registration = await notificationWorker();
  if (!registration)
    throw new Error('Background notifications require a secure supported browser.');
  if (enabled) {
    const info = remoteServiceInfoSchema.parse(await serviceRequest('/remote/config'));
    if (!info.push_public_key)
      throw new Error('Update the remote service to enable background notifications.');
    const existing = await registration.pushManager.getSubscription();
    if (!existing)
      await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: info.push_public_key,
      });
  } else {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription && !(await subscription.unsubscribe()))
      throw new Error(
        'The browser could not cancel its push subscription. Check notification permissions in browser settings.',
      );
  }
  localStorage.setItem(key(account), String(enabled));
  if (!enabled) await forgetNotificationKeys(serviceOrigin, account);
  registrations.clear();
  for (const client of connections)
    if (client.host.account === account) setRemotePushReady(client.scope, false);
  const hosts = [...connections].filter(
    (client) => client.host.account === account && client.state === 'ready',
  );
  const results = await Promise.allSettled(hosts.map((client) => synchronise(client)));
  const failed = results.filter((result) => result.status === 'rejected' || !result.value).length;
  if (!enabled) return 'Background notifications are off on this device.';
  if (!hosts.length)
    return 'Permission granted. Connect to a paired host to finish enabling notifications.';
  if (failed)
    return `Notifications could not be enabled on ${failed} host(s). Reconnect and try again.`;
  return 'Background notifications enabled. Use Send test to check delivery.';
}

export async function testPushNotifications(
  account: string,
  progress: Progress = () => {},
): Promise<string> {
  if (!pushEnabled(account))
    throw new Error('Enable background notifications on this device before sending a test.');
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted')
    throw new Error('Allow notifications for Puddle in this device’s notification settings.');
  const hosts = [...connections].filter(
    (client) => client.host.account === account && client.state === 'ready',
  );
  if (!hosts.length) throw new Error('Connect to a paired host before testing delivery.');
  const client = hosts[0]!;
  const generation = client.generation;
  const synchronised = await synchronise(client, progress);
  if (client.state !== 'ready' || client.generation !== generation)
    throw new Error('The host connection changed. Reconnect and send another test.');
  if (!synchronised)
    throw new Error('Update this host and connector before testing background notifications.');
  progress('Sending the test through the push service…');
  const response = await client.request('POST', '/api/notifications/test');
  if (!response.ok)
    throw new Error(
      'Update the host connector or re-enable background notifications before testing.',
    );
  const result = notificationDeliverySchema.parse(await response.json());
  return (
    result.message ??
    (result.state === 'shown'
      ? 'The push service accepted the test notification.'
      : 'Push delivery was not confirmed.')
  );
}

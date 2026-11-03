import { useEffect, useState } from 'react';
import { notificationPreferencesSchema, type NotificationPreferences } from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import { desktopBridge } from '../../../lib/desktop';
import {
  deliverNotification,
  refreshNotificationDelivery,
  useNotificationDelivery,
} from '../../../lib/notifications/notification-delivery';
import { toastError } from '../../../lib/transport/errors';
import { Switch } from '../../../components/ui/switch';
import {
  notificationPermission,
  type EffectiveNotificationPermission,
} from '../../../lib/notifications/notification-permission';
import {
  usePatchProfileSettings,
  useProfileSettings,
  useProjects,
} from '../../../lib/queries/queries';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

const DEFAULTS = notificationPreferencesSchema.parse({});

/**
 * The live browser permission behind the desktop toggle. Re-read on window
 * focus: granting or revoking happens in the browser's own UI (the prompt, a
 * site-settings page, System Settings), and the user comes back here to see
 * whether it took.
 */
function usePermissionState(): [EffectiveNotificationPermission, () => void] {
  const [permission, setPermission] = useState(notificationPermission);
  const refresh = () => setPermission(notificationPermission());
  useEffect(() => {
    const onFocus = () => setPermission(notificationPermission());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  return [permission, refresh];
}

/** The warning under the desktop toggle when it is on but cannot deliver. */
function PermissionHint({
  permission,
  onRequest,
}: {
  permission: EffectiveNotificationPermission;
  onRequest: () => void;
}) {
  if (permission === 'granted' || permission === 'unverified') return null;
  return (
    <p className="pb-2 text-xs text-warning">
      {permission === 'default' && (
        <>
          The browser has not been asked for permission yet, so nothing will show —{' '}
          <button
            type="button"
            onClick={onRequest}
            className="underline underline-offset-2 transition-colors hover:text-fg"
          >
            request it now
          </button>
          .
        </>
      )}
      {permission === 'denied' &&
        'Blocked by the browser — allow notifications for this site in its site settings, then return here.'}
      {permission === 'unsupported' && 'This browser cannot show desktop notifications.'}
    </p>
  );
}

/**
 * Notification preferences (SPEC §11); delivery lives in the shell's
 * use-waiting-notifications hook, which reads this profile-settings shape.
 * The desktop toggle's browser permission is requested by a click on the
 * toggle or the inline hint (a user gesture is required), and the row shows
 * the live permission state — the toggle defaults to on, so without the hint
 * an ungranted browser would silently deliver nothing.
 */
export function NotificationsSection() {
  const profileId = useCurrentProfileId();
  const settings = useProfileSettings(profileId ?? undefined);
  const patch = usePatchProfileSettings(profileId ?? '');
  const projects = useProjects(profileId ?? undefined);
  const [permission, refreshPermission] = usePermissionState();
  const delivery = useNotificationDelivery();
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    void refreshNotificationDelivery();
    const refresh = () => void refreshNotificationDelivery();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const prefs = notificationPreferencesSchema
    .catch(DEFAULTS)
    .parse(settings.data?.['notifications'] ?? {});
  const save = (next: NotificationPreferences) =>
    patch.mutate({ notifications: next }, { onError: (e) => toastError(e) });

  const requestPermission = () => {
    if (desktopBridge()?.showNotification) return;
    if (typeof Notification === 'undefined') return;
    void Notification.requestPermission().then(refreshPermission);
  };

  return (
    <div>
      <SectionTitle>Notifications</SectionTitle>
      <SettingRow label="Agent notifications" htmlFor="notify-desktop">
        <Switch
          id="notify-desktop"
          checked={prefs.desktop}
          onCheckedChange={(checked) => {
            // The toggle click is the user gesture browsers require for the
            // permission prompt — ask here, not at delivery time.
            if (checked) requestPermission();
            save({ ...prefs, desktop: checked });
          }}
        />
      </SettingRow>
      {prefs.desktop && <PermissionHint permission={permission} onRequest={requestPermission} />}
      <SettingRow
        label="Notify while interacting with a session"
        htmlFor="notify-focused"
        description="When off, typing or clicking in a session silences its desktop alerts for five seconds. Mobile Web Push is configured separately on each device."
      >
        <Switch
          id="notify-focused"
          checked={prefs.when_focused}
          onCheckedChange={(checked) => save({ ...prefs, when_focused: checked })}
        />
      </SettingRow>
      <SettingRow
        label="Test delivery"
        description="Send a notification to check this device’s permissions."
      >
        <Button
          variant="ghost"
          disabled={testing}
          onClick={() => {
            setTesting(true);
            void (async () => {
              if (
                !desktopBridge()?.showNotification &&
                typeof Notification !== 'undefined' &&
                Notification.permission === 'default'
              ) {
                await Notification.requestPermission();
                refreshPermission();
              }
              await deliverNotification(
                {
                  id: 'puddle-test',
                  title: 'Puddle',
                  body: 'Notifications are working on this device.',
                },
                () => {},
              );
            })()
              .catch(toastError)
              .finally(() => setTesting(false));
          }}
        >
          {testing ? 'Sending…' : 'Send test'}
        </Button>
      </SettingRow>
      <p role="status" className="pb-2 text-xs text-fg-muted">
        {delivery.state === 'shown'
          ? 'The system accepted the notification. Banner visibility also depends on Focus / Do Not Disturb.'
          : (delivery.message ?? 'Delivery has not been tested on this device.')}
      </p>
      <SettingRow label="Sound" htmlFor="notify-sound">
        <Switch
          id="notify-sound"
          checked={prefs.sound}
          onCheckedChange={(checked) => save({ ...prefs, sound: checked })}
        />
      </SettingRow>
      <SettingRow label="Muted projects" description="No notifications from these projects.">
        <span className="text-2xs text-fg-muted tabular-nums">
          {prefs.muted_projects.length} muted
        </span>
      </SettingRow>
      <div className="flex flex-col gap-1">
        {projects.data?.map((project) => {
          const muted = prefs.muted_projects.includes(project.id);
          return (
            <label
              key={project.id}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-fg-secondary hover:bg-elevated"
            >
              <Switch
                checked={muted}
                onCheckedChange={(checked) =>
                  save({
                    ...prefs,
                    muted_projects: checked
                      ? [...prefs.muted_projects, project.id]
                      : prefs.muted_projects.filter((id) => id !== project.id),
                  })
                }
              />
              {project.name}
            </label>
          );
        })}
      </div>
    </div>
  );
}

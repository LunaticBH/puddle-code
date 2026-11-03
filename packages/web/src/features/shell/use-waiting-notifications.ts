import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  notificationPreferencesSchema,
  type AgentNotification,
  type NotificationPreferences,
  type VersionResponse,
  type ProjectDetail,
  type ProfileSettings,
  type Session,
} from '@puddle/shared';
import {
  notificationPermission,
  type EffectiveNotificationPermission,
} from '../../lib/notifications/notification-permission';
import { deliverNotification } from '../../lib/notifications/notification-delivery';
import { onNotificationTarget } from '../../lib/notifications/notification-navigation';
import { trackNotificationFocus } from '../../lib/notifications/notification-focus';
import { browserTransport } from '../../lib/transport/browser-transport';
import { remotePushReady } from '../../lib/notifications/remote-notification-status';
import { api } from '../../lib/transport/api';
import { fetchAllSessions, hostLabel, useHostInfo } from '../../lib/queries/queries';
import { wsManager } from '../../lib/transport/ws';

/** The profile's notification prefs (SPEC §11); delivery defaults mirror the settings tab. */
const DEFAULT_PREFS = notificationPreferencesSchema.parse({});

/**
 * Whether a waiting_input transition should raise a desktop notification /
 * sound. Pure, so the policy is testable: muted projects are silent, the
 * desktop notification needs browser permission or native delivery. Focused
 * delivery is enabled by default and can be disabled in settings.
 */
export function decideNotification(args: {
  prefs: NotificationPreferences;
  projectId: string;
  sessionFocused: boolean;
  permission: EffectiveNotificationPermission;
}): { desktop: boolean; sound: boolean } {
  if (args.prefs.muted_projects.includes(args.projectId)) return { desktop: false, sound: false };
  return {
    desktop:
      args.prefs.desktop &&
      (args.permission === 'granted' || args.permission === 'unverified') &&
      (args.prefs.when_focused || !args.sessionFocused),
    sound: args.prefs.sound,
  };
}

/** Find a session across every cached list (same sweep as useStatusCacheSync). */
function findSession(qc: QueryClient, id: string): Session | undefined {
  for (const [, data] of qc.getQueriesData<Session[]>({ queryKey: ['sessions'] })) {
    const hit = data?.find((s) => s.id === id);
    if (hit) return hit;
  }
  for (const [, data] of qc.getQueriesData<ProjectDetail>({ queryKey: ['project'] })) {
    const hit = data?.sessions.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function displayTitle(session: Session): string {
  return session.title ?? session.agent_title ?? session.osc_title ?? session.id.slice(0, 8);
}

/** A short two-tone ping via WebAudio — no asset, respects nothing but volume. */
function playPing(): void {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0.04;
    gain.connect(ctx.destination);
    for (const [freq, at] of [
      [880, 0],
      [1318.5, 0.09],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.12);
    }
    setTimeout(() => void ctx.close(), 400);
  } catch {
    // No audio context (autoplay policy, headless) — the badge still shows.
  }
}

/**
 * waiting_input delivery (SPEC §11, task of the Notifications settings tab):
 * on a session's live transition to waiting_input — the WS status feed only
 * carries real transitions — raise a desktop notification (clicking focuses
 * the session), play the optional sound, and keep a "(n)" badge of currently
 * waiting agent sessions in the document title. Mounted once in the shell.
 */
export function useWaitingNotifications(): void {
  const navigate = useNavigate();
  const focus = useRef<ReturnType<typeof trackNotificationFocus> | null>(null);
  useEffect(() => {
    const tracker = trackNotificationFocus(document);
    focus.current = tracker;
    return () => {
      focus.current = null;
      tracker.dispose();
    };
  }, []);
  useEffect(
    () =>
      onNotificationTarget((target) => {
        if (!target.host)
          void navigate(`/project/${target.project}/session/${target.session}`, {
            state: { notificationSession: target.session },
          });
      }),
    [navigate],
  );
  useAgentNotifications(
    (session) => {
      void navigate(`/project/${session.project_id}/session/${session.id}`, {
        state: { notificationSession: session.id },
      });
    },
    (session) => focus.current?.isInteracting(session.id) ?? false,
  );
}

/** Shared by the cockpit and the mobile workspace; each supplies its own navigation. */
export function useAgentNotifications(
  openSession: (session: Session) => void,
  isSessionFocused: (session: Session) => boolean = () => document.hasFocus(),
): void {
  const qc = useQueryClient();
  const openRef = useRef(openSession);
  openRef.current = openSession;
  const focusedRef = useRef(isSessionFocused);
  focusedRef.current = isSessionFocused;
  // The title's base is the machine's label (display-name customisation
  // first, then hostname) — same base the workspace title builds on. A ref,
  // so a late-loaded label doesn't tear down the WS subscription (that would
  // drop the waiting set).
  const host = useHostInfo();
  const baseTitle = hostLabel(host.data) ?? 'Puddle';
  const baseRef = useRef(baseTitle);
  useEffect(() => {
    // Adopt a late-loaded (or renamed) host label only when the title still
    // shows the stale base — never stomp a workspace's "project — host".
    if (document.title === baseRef.current) document.title = baseTitle;
    baseRef.current = baseTitle;
  }, [baseTitle]);

  useEffect(() => {
    const waiting = new Set<string>();
    const updateBadge = () => {
      document.title = waiting.size > 0 ? `(${waiting.size}) ${baseRef.current}` : baseRef.current;
    };

    let active = true;
    const deliver = async (
      event: Pick<AgentNotification, 'session' | 'reason' | 'content'> & { id?: string },
    ) => {
      let session = findSession(qc, event.session);
      if (!session) {
        try {
          session = (await fetchAllSessions(qc)).find((s) => s.id === event.session);
        } catch {
          return;
        }
      }
      if (!active || !session) return;
      const found = session;
      let prefs: NotificationPreferences;
      let project: ProjectDetail['project'];
      try {
        const detail = await qc.fetchQuery({
          queryKey: ['project', found.project_id],
          queryFn: () => api<ProjectDetail>('GET', `/api/projects/${found.project_id}`),
          staleTime: 10_000,
        });
        if (!active) return;
        project = detail.project;
        const profile = project.profile_id;
        const settings = await qc.fetchQuery({
          queryKey: ['profile-settings', profile],
          queryFn: () => api<ProfileSettings>('GET', `/api/profiles/${profile}/settings`),
          staleTime: 10_000,
        });
        prefs = notificationPreferencesSchema
          .catch(DEFAULT_PREFS)
          .parse(settings['notifications'] ?? {});
      } catch {
        return;
      }
      if (!active) return;
      const verdict = decideNotification({
        prefs,
        projectId: found.project_id,
        sessionFocused: focusedRef.current(found),
        permission: notificationPermission(),
      });
      if (verdict.sound) playPing();
      if (verdict.desktop && !remotePushReady(browserTransport()?.scope)) {
        await deliverNotification(
          {
            id: event.id ? `puddle-event-${event.id}` : `puddle-agent-${found.id}`,
            title: event.content?.title ?? displayTitle(found).slice(0, 160),
            body:
              event.content?.body ??
              (event.reason === 'exited' ? 'Agent finished running' : 'Waiting for your input'),
            target: {
              project: found.project_id,
              session: found.id,
              ...(browserTransport()?.notificationHost
                ? { host: browserTransport()!.notificationHost }
                : {}),
            },
          },
          () => {
            if (active) openRef.current(found);
          },
          { host: baseRef.current, project },
        );
      }
    };
    const offNotification = wsManager.onAgentNotification((event) => {
      void deliver(event);
    });
    const off = wsManager.onStatus((event) => {
      const wasWaiting = waiting.has(event.session);
      if (event.status === 'waiting_input') waiting.add(event.session);
      else waiting.delete(event.session);
      updateBadge();
      if (event.status !== 'waiting_input' || wasWaiting) return;
      // Older daemons have only status events; current ones explicitly report
      // notifications, including terminal agents and unrequested process exits.
      void qc
        .fetchQuery({
          queryKey: ['version'],
          queryFn: () => api<VersionResponse>('GET', '/api/version'),
          staleTime: Infinity,
        })
        .then((version) => {
          if (
            version.protocol.major > 22 ||
            (version.protocol.major === 22 && version.protocol.minor >= 3)
          )
            return;
          return deliver({ session: event.session, reason: 'waiting_input' });
        })
        .catch(() => {});
    });
    return () => {
      active = false;
      off();
      offNotification();
      document.title = baseRef.current;
    };
  }, [qc]);
}

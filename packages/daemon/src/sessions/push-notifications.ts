import { connect, type Socket } from 'node:net';
import {
  connectorProvenSchema,
  notificationPreferencesSchema,
  projectNotificationTitle,
  type AgentNotification,
} from '@puddle/shared';
import { checkIpcEndpoint, checkIpcProof, ipcChallenge, ipcPath } from '@puddle/shared/node';
import type { SessionService, SessionServiceDeps } from './service.js';

/** Whether `line` is the connector's `proven` answer to `challenge`. */
function provenBy(home: string, scope: string, challenge: string, line: string): boolean {
  try {
    const reply = connectorProvenSchema.safeParse(JSON.parse(line));
    return reply.success && checkIpcProof(home, scope, challenge, reply.data.proof);
  } catch {
    return false;
  }
}

/** Send bounded attention previews to the profile's same-user connector for encryption. */
export function subscribePushNotifications(
  home: string,
  service: SessionService,
  stores: Pick<SessionServiceDeps, 'sessions' | 'projects' | 'profiles'>,
): () => void {
  const sockets = new Set<Socket>();
  const notify = (event: AgentNotification) => {
    if (sockets.size >= 32) return;
    try {
      const session = stores.sessions.get(event.session);
      const project = stores.projects.get(session.project_id);
      const prefs = notificationPreferencesSchema.safeParse(
        stores.profiles.getSettings(project.profile_id)['notifications'] ?? {},
      );
      if (!prefs.success || !prefs.data.desktop || prefs.data.muted_projects.includes(project.id))
        return;
      const scope = `remote-${project.profile_id}`;
      const path = ipcPath(home, scope);
      // A Unix socket must be private; a Windows pipe is never stat'd, which
      // would open it as a client.
      checkIpcEndpoint(path);
      const socket = connect(path);
      sockets.add(socket);
      socket.setTimeout(1500, () => socket.destroy());
      const notification =
        JSON.stringify({
          t: 'notify',
          id: event.id,
          ...(event.content
            ? {
                content: {
                  ...event.content,
                  title: projectNotificationTitle(event.content.title, project),
                },
              }
            : {}),
        }) + '\n';
      // Windows (25.7): content goes only to a server that proves it reads the home.
      const challenge = process.platform === 'win32' ? ipcChallenge() : undefined;
      let proven = challenge === undefined;
      socket.on('connect', () =>
        challenge === undefined
          ? socket.end(notification)
          : socket.write(JSON.stringify({ t: 'challenge', challenge }) + '\n'),
      );
      let response = '';
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (response.length > 2048) socket.destroy();
        if (proven) return;
        const end = response.indexOf('\n');
        if (end === -1) return;
        const line = response.slice(0, end);
        response = response.slice(end + 1);
        if (!provenBy(home, scope, challenge!, line)) return socket.destroy();
        proven = true;
        socket.end(notification);
      });
      socket.on('end', () => {
        if (!proven) return;
        // Older connectors reject the extra field before dispatch. Retry only
        // that explicit refusal, never an uncertain send (which could duplicate).
        try {
          if (event.content && JSON.parse(response).error) notify({ ...event, content: undefined });
        } catch {
          /* Unavailable connector; local notifications still work. */
        }
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
    } catch {
      /* No configured connector is ordinary local-only use. */
    }
  };
  service.on('agent-notification', notify);
  return () => {
    service.off('agent-notification', notify);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}

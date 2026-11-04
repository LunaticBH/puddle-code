import { describe, expect, it } from 'vitest';
import { agentNotificationSchema, type AgentNotification } from '@puddle/shared';
import { ProfileAccess } from '../../src/security/profile-access.js';
import { fixture, nodeFakeAdapter, waitFor } from '../helpers/daemon-fixtures.js';

describe('agent notification events', () => {
  it('reports waiting and a clean process exit, but keeps deliberate stops quiet', async () => {
    const f = fixture({ adapter: nodeFakeAdapter() });
    const events: AgentNotification[] = [];
    f.service.on('agent-notification', (event: AgentNotification) => events.push(event));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => events.some((event) => event.reason === 'waiting_input'));
    f.ptys.write(session.id, 'agent', '\x04');
    await waitFor(() => events.some((event) => event.reason === 'exited'));
    expect(events.map((event) => event.reason)).toEqual(['waiting_input', 'exited']);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    const access = new ProfileAccess(f.stores);
    expect(access.event(f.ids.profile, events[0]!)).toEqual(events[0]);
    expect(access.event('other-profile', events[0]!)).toBeNull();
    await f.service.resume(session.id);
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    const before = events.length;
    await f.service.kill(session.id);
    await waitFor(() => f.service.get(session.id).status === 'exited');
    expect(events).toHaveLength(before);
  });

  it('captures the named conversation and bounded last reply on its exact placement', async () => {
    const f = fixture({
      adapter: {
        ...nodeFakeAdapter(),
        notificationOutput: async () =>
          '\u001b[32mFixed the notification routing.\u001b[0m\nVerified desktop and mobile clicks. ' +
          'More detail. '.repeat(30),
      },
    });
    const events: AgentNotification[] = [];
    f.service.on('agent-notification', (event: AgentNotification) => events.push(event));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'Notification improvements',
    });
    await waitFor(() => events.length > 0);
    expect(agentNotificationSchema.safeParse(events[0]).success).toBe(true);
    expect(events[0]?.content).toMatchObject({
      title: 'Notification improvements',
      project: f.ids.project,
      session: session.id,
    });
    expect(events[0]?.content?.body).toMatch(
      /^Fixed the notification routing. Verified desktop and mobile clicks./,
    );
    expect(events[0]?.content?.body.length).toBeLessThanOrEqual(256);
    expect(events[0]?.content?.body).toMatch(/…$/);
  });
});

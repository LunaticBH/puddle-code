import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), checkIpcEndpoint: vi.fn() }));
vi.mock('node:net', () => ({ connect: mocks.connect }));
vi.mock('@puddle/shared/node', async (original) => ({
  ...(await original<object>()),
  checkIpcEndpoint: mocks.checkIpcEndpoint,
}));
import { ipcPath, ipcProof } from '@puddle/shared/node';
import { subscribePushNotifications } from '../../src/sessions/push-notifications.js';
import type { SessionService } from '../../src/sessions/service.js';

afterEach(() => vi.clearAllMocks());

type FakeSocket = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
/**
 * The connector side of a connection: on Windows (25.7) it answers the
 * daemon's challenge with this home's proof before anything is sent.
 */
function connected(socket: FakeSocket, home: string, scope: string, proof?: string): void {
  socket.emit('connect');
  if (process.platform !== 'win32') return expect(socket.write).not.toHaveBeenCalled();
  const { t, challenge } = JSON.parse(String(socket.write.mock.calls[0]![0])) as {
    t: string;
    challenge: string;
  };
  expect(t).toBe('challenge');
  expect(socket.end).not.toHaveBeenCalled();
  socket.emit(
    'data',
    Buffer.from(
      JSON.stringify({ t: 'proven', proof: proof ?? ipcProof(home, scope, challenge) }) + '\n',
    ),
  );
}
describe('daemon push signals', () => {
  it.each([
    { abbrev: 'EX', title: 'Conversation', expected: '[EX] Conversation' },
    { abbrev: null, title: 'Conversation', expected: '[EXAMP] Conversation' },
    { abbrev: 'EX', title: 'C'.repeat(160), expected: '[EX] ' + 'C'.repeat(155) },
  ])(
    'sends bounded project titles privately and retries explicit legacy refusal: $abbrev / $title',
    ({ abbrev, title, expected }) => {
      const sockets = Array.from({ length: 2 }, () =>
        Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          destroy: vi.fn(),
        }),
      );
      mocks.connect.mockReturnValueOnce(sockets[0]).mockReturnValueOnce(sockets[1]);
      const service = new EventEmitter() as SessionService;
      const stores = {
        sessions: { get: () => ({ project_id: '0123456789' }) },
        projects: {
          get: () => ({
            id: '0123456789',
            profile_id: 'abcdef0123',
            name: 'Example project',
            abbrev,
          }),
        },
        profiles: { getSettings: () => ({ notifications: { desktop: true } }) },
      } as unknown as Parameters<typeof subscribePushNotifications>[2];
      const close = subscribePushNotifications('/tmp/puddle-preview-test', service, stores);
      const event = {
        t: 'agent-notification',
        id: randomUUID(),
        session: randomUUID(),
        reason: 'waiting_input',
        content: {
          title,
          body: 'Completed the fix.',
          project: '0123456789',
          session: randomUUID(),
        },
      };
      service.emit('agent-notification', event);
      connected(sockets[0]!, '/tmp/puddle-preview-test', 'remote-abcdef0123');
      expect(sockets[0]!.end).toHaveBeenCalledWith(
        JSON.stringify({
          t: 'notify',
          id: event.id,
          content: { ...event.content, title: expected },
        }) + '\n',
      );
      // The same event also feeds native desktop alerts, whose session title stays plain.
      expect(event.content.title).toBe(title);
      sockets[0]!.emit('data', Buffer.from('{"error":"Unsupported request"}\n'));
      sockets[0]!.emit('end');
      connected(sockets[1]!, '/tmp/puddle-preview-test', 'remote-abcdef0123');
      expect(sockets[1]!.end).toHaveBeenCalledWith(
        JSON.stringify({ t: 'notify', id: event.id }) + '\n',
      );
      sockets[1]!.emit('error', new Error('Disconnected'));
      expect(mocks.connect).toHaveBeenCalledTimes(2);
      close();
    },
  );
  it('checks the owning profile preferences and sends only an event id over private IPC', () => {
    const socket = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    mocks.connect.mockReturnValue(socket);
    const service = new EventEmitter() as SessionService;
    let preferences: object = { desktop: true, muted_projects: [] };
    const stores = {
      sessions: { get: () => ({ project_id: 'project' }) },
      projects: { get: () => ({ id: 'project', profile_id: '0123456789' }) },
      profiles: { getSettings: () => ({ notifications: preferences }) },
    } as unknown as Parameters<typeof subscribePushNotifications>[2];
    const close = subscribePushNotifications('/tmp/puddle-notify-test', service, stores);
    const event = {
      t: 'agent-notification',
      id: randomUUID(),
      session: randomUUID(),
      reason: 'waiting_input',
    };
    service.emit('agent-notification', event);
    connected(socket, '/tmp/puddle-notify-test', 'remote-0123456789');
    expect(socket.end).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ t: 'notify', id: event.id }) + '\n',
    );
    expect(mocks.checkIpcEndpoint).toHaveBeenCalledWith(
      ipcPath('/tmp/puddle-notify-test', 'remote-0123456789'),
    );
    preferences = { desktop: false };
    service.emit('agent-notification', event);
    preferences = { desktop: true, muted_projects: ['project'] };
    service.emit('agent-notification', event);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    close();
    expect(socket.destroy).toHaveBeenCalled();
    service.emit('agent-notification', event);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === 'win32')(
    'sends nothing to a Windows pipe server that cannot prove it reads the home',
    () => {
      const socket = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      });
      mocks.connect.mockReturnValue(socket);
      const service = new EventEmitter() as SessionService;
      const stores = {
        sessions: { get: () => ({ project_id: 'project' }) },
        projects: { get: () => ({ id: 'project', profile_id: '0123456789', name: 'P' }) },
        profiles: { getSettings: () => ({ notifications: { desktop: true } }) },
      } as unknown as Parameters<typeof subscribePushNotifications>[2];
      const home = mkdtempSync(join(tmpdir(), 'puddle-notify-squat-'));
      const close = subscribePushNotifications(home, service, stores);
      service.emit('agent-notification', {
        t: 'agent-notification',
        id: randomUUID(),
        session: randomUUID(),
        reason: 'waiting_input',
        content: { title: 'Private', body: 'secret preview', project: 'project', session: 'x' },
      });
      connected(socket, home, 'remote-0123456789', 'f'.repeat(64));
      expect(socket.destroy).toHaveBeenCalled();
      expect(socket.end).not.toHaveBeenCalled();
      expect(socket.write).toHaveBeenCalledTimes(1);
      expect(String(socket.write.mock.calls[0]![0])).not.toContain('secret preview');
      // Its later answer is never read as a legacy refusal to retry.
      socket.emit('end');
      expect(mocks.connect).toHaveBeenCalledTimes(1);
      close();
    },
  );
});

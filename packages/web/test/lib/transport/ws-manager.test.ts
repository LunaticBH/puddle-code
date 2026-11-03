import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Drives WsManager with a scripted WebSocket double: asserts auth-first,
 * re-attach on reconnect, and message routing.
 */

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  listeners = new Map<string, Array<(evt: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (evt: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.emit('close', {});
  }
  emit(type: string, evt: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(evt);
  }
  get messages(): Array<{ t: string } & Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

function storageStub(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('localStorage', storageStub());
  vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:7433' } });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.setItem('puddle.browser-authorisation', 'test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function manager() {
  // Fresh module state per test: the singleton caches connection state.
  vi.resetModules();
  const { WsManager } = await import('../../../src/lib/transport/ws');
  return new WsManager();
}

describe('WsManager', () => {
  it('authenticates first, then subscribes and attaches', async () => {
    const ws = await manager();
    const data: string[] = [];
    ws.attach('session-1', 'agent', 100, 30, { onData: (d) => data.push(d) });

    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open', {});
    expect(ws.isConnected()).toBe(false);
    expect(socket.messages).toHaveLength(1);
    socket.emit('message', { data: JSON.stringify({ t: 'authenticated' }) });
    expect(socket.messages[0]).toEqual({ t: 'auth', token: 'test-token' });
    expect(socket.messages[1]).toEqual({ t: 'subscribe-status' });
    expect(socket.messages[2]).toEqual({
      t: 'attach',
      session: 'session-1',
      term: 'agent',
      cols: 100,
      rows: 30,
    });
  });

  it('routes replay and output to the registered terminal only', async () => {
    const ws = await manager();
    const received: Array<[string, string]> = [];
    ws.attach('session-1', 'agent', 80, 24, { onData: (d, kind) => received.push([kind, d]) });
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open', {});
    expect(ws.isConnected()).toBe(false);
    expect(socket.messages).toHaveLength(1);
    socket.emit('message', { data: JSON.stringify({ t: 'authenticated' }) });

    const send = (msg: unknown) => socket.emit('message', { data: JSON.stringify(msg) });
    send({ t: 'replay', session: 'session-1', term: 'agent', data: 'old' });
    send({ t: 'output', session: 'session-1', term: 'agent', data: 'new' });
    send({ t: 'output', session: 'other', term: 'agent', data: 'not-mine' });

    expect(received).toEqual([
      ['replay', 'old'],
      ['output', 'new'],
    ]);
  });

  it('re-attaches every terminal after a reconnect, with the latest size', async () => {
    const ws = await manager();
    ws.attach('session-1', 'agent', 80, 24, { onData: () => undefined });
    const first = FakeWebSocket.instances[0]!;
    first.emit('open', {});
    first.emit('message', { data: JSON.stringify({ t: 'authenticated' }) });
    ws.resize('session-1', 'agent', 132, 43);

    first.close();
    vi.advanceTimersByTime(600); // past the initial backoff

    const second = FakeWebSocket.instances[1]!;
    expect(second).toBeDefined();
    second.emit('open', {});
    second.emit('message', { data: JSON.stringify({ t: 'authenticated' }) });
    expect(second.messages[0]?.t).toBe('auth');
    expect(second.messages).toContainEqual({
      t: 'attach',
      session: 'session-1',
      term: 'agent',
      cols: 132,
      rows: 43,
    });
  });

  it('fans status broadcasts out to listeners and resolves spawn-shell', async () => {
    const ws = await manager();
    const statuses: string[] = [];
    ws.onStatus((e) => statuses.push(`${e.session}:${e.status}`));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open', {});
    expect(ws.isConnected()).toBe(false);
    expect(socket.messages).toHaveLength(1);
    socket.emit('message', { data: JSON.stringify({ t: 'authenticated' }) });

    const shell = ws.spawnShell('session-1');
    socket.emit('message', {
      data: JSON.stringify({ t: 'shell-spawned', session: 'session-1', term: 'shell-1' }),
    });
    await expect(shell).resolves.toBe('shell-1');

    socket.emit('message', {
      data: JSON.stringify({
        t: 'status',
        session: 'session-1',
        status: 'waiting_input',
        last_activity_at: null,
      }),
    });
    expect(statuses).toEqual(['session-1:waiting_input']);
  });

  it('fans native switches and catalogue invalidations out to listeners', async () => {
    const ws = await manager();
    const switches: string[] = [];
    const changed: string[][] = [];
    ws.onSessionSwitched((event) =>
      switches.push(`${event.source_session}:${event.target_session}`),
    );
    ws.onSessionsChanged((event) => changed.push(event.project_ids));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open', {});
    expect(ws.isConnected()).toBe(false);
    expect(socket.messages).toHaveLength(1);
    socket.emit('message', { data: JSON.stringify({ t: 'authenticated' }) });

    socket.emit('message', {
      data: JSON.stringify({
        t: 'session-switched',
        source_session: 'source',
        target_session: 'target',
        target_project: 'a1b2c3d4e5',
        cause: 'resume',
        outcome: 'rebound',
      }),
    });
    socket.emit('message', {
      data: JSON.stringify({ t: 'sessions-changed', project_ids: ['a1b2c3d4e5'] }),
    });

    expect(switches).toEqual(['source:target']);
    expect(changed).toEqual([['a1b2c3d4e5']]);
  });

  it('does not write to a closed socket', async () => {
    const ws = await manager();
    ws.write('session-1', 'agent', 'ignored'); // no socket yet — must not throw
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

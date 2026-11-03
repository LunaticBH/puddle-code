import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectResponse, type CodexSignalState } from '../../src/agents/codex/lifecycle.js';
import type { LifecycleLaunchContext } from '../../src/agents/adapter.js';

afterEach(() => vi.unstubAllGlobals());
const context = {
  signalUrl: 'http://127.0.0.1/agent-signal',
  signalNonce: 'test-nonce-for-status',
} as LifecycleLaunchContext;

describe('Codex native turn notifications', () => {
  it('reports exact active-thread starts and completions, ignoring side threads and unrelated events', async () => {
    const send = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', send);
    const state: CodexSignalState = { activeRef: 'active', queue: Promise.resolve() };
    const receive = (method: string, threadId: string) =>
      inspectResponse(
        Buffer.from(JSON.stringify({ method, params: { threadId } })),
        new Map(),
        context,
        state,
      );
    receive('turn/started', 'side-thread');
    receive('turn/started', 'active');
    receive('item/completed', 'active');
    receive('turn/completed', 'side-thread');
    receive('turn/completed', 'active');
    await state.queue;
    expect(
      send.mock.calls.map((call) =>
        JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
      ),
    ).toEqual([
      { nonce: context.signalNonce, state: 'working' },
      { nonce: context.signalNonce, state: 'waiting_input' },
    ]);
  });

  it('posts placement rebinding before turn signals and survives a failed delivery', async () => {
    const bodies: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        if (bodies.length === 1) {
          await gate;
          throw new Error('connection lost');
        }
        return new Response();
      }),
    );
    const state: CodexSignalState = { activeRef: null, queue: Promise.resolve() };
    const pending = new Map([
      ['1', { method: 'thread/start' as const, cwd: '/repo', ephemeral: false }],
    ]);
    inspectResponse(
      Buffer.from(JSON.stringify({ id: 1, result: { thread: { id: 'new-thread' } } })),
      pending,
      context,
      state,
    );
    inspectResponse(
      Buffer.from(JSON.stringify({ method: 'turn/completed', params: { threadId: 'new-thread' } })),
      pending,
      context,
      state,
    );
    await Promise.resolve();
    expect(bodies).toHaveLength(1);
    release();
    await state.queue;
    expect(bodies).toEqual([
      {
        nonce: context.signalNonce,
        event: 'session_start',
        agent_session_ref: 'new-thread',
        cwd: '/repo',
        source: 'startup',
      },
      { nonce: context.signalNonce, state: 'waiting_input' },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { CodexControl } from '../../src/agents/codex/control.js';

function fixture() {
  const control = new CodexControl();
  const sent: Array<Record<string, unknown>> = [];
  control.connect((message) => sent.push(message));
  control.bind('thread');
  const abort = new AbortController();
  return { control, sent, abort };
}
const item = (turnId: string, text: string, phase = 'final_answer') => ({
  method: 'item/completed',
  params: { threadId: 'thread', turnId, item: { type: 'agentMessage', text, phase } },
});
const completed = (id: string, status = 'completed') => ({
  method: 'turn/completed',
  params: { threadId: 'thread', turn: { id, status, items: [] } },
});

describe('Codex exact scripted turns', () => {
  it('correlates RPC, thread and turn; forwards notifications and excludes commentary', async () => {
    const f = fixture();
    const result = f.control.ask('task', f.abort.signal, { type: 'object' });
    expect(f.sent[0]).toMatchObject({
      method: 'turn/start',
      params: { outputSchema: { type: 'object' } },
    });
    expect(
      f.control.server({
        id: f.sent[0]!.id,
        result: { turn: { id: 'owned', status: 'inProgress' } },
      }),
    ).toBe(true);
    f.control.server(item('other', 'wrong'));
    f.control.server(item('owned', 'thinking', 'commentary'));
    expect(f.control.server(item('owned', '{"ok":true}'))).toBe(false);
    f.control.server(completed('owned'));
    await expect(result).resolves.toBe('{"ok":true}');
    expect(f.control.ready).toBe(true);
  });

  it('handles completion arriving before the start response', async () => {
    const f = fixture();
    const result = f.control.ask('task', f.abort.signal);
    f.control.server(item('owned', 'finished'));
    f.control.server(completed('owned'));
    f.control.server({
      id: f.sent[0]!.id,
      result: { turn: { id: 'owned', status: 'inProgress' } },
    });
    await expect(result).resolves.toBe('finished');
    expect(f.control.ready).toBe(true);
  });

  it('interrupts a cancelled ask even if the turn id arrives later', async () => {
    const f = fixture();
    const result = f.control.ask('task', f.abort.signal);
    f.abort.abort();
    await expect(result).rejects.toThrow('cancelled');
    expect(f.control.ready).toBe(false);
    f.control.server({
      id: f.sent[0]!.id,
      result: { turn: { id: 'owned', status: 'inProgress' } },
    });
    expect(f.sent[1]).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread', turnId: 'owned' },
    });
    f.control.server(completed('owned', 'interrupted'));
    expect(f.control.ready).toBe(true);
  });

  it('rejects busy, failed, disconnected and human-interrupted asks', async () => {
    const f = fixture();
    let result = f.control.ask('task', f.abort.signal);
    await expect(f.control.ask('second', f.abort.signal)).rejects.toThrow('busy');
    f.control.server({ id: f.sent[0]!.id, error: { message: 'denied' } });
    await expect(result).rejects.toThrow('denied');
    result = f.control.ask('task', f.abort.signal);
    f.control.client({ method: 'turn/steer' });
    await expect(result).rejects.toThrow('Human');
    f.control.server(completed('old'));
    result = f.control.ask('task', f.abort.signal);
    f.control.disconnect();
    await expect(result).rejects.toThrow('closed');
  });

  it('rejects interrupted turns and bounded reply overflow', async () => {
    const f = fixture();
    let result = f.control.ask('task', f.abort.signal);
    f.control.server({
      id: f.sent.at(-1)!.id,
      result: { turn: { id: 'one', status: 'inProgress' } },
    });
    f.control.server(completed('one', 'interrupted'));
    await expect(result).rejects.toThrow('interrupted');
    result = f.control.ask('task', f.abort.signal);
    f.control.server({
      id: f.sent.at(-1)!.id,
      result: { turn: { id: 'two', status: 'inProgress' } },
    });
    f.control.server(item('two', '界'.repeat(100_000)));
    await expect(result).rejects.toThrow('256 KiB');
  });
});

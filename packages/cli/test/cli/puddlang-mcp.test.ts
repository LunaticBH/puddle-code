import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { serveMcp } from '../../src/puddlang/mcp.js';
import type { PuddlangClient } from '../../src/puddlang/client.js';

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Array<Record<string, unknown>> = [];
  output.on('data', (data: Buffer) => replies.push(JSON.parse(data.toString())));
  const client = {
    context: vi.fn(async () => ({
      profile: { id: '1234567890', name: 'work' },
      projects: [],
      accounts: [],
      agents: [],
    })),
    start: vi.fn<PuddlangClient['start']>(),
    status: vi.fn<PuddlangClient['status']>(),
    events: vi.fn<PuddlangClient['events']>(),
    cancel: vi.fn<PuddlangClient['cancel']>(),
  };
  const send = (method: string, id?: number, params?: unknown) =>
    input.write(JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n');
  return { input, output, replies, client, send };
}
describe('puddlang MCP stdio', () => {
  it('negotiates capabilities, lists schemas and calls the profile-bound client', async () => {
    const f = fixture();
    const server = serveMcp(f.client, f.input, f.output);
    f.send('initialize', 1, {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    f.send('notifications/initialized');
    f.send('tools/list', 2);
    f.send('tools/call', 3, { name: 'puddlang_context', arguments: {} });
    f.input.end();
    await server;
    expect(f.replies[0]).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    expect(f.replies[1]).toMatchObject({
      id: 2,
      result: {
        tools: expect.arrayContaining([expect.objectContaining({ name: 'puddlang_run' })]),
      },
    });
    expect(f.client.context).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.replies[2])).toContain('work');
  });
  it('rejects uninitialised calls and invalid inputs without submitting work', async () => {
    const f = fixture();
    const server = serveMcp(f.client, f.input, f.output);
    f.send('tools/list', 1);
    f.send('initialize', 2);
    f.send('notifications/initialized');
    f.send('tools/call', 3, { name: 'puddlang_run', arguments: { source: 'export default 1' } });
    f.input.end();
    await server;
    expect(f.replies[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(f.replies[2]).toMatchObject({ id: 3, result: { isError: true } });
    expect(f.client.start).not.toHaveBeenCalled();
  });
  it('rejects an oversized unterminated input line', async () => {
    const f = fixture();
    const server = serveMcp(f.client, f.input, f.output);
    f.input.end('x'.repeat(1024 * 1024 + 1));
    await expect(server).rejects.toThrow('1 MiB');
  });
});

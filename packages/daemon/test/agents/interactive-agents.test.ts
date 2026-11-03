import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentTurnSignalSchema, type AgentTurnSignal } from '@puddle/shared';
import { InteractiveControl } from '../../src/agents/interactive/control.js';
import { installStatusHooks } from '../../src/agents/claude-code/hooks.js';
import { installClaudeTurnHooks } from '../../src/agents/claude-code/control.js';
import { installGeminiLifecycleHooks } from '../../src/agents/gemini-cli/hooks.js';
import { installOpenCodePlugin } from '../../src/agents/opencode/plugin.js';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function setup() {
  const write = vi.fn<(text: string) => void>();
  const control = new InteractiveControl(write, '\x1b');
  const ref = randomUUID(),
    nonce = randomUUID();
  control.lifecycle(ref, false);
  cleanups.push(async () => control.dispose());
  const submitted = () => {
    const paste = write.mock.calls.find(([text]) => text.startsWith('\x1b[200~'))![0];
    const prompt = paste.slice(6, -6);
    const turn_id = /\[puddle-turn:([0-9a-f-]{36})\]$/.exec(prompt)![1]!;
    return {
      nonce,
      agent_session_ref: ref,
      turn_id,
      prompt_hash: createHash('sha256').update(prompt).digest('hex'),
    };
  };
  return { control, write, ref, nonce, submitted };
}

describe('interactive exact prompt observation', () => {
  it('waits for the initial onboarding turn before accepting automated input', async () => {
    const control = new InteractiveControl(() => {}, '\x1b', true);
    const ref = randomUUID();
    control.lifecycle(ref, false);
    expect(control.ready).toBe(false);
    await expect(control.ask('too early', new AbortController().signal)).rejects.toThrow(
      'not ready',
    );
    const identity = { nonce: randomUUID(), agent_session_ref: ref, turn_id: randomUUID() };
    control.signal({ ...identity, event: 'turn_start' });
    expect(control.ready).toBe(false);
    control.signal({ ...identity, event: 'turn_complete', reply: 'setup complete' });
    expect(control.ready).toBe(true);
    control.dispose();
  });
  it('needs matching native admission and completion, not an idle status', async () => {
    const s = setup();
    const pending = s.control.ask('question', new AbortController().signal);
    const identity = s.submitted();
    s.control.signal({ ...identity, event: 'turn_complete', reply: 'too early' });
    expect(s.control.ready).toBe(false);
    s.control.signal({ ...identity, event: 'turn_start' });
    s.control.signal({ ...identity, turn_id: 'unrelated', event: 'turn_complete', reply: 'wrong' });
    s.control.signal({ ...identity, event: 'turn_complete', reply: 'correct' });
    expect(await pending).toBe('correct');
    expect(s.control.ready).toBe(true);
  });
  it('rejects a modified prompt, human input and native switches', async () => {
    for (const action of ['prompt', 'human', 'switch']) {
      const s = setup();
      const pending = s.control.ask('question', new AbortController().signal);
      const rejected = expect(pending).rejects.toThrow();
      if (action === 'prompt')
        s.control.signal({ ...s.submitted(), event: 'turn_start', prompt_hash: 'f'.repeat(64) });
      if (action === 'human') s.control.input();
      if (action === 'switch') s.control.lifecycle(randomUUID(), false);
      await rejected;
    }
  });
  it('does not submit Enter after a human takeover during paste', async () => {
    vi.useFakeTimers();
    const s = setup();
    const pending = s.control.ask('question', new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('Human input');
    s.control.input();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(s.write).toHaveBeenCalledTimes(1);
  });
  it('rejects terminal control characters and an existing human draft', async () => {
    const s = setup();
    await expect(s.control.ask('\x1b[201~attack', new AbortController().signal)).rejects.toThrow(
      'control characters',
    );
    s.control.input();
    await expect(s.control.ask('question', new AbortController().signal)).rejects.toThrow('draft');
    expect(s.write).not.toHaveBeenCalled();
  });
  it('interrupts cancellation and rejects missing hook admission without replay', async () => {
    vi.useFakeTimers();
    const s = setup();
    const abort = new AbortController();
    const pending = s.control.ask('question', abort.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    abort.abort();
    await rejected;
    expect(s.write).toHaveBeenLastCalledWith('\x1b');
    expect(s.control.ready).toBe(false);
    const t = setup();
    const timed = expect(t.control.ask('question', new AbortController().signal)).rejects.toThrow(
      'acknowledge',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await timed;
    expect(t.write.mock.calls.filter(([text]) => text === '\r')).toHaveLength(1);
    expect(t.control.ready).toBe(false);
  });
});

async function hookServer() {
  const messages: AgentTurnSignal[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    messages.push(agentTurnSignalSchema.parse(JSON.parse(raw)));
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { messages, url: `http://127.0.0.1:${address.port}` };
}
async function hook(file: string, mode: string, input: unknown, url: string, nonce: string) {
  const child = spawn(process.execPath, [file, mode], {
    env: { PUDDLE_AGENT_SIGNAL_URL: url, PUDDLE_AGENT_SIGNAL_NONCE: nonce },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '',
    err = '';
  child.stdout.on('data', (data) => {
    out += String(data);
  });
  child.stderr.on('data', (data) => {
    err += String(data);
  });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  expect(err).toBe('');
  expect(code).toBe(0);
  return out;
}

describe('generated native hooks', () => {
  for (const provider of ['claude', 'gemini']) {
    it(`${provider} reports correlated native replies and isolates runtime nonces`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pudl-hook-'));
      cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
      if (provider === 'claude') {
        installStatusHooks(dir);
        installClaudeTurnHooks(dir);
      } else installGeminiLifecycleHooks(dir);
      const file =
        provider === 'claude' ? join(dir, 'puddle-turn.mjs') : join(dir, '.gemini/puddle-turn.mjs');
      const server = await hookServer();
      const nonce = randomUUID(),
        turn = randomUUID(),
        ref = randomUUID();
      const prompt = `question\n\n[puddle-turn:${turn}]`;
      const base = { session_id: ref, prompt };
      const expected = provider === 'gemini' ? '{}\n' : '';
      expect(await hook(file, 'start', base, server.url, nonce)).toBe(expected);
      await hook(
        file,
        'complete',
        { ...base, last_assistant_message: 'answer', prompt_response: 'answer' },
        server.url,
        randomUUID(),
      );
      expect(server.messages).toHaveLength(1);
      await hook(
        file,
        'complete',
        { ...base, last_assistant_message: 'answer', prompt_response: 'answer' },
        server.url,
        nonce,
      );
      expect(server.messages).toEqual([
        expect.objectContaining({
          event: 'turn_start',
          turn_id: turn,
          agent_session_ref: ref,
          prompt_hash: createHash('sha256').update(prompt).digest('hex'),
        }),
        expect.objectContaining({ event: 'turn_complete', turn_id: turn, reply: 'answer' }),
      ]);
      if (provider === 'claude') {
        await hook(
          file,
          'complete',
          { ...base, agent_id: 'child', last_assistant_message: 'wrong' },
          server.url,
          nonce,
        );
        expect(server.messages).toHaveLength(2);
        await hook(file, 'failed', { ...base, error: 'rate_limit' }, server.url, nonce);
        expect(server.messages.at(-1)).toMatchObject({ event: 'turn_failed', error: 'rate_limit' });
      }
    });
  }
  it('matches OpenCode parent messages, ignores children and fails missing final replies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pudl-plugin-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    installOpenCodePlugin(dir);
    const source = readFileSync(join(dir, 'config/opencode/plugins/puddle-sync.js'), 'utf8');
    vi.stubEnv('PUDDLE_AGENT_SIGNAL_URL', 'http://127.0.0.1/agent-signal');
    vi.stubEnv('PUDDLE_AGENT_SIGNAL_NONCE', randomUUID());
    const messages: AgentTurnSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        const value: unknown = JSON.parse(String(options.body));
        const parsed = agentTurnSignalSchema.safeParse(value);
        if (parsed.success) messages.push(parsed.data);
        return new Response(null, { status: 204 });
      }),
    );
    const nativeMessage = vi.fn(async () => ({
      data: {
        info: { parentID: 'user-message', finish: 'stop' },
        parts: [
          { type: 'reasoning', text: 'private' },
          { type: 'text', text: 'answer' },
        ],
      },
    }));
    const plugin = (await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )) as {
      PuddleSync: (
        input: unknown,
      ) => Promise<Record<string, (input: unknown, output?: unknown) => Promise<void>>>;
    };
    const hooks = await plugin.PuddleSync({
      directory: '/work',
      client: { session: { message: nativeMessage } },
    });
    const event = (type: string, properties: unknown) =>
      hooks['event']!({ event: { type, properties } });
    const chat = (ref: string, text: string) =>
      hooks['chat.message']!(
        { sessionID: ref },
        { message: { id: 'user-message' }, parts: [{ type: 'text', text }] },
      );
    await event('session.created', { info: { id: 'parent' } });
    await event('session.created', { info: { id: 'child', parentID: 'parent' } });
    await chat('child', 'unrelated');
    expect(messages).toHaveLength(0);
    const turn = randomUUID();
    const prompt = `question\n\n[puddle-turn:${turn}]`;
    await chat('parent', prompt);
    await event('message.updated', {
      info: {
        id: 'assistant',
        sessionID: 'parent',
        parentID: 'user-message',
        role: 'assistant',
        finish: 'stop',
        time: { completed: 1 },
      },
    });
    await event('session.status', { sessionID: 'parent', status: { type: 'idle' } });
    expect(nativeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: 'parent', messageID: 'assistant' } }),
    );
    expect(messages).toEqual([
      expect.objectContaining({
        event: 'turn_start',
        turn_id: turn,
        prompt_hash: createHash('sha256').update(prompt).digest('hex'),
      }),
      expect.objectContaining({ event: 'turn_complete', turn_id: turn, reply: 'answer' }),
    ]);
    await chat('parent', 'next');
    await event('message.updated', {
      info: {
        id: 'wrong',
        sessionID: 'parent',
        parentID: 'different-user',
        role: 'assistant',
        finish: 'stop',
        time: { completed: 1 },
      },
    });
    await event('session.status', { sessionID: 'parent', status: { type: 'idle' } });
    expect(messages.at(-1)).toMatchObject({ event: 'turn_failed' });
    expect(nativeMessage).toHaveBeenCalledTimes(1);
  });
  it('routes nonce-scoped control and human input through the stable runtime', async () => {
    const f = fixture({
      adapter: {
        ...fakeAdapter(),
        scriptedTurns: true,
        prepareLifecycleLaunch: async (ctx) => {
          const control = new InteractiveControl(ctx.writeInput!, '\x1b');
          return { args: ctx.args, control, dispose: () => control.dispose() };
        },
      },
    });
    f.service.setSignalPort(1);
    cleanups.push(async () => {
      f.service.beginShutdown();
      f.ptys.killAll();
      await waitFor(() => !f.ptys.liveCount());
      f.onboarding.dispose();
      f.logs.closeAll();
    });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    const nonce = f.service.signalNonceFor(session.id)!;
    const ref = session.agent_session_ref!;
    await f.service.signalAgentLifecycle({
      nonce,
      event: 'session_start',
      agent_session_ref: ref,
      cwd: session.worktree_path,
      source: 'startup',
    });
    const runtime = f.service.scriptRuntime(session.id);
    expect(runtime.control.ready).toBe(true);
    expect(
      f.service.signalAgentTurn({
        nonce: randomUUID(),
        event: 'turn_start',
        agent_session_ref: ref,
        turn_id: 'foreign',
      }),
    ).toBe(false);
    const pending = runtime.control.ask('question', new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('Human input');
    f.ptys.write(session.id, 'agent', 'typing');
    await rejected;
    await f.service.kill(session.id);
    await waitFor(() => !f.ptys.has(session.id, 'agent'));
    expect(
      f.service.signalAgentTurn({
        nonce,
        event: 'turn_complete',
        agent_session_ref: ref,
        turn_id: 'late',
        reply: 'late',
      }),
    ).toBe(false);
  });
});

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LifecycleLaunchContext } from '../../src/agents/adapter.js';
import { prepareHeadless } from '../../src/agents/headless/control.js';
import type { HeadlessDriver } from '../../src/agents/headless/codec.js';
import { claudeDriver } from '../../src/agents/claude-code/headless.js';
import { codexDriver } from '../../src/agents/codex/headless.js';
import { geminiDriver } from '../../src/agents/gemini-cli/headless.js';
import { openCodeDriver } from '../../src/agents/opencode/headless.js';
import { fixture, waitFor } from '../helpers/daemon-fixtures.js';
import { nodeFakeAdapter } from './node-fake-agent.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const ref = randomUUID();
const context: LifecycleLaunchContext = {
  account: {
    id: 1,
    profile_id: '0123456789',
    agent_type: 'fake',
    label: 'test',
    config_dir: '/account',
    logged_in: true,
    skip_permissions_default: false,
    created_at: '',
  },
  opts: { sessionId: ref, worktreePath: '/work', skipPermissions: false },
  args: [],
  signalNonce: randomUUID(),
  signalUrl: 'http://127.0.0.1/agent-signal',
};

const fixtures = [
  {
    name: 'claude-code',
    driver: claudeDriver,
    records: [
      { type: 'system', subtype: 'init', session_id: ref },
      {
        type: 'assistant',
        parent_tool_use_id: 'child-tool',
        session_id: 'child',
        message: { content: [{ type: 'text', text: 'unrelated child' }] },
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: ref, result: 'answer' },
    ],
  },
  {
    name: 'codex',
    driver: codexDriver,
    records: [
      { type: 'thread.started', thread_id: ref },
      { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
  {
    name: 'gemini-cli',
    driver: geminiDriver,
    records: [
      { type: 'init', session_id: ref },
      { type: 'message', role: 'user', content: 'question' },
      { type: 'message', role: 'assistant', content: 'ans', delta: true },
      { type: 'message', role: 'assistant', content: 'wer', delta: true },
      { type: 'result', status: 'success' },
    ],
  },
  {
    name: 'opencode',
    driver: openCodeDriver,
    records: [
      { type: 'step_start', sessionID: ref },
      { type: 'text', sessionID: ref, part: { text: 'I will inspect it' } },
      { type: 'step_finish', sessionID: ref, part: { reason: 'tool-calls' } },
      { type: 'text', sessionID: ref, part: { text: 'answer' } },
      { type: 'step_finish', sessionID: ref, part: { reason: 'stop' } },
    ],
  },
] as const;

async function bridge(
  records: readonly unknown[],
  code = 0,
  delay = 0,
  native = codexDriver(context),
  before = '',
) {
  const directory = mkdtempSync(join(tmpdir(), 'pudl-test-'));
  const script = join(directory, 'agent.cjs');
  // Large replies exceed Linux's per-argument limit when embedded in node -e.
  writeFileSync(
    script,
    `
      process.stdin.resume();
      process.stdin.on('end', () => {
        ${before}
        for (const event of ${JSON.stringify(records)}) console.log(JSON.stringify(event));
        setTimeout(() => { process.exitCode = ${code}; }, ${delay});
      });`,
  );
  const bound: string[] = [];
  const driver: HeadlessDriver = {
    ...native,
    binary: process.execPath,
    env: { ...native.env, PUDL_TEST: 'isolated' },
    command: () => ({
      args: [script],
      stdin: 'prompt',
    }),
  };
  const resource = await prepareHeadless(
    {
      ...context,
      bindConversation: async (value) => {
        bound.push(value);
      },
    },
    driver,
  );
  const child = spawn(resource.binary!, resource.args, {
    cwd: directory,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', (data) => {
    output += String(data);
  });
  cleanups.push(async () => {
    await resource.dispose();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(() => resource.control!.ready);
  return { directory, control: resource.control!, bound, output: () => output };
}

describe('native structured agent protocols', () => {
  for (const item of fixtures) {
    it(`${item.name} extracts its exact result and resumes the same native conversation`, () => {
      const driver = item.driver(context);
      // join() spells the OpenCode XDG roots natively, with backslashes on Windows.
      expect(
        Object.values(driver.env).every((path) =>
          path.replaceAll('\\', '/').startsWith('/account'),
        ),
      ).toBe(true);
      const decode = driver.decoder();
      const events = item.records.map((record) => decode(record));
      expect(events.some((event) => event.ref === ref)).toBe(true);
      expect(events.at(-1)).toMatchObject({ complete: true, reply: 'answer' });
      const command = driver.command(ref, 'next', { type: 'object' });
      expect(command.args).toContain(ref);
      expect(command.args).not.toContain('--last');
      expect(command.args).not.toContain('--continue');
      expect(JSON.stringify(command)).toContain('object');
      expect(JSON.stringify(command)).not.toMatch(/dangerously|--auto|yolo/);
    });
  }
  it('rejects native failures and surfaces permission denial', () => {
    expect(
      claudeDriver(context).decoder()({
        type: 'result',
        subtype: 'success',
        permission_denials: [{ tool_name: 'Bash' }],
      }).error,
    ).toContain('permission');
    expect(
      geminiDriver(context).decoder()({
        type: 'result',
        status: 'error',
        error: { message: 'denied' },
      }).error,
    ).toBe('denied');
    expect(
      openCodeDriver(context).decoder()({ type: 'step_finish', part: { reason: 'length' } }).error,
    ).toContain('length');
    expect(
      codexDriver(context).decoder()({ type: 'turn.failed', error: { message: 'failed' } }).error,
    ).toBe('failed');
  });
  it('uses Claude structured output instead of conversational text', () => {
    expect(
      claudeDriver(context).decoder()({
        type: 'result',
        subtype: 'success',
        result: 'summary',
        structured_output: { complete: true },
      }).reply,
    ).toBe('{"complete":true}');
  });
});

describe('headless terminal ownership', () => {
  for (const item of fixtures) {
    it(`${item.name} completes two turns through the real terminal driver`, async () => {
      const s = await bridge(item.records, 0, 0, item.driver(context));
      expect(await s.control.ask('question', new AbortController().signal)).toBe('answer');
      expect(await s.control.ask('follow-up', new AbortController().signal)).toBe('answer');
      expect(s.bound).toEqual([ref]);
      expect(s.control.ready).toBe(true);
    });
  }

  it('waits for native result AND exit, excludes reasoning and retains its runtime', async () => {
    const s = await bridge(fixtures[1].records, 0, 100);
    const reply = s.control.ask('question', new AbortController().signal);
    expect(s.control.ready).toBe(false);
    await expect(s.control.ask('overlap', new AbortController().signal)).rejects.toThrow('busy');
    expect(await reply).toBe('answer');
    expect(s.bound).toEqual([ref]);
    expect(s.control.ready).toBe(true);
    expect(s.output()).not.toContain('private reasoning');
    expect(await s.control.ask('next', new AbortController().signal)).toBe('answer');
    expect(s.bound).toEqual([ref]);
  });
  it('never accepts exit 0 without a successful native result', async () => {
    const s = await bridge([{ type: 'thread.started', thread_id: ref }]);
    await expect(s.control.ask('question', new AbortController().signal)).rejects.toThrow(
      'without a successful result',
    );
  });
  it('never accepts a native result followed by a failed exit', async () => {
    const s = await bridge(fixtures[1].records, 1);
    await expect(s.control.ask('question', new AbortController().signal)).rejects.toThrow(
      'without a successful result',
    );
  });
  it('rejects unexpected conversation changes', async () => {
    const changed = await bridge([
      { type: 'thread.started', thread_id: ref },
      { type: 'thread.started', thread_id: randomUUID() },
    ]);
    await expect(changed.control.ask('question', new AbortController().signal)).rejects.toThrow(
      'changed its native conversation',
    );
  });
  it.each([256 * 1024, 256 * 1024 + 1])('enforces the reply limit for %i bytes', async (size) => {
    const text = 'x'.repeat(size);
    const s = await bridge([
      { type: 'thread.started', thread_id: ref },
      { type: 'item.completed', item: { type: 'agent_message', text } },
      { type: 'turn.completed' },
    ]);
    const reply = s.control.ask('question', new AbortController().signal);
    if (size <= 256 * 1024) expect(await reply).toBe(text);
    else await expect(reply).rejects.toThrow('256 KiB');
    expect(s.bound).toEqual([ref]);
    expect(s.control.ready).toBe(true);
  });
  it('interrupts a native process while leaving an attached runtime available', async () => {
    const s = await bridge([{ type: 'thread.started', thread_id: ref }], 0, 60_000);
    const abort = new AbortController();
    const pending = s.control.ask('question', abort.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await waitFor(() => s.bound.length === 1);
    abort.abort();
    await rejected;
    expect(s.control.ready).toBe(true);
  });
  it('kills cancelled descendants before admitting another turn', async () => {
    const s = await bridge(
      [{ type: 'thread.started', thread_id: ref }],
      0,
      60_000,
      codexDriver(context),
      `
      const child = require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
      require('node:fs').writeFileSync('child.pid', String(child.pid));
    `,
    );
    const abort = new AbortController();
    const pending = s.control.ask('question', abort.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await waitFor(() => s.bound.length === 1);
    const pid = Number(readFileSync(join(s.directory, 'child.pid'), 'utf8'));
    abort.abort();
    await rejected;
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(s.control.ready).toBe(true);
  });
  it('fails headless launch explicitly without opening an interactive fallback', async () => {
    const f = fixture({
      adapter: {
        ...nodeFakeAdapter(),
        scriptedTurns: true,
        prepareHeadlessLaunch: async () => {
          throw new Error('Unsupported native version');
        },
      },
    });
    f.service.setSignalPort(1);
    cleanups.push(async () => {
      f.service.beginShutdown();
      f.onboarding.dispose();
      f.logs.closeAll();
    });
    await expect(
      f.service.create({ project_id: f.ids.project, account_id: f.ids.account }, 'headless'),
    ).rejects.toThrow('Unsupported native version');
    expect(f.ptys.liveCount()).toBe(0);
    expect(f.stores.sessions.list()).toEqual([
      expect.objectContaining({ agent_mode: 'headless', status: 'exited' }),
    ]);
  });
  it('persists the selected mode and binds identity from structured output', async () => {
    let resumed: string | undefined;
    const f = fixture({
      adapter: {
        ...nodeFakeAdapter(),
        scriptedTurns: true,
        hasConversation: () => true,
        prepareHeadlessLaunch: async (ctx) => {
          resumed = ctx.resumeRef;
          return prepareHeadless(ctx, {
            ...codexDriver(ctx),
            binary: process.execPath,
            command: () => ({
              args: [
                '-e',
                `process.stdin.resume(); process.stdin.on('end',()=>{ for(const e of ${JSON.stringify(fixtures[1].records)}) console.log(JSON.stringify(e)); });`,
              ],
              stdin: 'prompt',
            }),
          });
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
    const session = await f.service.create(
      {
        project_id: f.ids.project,
        account_id: f.ids.account,
        separate_branch: false,
        separate_worktree: false,
      },
      'headless',
    );
    expect(session.agent_mode).toBe('headless');
    expect(session.agent_session_ref).toBeNull();
    await waitFor(() => f.service.scriptRuntime(session.id).control.ready);
    await f.service.kill(session.id);
    await waitFor(() => !f.ptys.has(session.id, 'agent'));
    await f.service.resume(session.id);
    await waitFor(() => f.service.scriptRuntime(session.id).control.ready);
    expect(resumed).toBeUndefined();
    expect(f.stores.sessions.get(session.id).agent_session_ref).toBeNull();
    expect(
      await f.service
        .scriptRuntime(session.id)
        .control.ask('question', new AbortController().signal),
    ).toBe('answer');
    expect(f.stores.sessions.get(session.id).agent_session_ref).toBe(ref);
    await f.service.kill(session.id);
    await waitFor(() => !f.ptys.has(session.id, 'agent'));
    const restored = await f.service.resume(session.id);
    expect(restored.agent_mode).toBe('headless');
    expect(resumed).toBe(ref);
  });
});

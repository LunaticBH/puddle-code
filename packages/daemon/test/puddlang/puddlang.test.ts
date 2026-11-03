import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { puddlangStartSchema, puddlangHandleSchema } from '@puddle/shared';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';
import { openDatabase } from '../../src/db/db.js';
import { PuddlangStore } from '../../src/puddlang/store.js';
import { PuddlangService } from '../../src/puddlang/service.js';
import { PuddlangOperations } from '../../src/puddlang/operations.js';
import type { AgentControl, AgentAdapter } from '../../src/agents/adapter.js';
import { puddlangRoutes } from '../../src/http/routes/execution/puddlang.js';
import { ApiError } from '../../src/http/errors.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
let compiled: string;
beforeAll(async () => {
  // Build the real isolated runner, including split shared module bindings.
  compiled = mkdtempSync(join(root, 'node_modules/.puddlang-test-'));
  await build({
    entryPoints: ['runner', 'runtime-api', 'zod'].map((name) =>
      join(root, `src/puddlang/${name}.ts`),
    ),
    outdir: compiled,
    bundle: true,
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@puddle/shared': join(root, '../shared/src/index.ts') },
  });
});
afterAll(() => rmSync(compiled, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(ask?: AgentControl['ask']) {
  const prompts: string[] = [];
  const prepare: NonNullable<AgentAdapter['prepareLifecycleLaunch']> = async ({ args }) => ({
    args,
    dispose() {},
    control: {
      ready: true,
      ask:
        ask ??
        (async (prompt) => {
          prompts.push(prompt);
          return prompt.includes('review') ? '{"complete":true}' : 'implemented';
        }),
    },
  });
  const f = fixture({
    adapter: {
      ...fakeAdapter(),
      scriptedTurns: true,
      prepareLifecycleLaunch: prepare,
      prepareHeadlessLaunch: prepare,
    },
  });
  f.service.setSignalPort(1);
  f.stores.accounts.setLoggedIn(f.ids.account, true);
  const db = openDatabase(f.paths.dbFile);
  const store = new PuddlangStore(db);
  const deps = { ...f.stores, adapters: f.adapters, service: f.service, worktrees: f.worktrees };
  const service = new PuddlangService(store, deps, join(compiled, 'runner.js'));
  cleanups.push(async () => {
    await service.dispose();
    f.service.beginShutdown();
    f.ptys.killAll();
    await waitFor(() => f.ptys.liveCount() === 0);
    f.onboarding.dispose();
    f.logs.closeAll();
    db.close();
  });
  const start = (source: string, extra = {}) =>
    service.start(f.ids.profile, puddlangStartSchema.parse({ id: randomUUID(), source, ...extra }));
  const done = async (id: string) => {
    await waitFor(() => store.get(f.ids.profile, id).status !== 'running');
    return store.get(f.ids.profile, id);
  };
  return { f, deps, service, store, start, done, prompts };
}

describe('puddlang host execution', () => {
  it('validates HTTP submissions and paginates run events through shared response shapes', async () => {
    const s = setup();
    const app = new Hono();
    app.onError((error, c) =>
      c.json({ error: error.message }, error instanceof ApiError ? (error.status as 400) : 500),
    );
    app.route('/api/puddlang', puddlangRoutes(s.service));
    const base = `/api/puddlang/${s.f.ids.profile}`;
    const body = { id: randomUUID(), source: 'console.log("hello"); export default 42;' };
    const send = (input: unknown) =>
      app.request(`${base}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    expect((await send(body)).status).toBe(202);
    await s.done(body.id);
    expect(await (await app.request(`${base}/runs/${body.id}`)).json()).toMatchObject({
      status: 'completed',
      result: 42,
    });
    expect((await app.request(`${base}/runs/${body.id}/events?after=-1`)).status).toBe(400);
    const events = (await (await app.request(`${base}/runs/${body.id}/events`)).json()) as {
      events: Array<{ sequence: number }>;
    };
    expect(events.events.length).toBeGreaterThan(0);
    expect(
      await (
        await app.request(`${base}/runs/${body.id}/events?after=${events.events.at(-1)!.sequence}`)
      ).json(),
    ).toEqual({ events: [] });
    expect((await send({ ...body, source: 'different' })).status).toBe(409);
    expect((await send({ id: randomUUID(), source: '界'.repeat(100_000) })).status).toBe(400);
  });
  it('runs coder/reviewer with typed validation and normal visible placements', async () => {
    const s = setup();
    const run = s.start(
      `import {spawn, input, z} from 'puddlang';
      const coder = await spawn({agent:'fake', project:'demo', title:'coder'});
      const reviewer = await spawn({agent:'fake', mode:'headless', project:'demo', title:'reviewer'});
      const result = await coder.ask(String(input));
      const verdict = await reviewer.ask({prompt:'review', input:result, schema:z.object({complete:z.boolean()})});
      export default {verdict, coder:coder.handle, reviewer:reviewer.handle};`,
      { input: 'implement task' },
    );
    const result = await s.done(run.id);
    expect(result.status, result.error ?? '').toBe('completed');
    expect(result.result).toMatchObject({ verdict: { complete: true } });
    expect(s.prompts).toEqual(['implement task', 'review\n\nInput:\n"implemented"']);
    const placements = s.f.stores.sessions.list().filter((p) => p.kind === 'agent');
    expect(placements).toHaveLength(2);
    expect(placements.find((p) => p.title === 'coder')?.agent_mode).toBe('interactive');
    expect(placements.find((p) => p.title === 'reviewer')?.agent_mode).toBe('headless');
    expect(s.service.context(s.f.ids.profile).agents).toContainEqual({
      id: 'fake',
      scripted_turns: true,
      modes: ['interactive', 'headless'],
    });
    expect(s.store.events(s.f.ids.profile, run.id, 0).events.map((e) => e.type)).toContain('ask');
  });

  it('does not replay duplicate submissions and rejects conflicting content/profile', async () => {
    const s = setup();
    const input = puddlangStartSchema.parse({ id: randomUUID(), source: 'export default 7' });
    s.service.start(s.f.ids.profile, input);
    expect(s.service.start(s.f.ids.profile, input).id).toBe(input.id);
    expect((await s.done(input.id)).result).toBe(7);
    expect(() =>
      s.service.start(s.f.ids.profile, { ...input, source: 'export default 8' }),
    ).toThrow('different work');
    const other = s.f.stores.profiles.create({ name: 'other', branch_prefix: '' });
    expect(() => s.store.get(other.id, input.id)).toThrow();
    expect(() => s.service.start(other.id, input)).toThrow('different work');
  });

  it('validates structured responses and reports unsupported imports', async () => {
    const s = setup(async () => '{"complete":"yes"}');
    const run =
      s.start(`import {spawn,z} from 'puddlang'; const a=await spawn({agent:'fake',project:'demo'});
      export default await a.ask({prompt:'review',schema:z.object({complete:z.boolean()})});`);
    expect((await s.done(run.id)).status).toBe('failed');
    const bad = s.start(`import './missing.ts';`);
    expect((await s.done(bad.id)).error).toContain('single-file');
  });

  it('cancels an active turn once and waits for owned agents to stop', async () => {
    let asked = false;
    const s = setup(
      (_prompt, signal) =>
        new Promise((_resolve, reject) => {
          asked = true;
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const run = s.start(
      `import {spawn} from 'puddlang'; const a=await spawn({agent:'fake',project:'demo'}); export default await a.ask('wait');`,
    );
    await waitFor(() => asked);
    const results = await Promise.all([
      s.service.cancel(s.f.ids.profile, run.id),
      s.service.cancel(s.f.ids.profile, run.id),
    ]);
    expect(results.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
    await waitFor(() => s.f.ptys.liveCount() === 0);
  });

  it('interrupts on shutdown, reconciles crashes and never resumes automatically', async () => {
    const s = setup();
    const run = s.start(`await new Promise(() => {});`);
    await s.service.dispose();
    expect(s.store.get(s.f.ids.profile, run.id).status).toBe('interrupted');
    const orphan = s.store.create(
      s.f.ids.profile,
      puddlangStartSchema.parse({ id: randomUUID(), source: 'export default 1' }),
    ).run;
    s.store.reconcile();
    expect(s.store.get(s.f.ids.profile, orphan.id).status).toBe('interrupted');
  });

  it('retains attached agents on cancellation and refuses another profile’s handles', async () => {
    let asked = false;
    const s = setup(
      (_prompt, signal) =>
        new Promise((_resolve, reject) => {
          asked = true;
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const input = puddlangStartSchema.parse({ id: randomUUID(), source: 'export default null' });
    const owner = new PuddlangOperations(
      s.deps,
      s.f.ids.profile,
      input,
      new AbortController().signal,
    );
    const handle = puddlangHandleSchema.parse(
      await owner.execute({ op: 'spawn', options: { agent: 'fake', project: 'demo' } }),
    );
    const other = s.f.stores.profiles.create({ name: 'other', branch_prefix: '' });
    const foreign = new PuddlangOperations(s.deps, other.id, input, new AbortController().signal);
    await expect(foreign.execute({ op: 'attach', reference: handle.runtime_id })).rejects.toThrow(
      'another profile',
    );
    const run = s.start(
      `import {attach} from 'puddlang'; const a=await attach(${JSON.stringify(handle.session_id)}); export default await a.ask('wait');`,
    );
    await waitFor(() => asked);
    await s.service.cancel(s.f.ids.profile, run.id);
    expect(s.f.service.scriptRuntime(handle.runtime_id).handle).toEqual(handle);
    expect(s.f.ptys.liveCount()).toBeGreaterThan(0);
  });

  it('requires unambiguous account choice and does not fall back from a logged-out default', async () => {
    const s = setup();
    const original = s.f.stores.accounts.get(s.f.ids.account);
    const second = s.f.stores.accounts.create({
      ...original,
      label: 'second',
      config_dir: original.config_dir + '-second',
    });
    s.f.stores.accounts.setLoggedIn(second.id, true);
    const source = `import {spawn} from 'puddlang'; await spawn({agent:'fake',project:'demo'});`;
    expect((await s.done(s.start(source).id)).error).toContain('Select an available');
    s.f.stores.profiles.patchSettings(s.f.ids.profile, { default_account_id: second.id });
    s.f.stores.accounts.setLoggedIn(second.id, false);
    expect((await s.done(s.start(source).id)).error).toContain('Select an available');
  });

  it('fails an expired programme and guards profile removal until it finishes', async () => {
    const s = setup();
    const run = s.start('await new Promise(() => {});', { timeout_ms: 1000 });
    expect(() => s.f.stores.removals.deleteProfile(s.f.ids.profile)).toThrow('running puddlang');
    expect((await s.done(run.id)).error).toContain('deadline');
    s.f.stores.removals.deleteProfile(s.f.ids.profile);
    expect(s.store.has(run.id)).toBe(false);
  });

  it('does not wait for inherited output pipes when cancelling a runner', async () => {
    const s = setup();
    const run = s.start(`import {spawn} from 'node:child_process';
      const server=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore','inherit','inherit']});
      console.log(server.pid); await new Promise(()=>{});`);
    let pid: number | undefined;
    try {
      await waitFor(() => {
        const event = s.store
          .events(s.f.ids.profile, run.id, 0)
          .events.find((e) => e.type === 'stdout');
        if (event) pid = Number(String(event.data).trim());
        return Number.isInteger(pid);
      });
      const result = await Promise.race([
        s.service.cancel(s.f.ids.profile, run.id),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Cancellation waited for a descendant pipe')),
            3000,
          );
          timer.unref();
        }),
      ]);
      expect(result.status).toBe('cancelled');
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }
  });

  it('resolves only registered roots and same-profile accounts; enforces turn limits', async () => {
    const s = setup();
    const input = puddlangStartSchema.parse({
      id: randomUUID(),
      source: 'export default null',
      max_turns: 1,
    });
    const operations = new PuddlangOperations(
      s.deps,
      s.f.ids.profile,
      input,
      new AbortController().signal,
    );
    await expect(
      // An existing directory that no project registers (`/tmp` is not one on Windows).
      operations.execute({ op: 'spawn', options: { agent: 'fake', path: tmpdir() } }),
    ).rejects.toThrow('registered');
    await expect(
      operations.execute({
        op: 'spawn',
        options: { agent: 'fake', project: 'demo', account: 999 },
      }),
    ).rejects.toThrow('Select an available');
    const run = s.start(
      `import {spawn} from 'puddlang'; const a=await spawn({agent:'fake',path:${JSON.stringify(s.f.repoPath)}}); await a.ask('first'); export default await a.ask('second');`,
      { max_turns: 1 },
    );
    expect((await s.done(run.id)).error).toContain('turn limit');
  });
});

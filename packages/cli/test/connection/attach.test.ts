import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../../daemon/test/helpers/authorised-daemon.js';
import { fakeAdapter } from '../../../daemon/test/helpers/daemon-fixtures.js';
import { initRepo } from '../../../daemon/test/helpers/git-fixtures.js';
import {
  attachSession,
  resolveSession,
  type AttachOutcome,
} from '../../src/lib/connection/attach.js';
import { DaemonClient } from '../../src/lib/connection/daemon-client.js';
import { CliError } from '../../src/lib/types.js';

describe('puddle attach', () => {
  let daemon: RunningDaemon;
  let client: DaemonClient;
  let sessionId: string;

  beforeAll(async () => {
    // A Node agent, so attach is exercised on every platform: banner, READY
    // for the waiting_input detector, then stdin echoed back.
    const agent = join(mkdtempSync(join(tmpdir(), 'puddle-cli-attach-agent-')), 'agent.mjs');
    writeFileSync(
      agent,
      "process.stdout.write('LAUNCH\\nREADY\\n');\nprocess.stdin.pipe(process.stdout);\n",
    );
    daemon = await startDaemon({
      home: mkdtempSync(join(tmpdir(), 'puddle-cli-attach-')),
      port: 0,
      adapters: [
        {
          ...fakeAdapter(),
          binary: process.execPath,
          launchArgs: () => [agent],
          resumeArgs: () => [agent],
        },
      ],
      version: 'attach-test',
      statusQuietMs: 150,
    });
    client = new DaemonClient(daemon.port, daemon.connection);

    const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${daemon.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    };

    const profile = await json<{ id: string }>('POST', '/api/profiles', { name: 'alice' });
    const account = await json<{ id: number; config_dir: string }>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'personal',
    });
    writeFileSync(join(account.config_dir, 'creds.json'), '{}'); // fake logged-in marker
    const repo = await json<{ id: number }>('POST', '/api/repos', { path: initRepo() });
    const project = await json<{ id: string }>('POST', '/api/projects', {
      profile_id: profile.id,
      repo_id: repo.id,
      name: 'demo',
    });
    const session = await json<{ id: string }>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: account.id,
      title: 'attach me',
    });
    sessionId = session.id;
  }, 30_000);

  afterAll(async () => {
    await daemon.stop();
  });

  it('resolves sessions by unique prefix and rejects unknown/ambiguous ones', async () => {
    expect((await resolveSession(client, sessionId.slice(0, 8))).id).toBe(sessionId);
    await expect(resolveSession(client, 'zzz-no-such')).rejects.toSatisfy(
      (e: unknown) => e instanceof CliError && e.code === 'unknown_session',
    );
  });

  it('replays, forwards stdin, and detaches on Ctrl-]', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let seen = '';
    stdout.on('data', (chunk: Buffer) => (seen += chunk.toString()));

    const outcomePromise: Promise<AttachOutcome> = attachSession({
      client,
      port: daemon.port,
      authority: daemon.connection,
      session: sessionId.slice(0, 8),
      streams: { stdin, stdout, stderr: new PassThrough() },
    });

    // The fake agent echoes its launch banner and READY, then cats stdin.
    await waitUntil(() => seen.includes('READY'), 10_000);
    stdin.write('marco-polo\r');
    await waitUntil(() => seen.includes('marco-polo'), 10_000);

    stdin.write(Buffer.from([0x1d])); // Ctrl-] detaches
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: 'detached' });

    // The session is still alive server-side — detaching is not killing.
    const session = await resolveSession(client, sessionId);
    expect(['running', 'waiting_input']).toContain(session.status);
  }, 30_000);
});

async function waitUntil(cond: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`waitUntil timed out`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

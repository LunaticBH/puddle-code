import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { findFreePort } from '../src/lib/transport/net.js';
import { env, fixture, root, stop, until, websocket } from './helpers.js';

it('uses the production browser boundary in Vite development mode', async () => {
  const f = await fixture();
  const port = await findFreePort();
  const origin = `http://localhost:${port}`;
  const vite = spawn(
    process.execPath,
    [
      resolve(root, 'packages/web/node_modules/vite/bin/vite.js'),
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: resolve(root, 'packages/web'),
      env: env(f.home),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  vite.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  vite.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  try {
    const invitation = await until(() => /#invite=(iv_[a-f0-9]{64})/.exec(output)?.[1], Boolean);
    expect((await fetch(origin + '/api/version')).status).toBe(401);
    const exchange = await fetch(origin + '/cockpit/bootstrap', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ invitation }),
    });
    const { credential } = (await exchange.json()) as { credential: string };
    const headers = { origin, authorization: `Bearer ${credential}` };
    expect((await fetch(origin + '/api/version', { headers })).status).toBe(200);
    expect((await fetch(origin + '/cockpit/local-sync', { headers })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/version`, { headers })).status).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/`, {
          headers: { origin: `http://127.0.0.1:${port}` },
        })
      ).status,
    ).toBe(404);
    const ws = await websocket(origin, credential);
    ws.close();
  } finally {
    await stop(vite);
    await f.close();
  }
});

import { LeaseRegistry } from '../../src/security/leases.js';
import { describe, expect, it } from 'vitest';
import { versionResponseSchema } from '@puddle/shared';
import { buildApp } from '../../src/http/app.js';

const authority = new LeaseRegistry();
const TOKEN = authority.create().token;

function app() {
  return buildApp({ version: '0.0.1', authority });
}

function get(path: string, headers: Record<string, string> = {}) {
  return app().request(path, { headers: { host: 'localhost:7434', ...headers } });
}

describe('GET /api/version', () => {
  it('returns the daemon version with a valid token', async () => {
    const res = await get('/api/version', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(versionResponseSchema.parse(await res.json()).version).toBe('0.0.1');
  });
});

describe('local security middleware', () => {
  it('rejects /api requests without a token', async () => {
    const res = await get('/api/version');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_expired');
  });

  it('rejects a wrong token of the same length', async () => {
    const res = await get('/api/version', { authorization: `Bearer ${'x'.repeat(64)}` });
    expect(res.status).toBe(401);
  });

  it('rejects a non-local Host (DNS rebinding)', async () => {
    const res = await app().request('/api/version', {
      headers: { host: 'evil.example.com:7433', authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a foreign Origin but accepts a local one on any port', async () => {
    const bad = await get('/api/version', {
      authorization: `Bearer ${TOKEN}`,
      origin: 'https://evil.example.com',
    });
    expect(bad.status).toBe(403);
    const tunnelled = await get('/api/version', {
      authorization: `Bearer ${TOKEN}`,
      origin: 'http://localhost:9182',
    });
    expect(tunnelled.status).toBe(200);
  });
});

describe('headless API (Phase 6: the CLI serves the UI)', () => {
  it('404s unmatched non-API routes', async () => {
    const res = await app().request('/', { headers: { host: 'localhost:7434' } });
    expect(res.status).toBe(404);
  });
});

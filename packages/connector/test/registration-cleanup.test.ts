const profile = 'a'.repeat(10);
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { configureConnector } from '../src/admin.js';
import {
  flushRegistrationCleanup,
  hasRegistrationCleanup,
  retireRegistration,
} from '../src/registration-cleanup.js';

const registration = () => ({
  host: crypto.randomUUID(),
  account: 'owner',
  credential: crypto.randomUUID().replaceAll('-', '').repeat(2),
  service: 'https://relay.example.test',
  app: 'https://app.example.test',
  enabled: false,
});

it('retires a replaced registration without unregistering a disabled or newly enabled host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-replace-registration-'));
  const directory = join(home, 'remote', 'profiles', profile);
  const old = registration();
  const next = registration();
  const fetch = vi.fn(async (url: string, request: RequestInit) => {
    if (url.endsWith('/register'))
      return Response.json({ host: next.host, account: next.account, credential: next.credential });
    expect(JSON.parse(String(request.body))).toEqual({ credential: old.credential });
    return new Response(null, { status: 503 });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    atomicPrivateJson(join(directory, 'config.json'), old);
    await configureConnector(home, { managed: false }, profile);
    expect(fetch).not.toHaveBeenCalled();
    expect(hasRegistrationCleanup(directory)).toBe(false);
    atomicPrivateJson(join(directory, 'config.json'), old);
    await configureConnector(
      home,
      {
        service: next.service,
        app: next.app,
        code: 'a'.repeat(64),
        managed: false,
      },
      profile,
    );
    expect(readPrivateJson(join(directory, 'config.json'))).toEqual({ ...next, enabled: true });
    expect(hasRegistrationCleanup(directory)).toBe(true);
    const file = join(directory, 'retired', readdirSync(join(directory, 'retired'))[0]!);
    // Unix modes; a Windows home is private through its DACL instead.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, 'retired')).mode & 0o777).toBe(0o700);
    }
    expect(readPrivateJson(file)).toEqual(old);
    fetch.mockImplementation(async (_url, request) => {
      expect(JSON.parse(String(request.body))).toEqual({ credential: old.credential });
      expect(request.redirect).toBe('error');
      expect(new Headers(request.headers).has('cookie')).toBe(false);
      expect(new Headers(request.headers).has('origin')).toBe(false);
      return new Response(null, { status: 204 });
    });
    await flushRegistrationCleanup(directory);
    expect(hasRegistrationCleanup(directory)).toBe(false);
    expect(readPrivateJson(join(directory, 'config.json'))).toEqual({ ...next, enabled: true });
  } finally {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  }
});

it.each([200, 403, 404, 500])(
  'retains cleanup when a service does not acknowledge deletion (%i)',
  async (status) => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-retirement-retry-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status })),
    );
    try {
      retireRegistration(home, registration());
      await flushRegistrationCleanup(home);
      expect(hasRegistrationCleanup(home)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

it('preserves new cleanup entries arriving during an in-flight acknowledgement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-retirement-race-'));
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  try {
    retireRegistration(home, registration());
    const flushing = flushRegistrationCleanup(home);
    const next = registration();
    retireRegistration(home, next);
    finish(new Response(null, { status: 204 }));
    await flushing;
    const remaining = readdirSync(join(home, 'retired'));
    expect(remaining).toHaveLength(1);
    expect(readPrivateJson(join(home, 'retired', remaining[0]!))).toEqual(next);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  }
});

it('refuses replacement before consuming a new code when cleanup capacity is exhausted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-retirement-capacity-'));
  const directory = join(home, 'remote', 'profiles', profile);
  const current = registration();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    for (let index = 0; index < 32; index++) retireRegistration(directory, registration());
    atomicPrivateJson(join(directory, 'config.json'), current);
    await expect(
      configureConnector(
        home,
        {
          service: current.service,
          app: current.app,
          code: 'a'.repeat(64),
          managed: false,
        },
        profile,
      ),
    ).rejects.toThrow('pending remote registration cleanup');
    expect(fetch).not.toHaveBeenCalled();
    expect(readPrivateJson(join(directory, 'config.json'))).toEqual(current);
  } finally {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  }
});

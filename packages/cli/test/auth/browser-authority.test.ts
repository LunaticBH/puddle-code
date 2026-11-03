import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CONNECTION_POLICY } from '@puddle/shared';
import { BrowserAuthority } from '../../src/lib/serve/browser-authority.js';

it('persists verifiers, scopes identities and expires invitations and browsers at their exact deadlines', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-browser-authority-'));
  let now = 0;
  let store = new BrowserAuthority(home, 'http://localhost:7433', 'local', () => now);
  const invitation = store.invite();
  now = CONNECTION_POLICY.invitationMs;
  expect(store.exchange(invitation)).toBeNull();
  const credential = store.exchange(store.invite())!;
  expect(credential).toMatch(/^br_/);
  expect(store.authenticate(credential)).not.toBeNull();
  store.close();
  const disk = readFileSync(
    join(home, 'browser-authority', readdirSync(join(home, 'browser-authority'))[0]!),
    'utf8',
  );
  expect(disk).not.toContain(credential);
  expect(disk).not.toContain(invitation);
  store = new BrowserAuthority(home, 'http://localhost:7433', 'local', () => now);
  expect(store.authenticate(credential)).not.toBeNull();
  const other = new BrowserAuthority(home, 'http://localhost:7433', 'remote', () => now);
  expect(other.authenticate(credential)).toBeNull();
  other.close();
  const closed = vi.fn();
  const record = store.authenticate(credential)!;
  store.bind(record, closed);
  now += CONNECTION_POLICY.browserIdleMs;
  expect(store.valid(record)).toBe(false);
  expect(closed).toHaveBeenCalledOnce();
  store.close();
});

describe('proxy ownership', () => {
  it('binds grants to the browser and exact target, and persists them across cockpit restarts', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-proxy-authority-'));
    let store = new BrowserAuthority(home, 'http://localhost:7433', 'local');
    const credential = store.exchange(store.invite())!;
    const browser = store.authenticate(credential)!;
    const prefix = '/proxy/00000000-0000-4000-8000-000000000000/3000/';
    const invite = store.proxyInvite(browser, prefix, prefix + 'app');
    const grant = store.exchangeProxy(invite, prefix)!;
    expect(store.exchangeProxy(invite, prefix)).toBeNull();
    expect(grant.cookie).toContain('HttpOnly');
    const cookie = grant.cookie.split(';')[0];
    store.close();
    store = new BrowserAuthority(home, 'http://localhost:7433', 'local');
    expect(store.proxyBrowser(cookie, prefix)?.id).toBe(browser.id);
    expect(store.proxyBrowser(cookie, prefix.replace('3000', '3001'))).toBeNull();
    store.revoke(store.authenticate(credential)!);
    expect(store.proxyBrowser(cookie, prefix)).toBeNull();
    store.close();
  });
});

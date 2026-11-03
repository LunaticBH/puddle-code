import { afterEach, describe, expect, it, vi } from 'vitest';
import { secret } from '@puddle/shared/node';
import { LeaseRegistry } from '../../src/security/leases.js';

let now = 0;
let registry = new LeaseRegistry(() => now);
afterEach(() => {
  registry.dispose();
  now = 0;
  registry = new LeaseRegistry(() => now);
});

describe('host authority deadlines and resource ownership', () => {
  it('rejects missing, wrong-audience and expired credentials without waiting for timers', () => {
    const first = registry.create();
    expect(registry.valid(first.token)).toBe(true);
    expect(registry.valid(secret('br_'))).toBe(false);
    expect(registry.valid(secret())).toBe(false);
    now = 45_000;
    expect(registry.valid(first.token)).toBe(false);
    expect(registry.renew(first.generation, [])).toBeNull();
  });
  it('rotates at 30 seconds, bounds overlap and only renews explicitly owned streams', () => {
    const first = registry.create();
    const legitimate = vi.fn();
    const stolen = vi.fn();
    const ownId = secret();
    const stolenId = secret();
    const own = registry.attach(first.token, ownId, legitimate)!;
    const thief = registry.attach(first.token, stolenId, stolen)!;
    expect(registry.attach(first.token, ownId, vi.fn())).toBeNull();
    now = 15_000;
    expect(registry.renew(first.generation, [ownId])?.token).toBeUndefined();
    now = 30_000;
    const replacement = registry.renew(first.generation, [ownId])!;
    expect(replacement.token).toBeDefined();
    now = 45_000;
    registry.renew(first.generation, [ownId]);
    expect(thief.valid()).toBe(false);
    expect(stolen).toHaveBeenCalledOnce();
    expect(own.valid()).toBe(true);
    expect(registry.valid(first.token)).toBe(true);
    now = 60_000;
    expect(registry.valid(first.token)).toBe(false);
    expect(registry.valid(replacement.token!)).toBe(true);
    expect(own.valid()).toBe(true);
  });
  it('does not resurrect expired streams or reuse their identifiers', () => {
    const first = registry.create();
    const id = secret();
    const close = vi.fn();
    const resource = registry.attach(first.token, id, close)!;
    now = 30_000;
    const second = registry.renew(first.generation, [])!;
    now = 46_000;
    registry.renew(first.generation, [id]);
    expect(resource.valid()).toBe(false);
    expect(registry.attach(second.token!, id, vi.fn())).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
  it('revokes every dependent resource and keeps other generations independent', () => {
    const first = registry.create();
    const second = registry.create();
    const closed = vi.fn();
    registry.attach(first.token, secret(), closed);
    registry.revoke(first.generation);
    registry.revoke(first.generation);
    expect(closed).toHaveBeenCalledOnce();
    expect(registry.valid(first.token)).toBe(false);
    expect(registry.valid(second.token)).toBe(true);
  });
  it('a stolen data token is not a control-channel lease handle', () => {
    const first = registry.create();
    expect(registry.renew(first.token, [])).toBeNull();
  });
});

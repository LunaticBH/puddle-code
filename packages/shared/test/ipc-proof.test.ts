import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { controlRequestSchema, controlResponseSchema } from '../src/index.js';
import {
  checkIpcProof,
  initialisePrivateHome,
  ipcChallenge,
  ipcProof,
  rotateIpcNonce,
} from '../src/node/security.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function home(): string {
  const parent = mkdtempSync(join(tmpdir(), 'puddle-ipc-proof-'));
  temporary.push(parent);
  const path = join(parent, '.puddle');
  initialisePrivateHome(path);
  return path;
}

/**
 * Windows pipe names can be listed and later squatted, so a Windows client
 * believes a pipe server only once it answers a challenge with a proof keyed
 * by the home's private `ipc-key` (protocol 25.7). The helpers run anywhere.
 */
describe('IPC server proofs', () => {
  it('answers a challenge only with the home’s key, scope and that challenge', () => {
    const a = home();
    const challenge = ipcChallenge();
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    const proof = ipcProof(a, 'host', challenge);
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(a, 'ipc-key'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(checkIpcProof(a, 'host', challenge, proof)).toBe(true);
    expect(checkIpcProof(a, 'install', challenge, proof)).toBe(false);
    expect(checkIpcProof(a, 'host', ipcChallenge(), proof)).toBe(false);
    expect(checkIpcProof(home(), 'host', challenge, proof)).toBe(false);
    expect(checkIpcProof(a, 'host', challenge, undefined)).toBe(false);
    expect(checkIpcProof(a, 'host', challenge, proof.toUpperCase())).toBe(false);
    expect(checkIpcProof(a, 'host', challenge, proof.slice(2))).toBe(false);
  });

  it('refuses a malformed or redirected key', () => {
    const a = home();
    writeFileSync(join(a, 'ipc-key'), 'not-hex');
    expect(() => ipcProof(a, 'host', ipcChallenge())).toThrow('IPC key is malformed');
    rmSync(join(a, 'ipc-key'));
    mkdirSync(join(a, 'ipc-key'));
    expect(() => ipcProof(a, 'host', ipcChallenge())).toThrow('must be a regular file');
  });

  it('replaces the nonce atomically', () => {
    const a = home();
    writeFileSync(join(a, 'ipc-nonce'), '0'.repeat(32));
    rotateIpcNonce(a);
    const rotated = readFileSync(join(a, 'ipc-nonce'), 'utf8');
    expect(rotated).toMatch(/^[0-9a-f]{32}$/);
    expect(rotated).not.toBe('0'.repeat(32));
    expect(readdirSync(a).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the challenge and proof optional, so POSIX exchanges are unchanged', () => {
    const challenge = ipcChallenge();
    expect(controlRequestSchema.parse({ t: 'open' })).toEqual({ t: 'open' });
    expect(controlRequestSchema.parse({ t: 'open', challenge })).toEqual({ t: 'open', challenge });
    expect(controlRequestSchema.parse({ t: 'shutdown', challenge })).toEqual({
      t: 'shutdown',
      challenge,
    });
    expect(controlRequestSchema.safeParse({ t: 'open', challenge: 'short' }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ t: 'renew', resources: [], challenge }).success).toBe(
      false,
    );
    const proof = 'a'.repeat(64);
    expect(controlResponseSchema.parse({ t: 'shutting_down', proof })).toEqual({
      t: 'shutting_down',
      proof,
    });
    expect(controlResponseSchema.parse({ t: 'error', code: 'unavailable' })).toEqual({
      t: 'error',
      code: 'unavailable',
    });
  });
});

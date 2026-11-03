import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertBinaryAvailable,
  clearBinaryCache,
  isBinaryAvailable,
  resolveBinary,
} from '../../src/agents/binary.js';
import type { AgentAdapter } from '../../src/agents/adapter.js';
import { ApiError } from '../../src/http/errors.js';
import { fakeAdapter } from '../helpers/daemon-fixtures.js';

const ABSENT = 'puddle-nonexistent-agent';

describe.skipIf(process.platform !== 'win32')('agent binary resolution on Windows', () => {
  const originalPath = process.env.PATH;

  beforeEach(() => clearBinaryCache());
  afterEach(() => {
    process.env.PATH = originalPath;
    clearBinaryCache();
  });

  it('resolves npm shims and native executables through PATHEXT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-bin-'));
    process.env.PATH = dir;
    expect(resolveBinary(ABSENT)).toBeNull();
    writeFileSync(join(dir, `${ABSENT}.cmd`), '@echo off\r\n');
    clearBinaryCache();
    expect(resolveBinary(ABSENT)).toBe(join(dir, `${ABSENT}.cmd`));
    // PATHEXT order prefers the native executable.
    writeFileSync(join(dir, `${ABSENT}.exe`), '');
    clearBinaryCache();
    expect(resolveBinary(ABSENT)).toBe(join(dir, `${ABSENT}.exe`));
    expect(resolveBinary(join(dir, ABSENT))).toBe(join(dir, `${ABSENT}.exe`));
  });
});

describe.skipIf(process.platform === 'win32')('agent binary resolution', () => {
  const originalPath = process.env.PATH;

  beforeEach(() => clearBinaryCache());
  afterEach(() => {
    process.env.PATH = originalPath;
    clearBinaryCache();
  });

  it('resolves a binary that is on PATH', () => {
    const found = resolveBinary('sh');
    expect(found).not.toBeNull();
    expect(found).toMatch(/\/sh$/);
  });

  it('returns null for a binary that is not installed', () => {
    expect(resolveBinary(ABSENT)).toBeNull();
  });

  it('ignores a non-executable file of the same name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-bin-'));
    writeFileSync(join(dir, ABSENT), '#!/bin/sh\n', { mode: 0o644 });
    process.env.PATH = dir;
    expect(resolveBinary(ABSENT)).toBeNull();

    // Same file, now executable — the mode is what decides.
    chmodSync(join(dir, ABSENT), 0o755);
    clearBinaryCache();
    expect(resolveBinary(ABSENT)).toBe(join(dir, ABSENT));
  });

  it('serves a cached result until the cache is cleared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-bin-'));
    writeFileSync(join(dir, ABSENT), '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveBinary(ABSENT)).toBeNull(); // not on PATH yet, and now cached

    process.env.PATH = dir;
    expect(resolveBinary(ABSENT)).toBeNull(); // still the cached miss
    clearBinaryCache();
    expect(resolveBinary(ABSENT)).toBe(join(dir, ABSENT));
  });

  it('treats a name containing a slash as a path rather than searching PATH', () => {
    expect(resolveBinary('/bin/sh')).toBe('/bin/sh');
    expect(resolveBinary('./nope/sh')).toBeNull();
  });
});

describe('assertBinaryAvailable', () => {
  beforeEach(() => clearBinaryCache());

  it('passes for an installed adapter', () => {
    // `node` runs this suite, so it is on PATH (as node.exe on Windows).
    expect(isBinaryAvailable(fakeAdapter({ binary: 'node' }))).toBe(true);
    expect(() => assertBinaryAvailable(fakeAdapter({ binary: 'node' }))).not.toThrow();
  });

  it('throws 424 agent_not_installed naming the binary and the escape hatch', () => {
    const adapter: AgentAdapter = fakeAdapter({ binary: ABSENT });
    expect(isBinaryAvailable(adapter)).toBe(false);
    try {
      assertBinaryAvailable(adapter);
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(424);
      expect(err.code).toBe('agent_not_installed');
      expect(err.message).toContain(ABSENT);
      expect(err.message).toContain('Fake Agent');
      expect(err.message).toContain('agent search path');
    }
  });
});

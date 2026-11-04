import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account, Profile } from '@puddle/shared';
import { assertAccountLabelFits } from '../../src/http/routes/accounts.js';
import { startDaemon, type RunningDaemon } from '../helpers/authorised-daemon.js';
import { fakeAdapter } from '../helpers/daemon-fixtures.js';

/**
 * A label names its account's config directory, which NTFS looks up without
 * case and without trailing dots, so on Windows labels the database tells
 * apart could share one directory and one login (SPEC §2: every account gets
 * a fresh directory). Injected platform, so it runs on every host.
 */
describe('account labels on a Windows host', () => {
  const fits =
    (label: string, siblings: string[] = [], dir: string | null = null) =>
    () =>
      assertAccountLabelFits(label, () => siblings, dir, 'win32');

  it('refuses names Windows cannot store as a directory', () => {
    for (const label of ['work.', 'con', 'NUL', 'com1']) {
      expect(fits(label), label).toThrow(expect.objectContaining({ code: 'invalid_name' }));
    }
    expect(fits('work.2')).not.toThrow();
  });

  it('refuses a case variant of another label for the same agent', () => {
    expect(fits('Work', ['work'])).toThrow(
      expect.objectContaining({ code: 'account_exists', status: 409 }),
    );
    expect(fits('work', ['personal'])).not.toThrow();
  });

  it('refuses a directory that already exists, such as one a renamed account kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-account-dir-'));
    expect(fits('work', [], dir)).toThrow(expect.objectContaining({ code: 'account_exists' }));
  });

  it('leaves POSIX labels exactly as they were', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-account-dir-'));
    expect(() => assertAccountLabelFits('Work.', () => ['work.'], dir, 'linux')).not.toThrow();
  });
});

describe.runIf(process.platform === 'win32')('account labels over HTTP on Windows', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-account-labels-'));
  let daemon: RunningDaemon;
  let profile: Profile;

  function req(method: string, path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${daemon.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  const create = (label: string) =>
    req('POST', '/api/accounts', { profile_id: profile.id, agent_type: 'fake', label });

  beforeAll(async () => {
    daemon = await startDaemon({
      home,
      port: 0,
      adapters: [fakeAdapter()],
      version: 'account-labels',
    });
    profile = (await (
      await req('POST', '/api/profiles', { name: 'alice', branch_prefix: 'alice/' })
    ).json()) as Profile;
  });
  afterAll(async () => {
    await daemon.stop().catch(() => undefined);
  });

  it('never gives two accounts one config directory', async () => {
    const work = (await (await create('work')).json()) as Account;
    writeFileSync(join(work.config_dir, '.credentials.json'), 'work login');

    const variant = await create('Work');
    expect(variant.status).toBe(409);
    expect(((await variant.json()) as { error: { code: string } }).error.code).toBe(
      'account_exists',
    );
    // The 409 path removes only what this request created: work's login survives.
    expect(readFileSync(join(work.config_dir, '.credentials.json'), 'utf8')).toBe('work login');

    const dotted = await create('work.');
    expect(dotted.status).toBe(400);
    expect(existsSync(join(home, 'profiles', profile.id, 'accounts', 'fake', 'work.'))).toBe(false);

    // A renamed account keeps its directory, so its old label cannot be reused.
    expect((await req('PATCH', `/api/accounts/${work.id}`, { label: 'renamed' })).status).toBe(200);
    expect((await create('work')).status).toBe(409);
    const other = (await (await create('other')).json()) as Account;
    expect((await req('PATCH', `/api/accounts/${other.id}`, { label: 'RENAMED' })).status).toBe(
      409,
    );
    // A case-only rename of an account's own label is not a clash.
    expect((await req('PATCH', `/api/accounts/${other.id}`, { label: 'Other' })).status).toBe(200);
  });
});

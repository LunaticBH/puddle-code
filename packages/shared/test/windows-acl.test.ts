import { describe, expect, it } from 'vitest';
import { foreignPrincipals, parseSddl, windowsAclProblem } from '../src/node/windows-acl.js';

/** Security descriptors as Get-Acl prints them (docs/windows.md, decision 2); any OS. */
const USER = 'S-1-5-21-2084319783-4192790293-3383329085-1001';
const OTHER = 'S-1-5-21-2084319783-4192790293-3383329085-1002';

describe('Windows home ACLs', () => {
  it('accepts a home inheriting the profile’s owner-only entries', () => {
    const acl = parseSddl(
      `O:${USER}G:${USER}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`,
    );
    expect(acl).toEqual({
      owner: USER,
      allowed: ['S-1-5-18', 'S-1-5-32-544', USER],
      nullDacl: false,
    });
    expect(windowsAclProblem(acl, USER)).toBeNull();
    // CREATOR OWNER and OWNER RIGHTS grant each entry's own owner, never a third party.
    expect(
      windowsAclProblem(
        parseSddl(`O:BAD:PAI(A;OICIIO;GA;;;CO)(A;;FA;;;OW)(A;OICI;FA;;;${USER})`),
        USER,
      ),
    ).toBeNull();
  });

  it('reports what a drive root grants every user', () => {
    // A folder made in C:\ inherits Authenticated Users' Modify and Users' read.
    const acl = parseSddl(
      `O:${USER}G:${USER}D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1301bf;;;AU)` +
        '(A;OICIID;0x1200a9;;;BU)(A;OICIIOID;GA;;;CO)',
    );
    expect(windowsAclProblem(acl, USER)).toBe('shared');
    expect(foreignPrincipals(acl, USER)).toEqual(['S-1-5-11', 'S-1-5-32-545']);
    // Read access alone is enough: the home holds the IPC key and tokens.
    expect(windowsAclProblem(parseSddl(`O:${USER}D:(A;;FR;;;WD)(A;;FA;;;${USER})`), USER)).toBe(
      'shared',
    );
    expect(windowsAclProblem(parseSddl(`O:${USER}D:(A;;FA;;;${OTHER})`), USER)).toBe('shared');
  });

  it('refuses a home another account owns, whatever its entries say', () => {
    const acl = parseSddl(`O:${OTHER}G:${OTHER}D:P(A;OICI;FA;;;${USER})`);
    expect(windowsAclProblem(acl, USER)).toBe('foreign_owner');
    // Administrators and SYSTEM may own it (an elevated creator); they can take anything anyway.
    expect(windowsAclProblem(parseSddl(`O:BAD:P(A;OICI;FA;;;${USER})`), USER)).toBeNull();
    expect(windowsAclProblem(parseSddl(`O:SYD:P(A;OICI;FA;;;${USER})`), USER)).toBeNull();
  });

  it('treats a missing DACL as open to everyone, and ignores deny and audit entries', () => {
    expect(windowsAclProblem(parseSddl(`O:${USER}D:NO_ACCESS_CONTROL`), USER)).toBe('shared');
    expect(windowsAclProblem(parseSddl(`O:${USER}G:${USER}`), USER)).toBe('shared');
    expect(
      windowsAclProblem(
        parseSddl(`O:${USER}D:P(D;;FA;;;WD)(A;OICI;FA;;;${USER})S:(AU;SA;FA;;;WD)`),
        USER,
      ),
    ).toBeNull();
  });

  it('reads conditional entries, whose condition nests parentheses', () => {
    const acl = parseSddl(
      `O:${USER}D:(XA;;FX;;;${OTHER};(@User.Project Any_of {"a", "b"}))(A;;FA;;;${USER})`,
    );
    expect(acl.allowed).toEqual([OTHER, USER]);
    expect(windowsAclProblem(acl, USER)).toBe('shared');
  });

  it('knows the built-in Administrator account by its alias', () => {
    const administrator = 'S-1-5-21-2084319783-4192790293-3383329085-500';
    expect(windowsAclProblem(parseSddl('O:LAD:P(A;OICI;FA;;;LA)'), administrator)).toBeNull();
    expect(windowsAclProblem(parseSddl('O:LAD:P(A;OICI;FA;;;LA)'), USER)).toBe('foreign_owner');
  });

  it('refuses a descriptor that names no owner', () => {
    expect(() => parseSddl('D:(A;;FA;;;WD)')).toThrow('names no owner');
  });
});

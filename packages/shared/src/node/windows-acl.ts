import { execFile, execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { system32Path } from './environment.js';

/**
 * Windows ACLs of the Puddle home (docs/windows.md, decision 2). Mode bits
 * have no meaning there, so the owner and DACL are read as SDDL, which names
 * principals by SID or a fixed alias in every display language.
 */

/** SYSTEM and Administrators can take any object, so granting them exposes nothing. */
const TRUSTED = new Set(['S-1-5-18', 'S-1-5-32-544']);
/** CREATOR OWNER and OWNER RIGHTS stand for each entry's own owner, never a third party. */
const OWNER_PLACEHOLDERS = new Set(['S-1-3-0', 'S-1-3-4']);
/** SDDL's aliases for well-known principals, so each is compared (and removed) by SID. */
const ALIASES: Readonly<Record<string, string>> = {
  WD: 'S-1-1-0',
  CO: 'S-1-3-0',
  OW: 'S-1-3-4',
  NU: 'S-1-5-2',
  IU: 'S-1-5-4',
  SU: 'S-1-5-6',
  AN: 'S-1-5-7',
  PS: 'S-1-5-10',
  AU: 'S-1-5-11',
  RC: 'S-1-5-12',
  SY: 'S-1-5-18',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  BA: 'S-1-5-32-544',
  BU: 'S-1-5-32-545',
  BG: 'S-1-5-32-546',
  PU: 'S-1-5-32-547',
  RD: 'S-1-5-32-555',
  AC: 'S-1-15-2-1',
};
/** Access-allowed entry types: plain, object, callback and callback-object. */
const ALLOW_TYPES = new Set(['A', 'OA', 'XA', 'ZA']);

export interface WindowsAcl {
  /** The owner's SID (or SDDL alias, for one not listed above). */
  owner: string;
  /** Principals that an access-allowed entry names, inherited or explicit. */
  allowed: string[];
  /** A missing DACL grants everyone everything. */
  nullDacl: boolean;
}

const principal = (token: string): string => ALIASES[token] ?? token;

/** Parse `O:<owner>G:<group>D:<flags>(ace)(ace)…`, as Get-Acl's `Sddl` prints it. */
export function parseSddl(sddl: string): WindowsAcl {
  const owner = /O:(S-1-[0-9-]+|[A-Z]{2})/.exec(sddl)?.[1];
  if (owner === undefined) throw new Error('the security descriptor names no owner');
  const dacl = /D:([^(]*)(.*)$/.exec(sddl);
  if (dacl === null || dacl[1]!.includes('NO_ACCESS_CONTROL')) {
    return { owner: principal(owner), allowed: [], nullDacl: true };
  }
  const allowed: string[] = [];
  for (const ace of splitEntries(dacl[2]!)) {
    // type;flags;rights;object;inherited object;trustee[;condition]
    const fields = ace.split(';');
    if (ALLOW_TYPES.has(fields[0]!) && fields[5]) allowed.push(principal(fields[5]));
  }
  return { owner: principal(owner), allowed, nullDacl: false };
}

/** `(a)(b(c))` → `a`, `b(c)`: conditional entries nest parentheses. */
function splitEntries(list: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(' && depth++ === 0) start = i + 1;
    else if (list[i] === ')' && --depth === 0) entries.push(list.slice(start, i));
  }
  return entries;
}

/** The user, or the built-in Administrator account (`LA`) when that is who runs. */
function isUser(sid: string, user: string): boolean {
  return sid === user || (sid === 'LA' && user.endsWith('-500'));
}

/** Principals other than the user, SYSTEM, Administrators and the owner placeholders. */
export function foreignPrincipals(acl: WindowsAcl, user: string): string[] {
  const foreign = acl.allowed.filter(
    (sid) => !isUser(sid, user) && !TRUSTED.has(sid) && !OWNER_PLACEHOLDERS.has(sid),
  );
  return [...new Set(foreign)];
}

/**
 * `foreign_owner`: another account owns the directory, so it can rewrite the
 * DACL at will. `shared`: some other principal is granted access.
 */
export function windowsAclProblem(
  acl: WindowsAcl,
  user: string,
): 'foreign_owner' | 'shared' | null {
  if (!isUser(acl.owner, user) && !TRUSTED.has(acl.owner)) return 'foreign_owner';
  return acl.nullDacl || foreignPrincipals(acl, user).length > 0 ? 'shared' : null;
}

/** The owners an entry of the home may have: the user, SYSTEM and Administrators. */
export function trustedOwners(user: string): string[] {
  return [user, ...TRUSTED];
}

export interface WindowsDirectoryInspection {
  acl: WindowsAcl;
  /**
   * With `owners`: the first entry inside that a principal outside them may
   * have put there. `owner`: another account owns it, or its owner cannot be
   * read. `link`: a junction or symbolic link, which could lead to a folder
   * other accounts can write and is never followed.
   */
  untrusted?: { kind: 'owner' | 'link'; path: string };
}

/** Entries an inspection checks at most: a young home holds a few dozen. */
export const INSPECTION_LIMIT = 50_000;

/**
 * Get-Acl's SDDL of the directory, then (with PUDDLE_ACL_OWNERS) a walk
 * that stops at the first untrusted entry. UTF-8 output keeps a path's
 * characters whatever the console code page (only the message needs them).
 */
const INSPECT = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
  '(Get-Acl -LiteralPath $env:PUDDLE_ACL_PATH).Sddl',
  'if ($env:PUDDLE_ACL_OWNERS) {',
  "  $owners = $env:PUDDLE_ACL_OWNERS -split ';'",
  '  $sid = [Security.Principal.SecurityIdentifier]',
  '  $link = [IO.FileAttributes]::ReparsePoint',
  '  $left = [int]$env:PUDDLE_ACL_LIMIT',
  '  $pending = New-Object Collections.Stack',
  '  $pending.Push([IO.DirectoryInfo]$env:PUDDLE_ACL_PATH)',
  '  while ($pending.Count -gt 0) {',
  '    foreach ($entry in $pending.Pop().EnumerateFileSystemInfos()) {',
  "      if (--$left -lt 0) { 'limit'; exit }",
  '      if ($entry.Attributes -band $link) { "link`t$($entry.FullName)"; exit }',
  "      try { $owner = $entry.GetAccessControl('Owner').GetOwner($sid).Value } catch { $owner = '' }",
  '      if ($owners -notcontains $owner) { "owner`t$($entry.FullName)"; exit }',
  '      if ($entry -is [IO.DirectoryInfo]) { $pending.Push($entry) }',
  '    }',
  '  }',
  '}',
].join('\n');

/**
 * The owner and DACL of `path`, through Windows PowerShell's Get-Acl; with
 * `owners`, also the first entry inside that they do not account for.
 */
export function inspectWindowsDirectory(
  path: string,
  owners?: readonly string[],
): WindowsDirectoryInspection {
  const output = execFileSync(
    system32Path(win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', INSPECT],
    {
      // The path travels in the environment, so PowerShell never parses it.
      env: {
        ...process.env,
        PUDDLE_ACL_PATH: path,
        PUDDLE_ACL_OWNERS: owners?.join(';') ?? '',
        PUDDLE_ACL_LIMIT: String(INSPECTION_LIMIT),
      },
      windowsHide: true,
      timeout: 120_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return parseInspection(output);
}

/** `<sddl>` and, after a walk that found something, `limit` or `<kind>\t<path>`. */
export function parseInspection(output: string): WindowsDirectoryInspection {
  const [sddl = '', finding] = output.split(/\r?\n/).filter((line) => line.trim() !== '');
  const acl = parseSddl(sddl.trim());
  if (finding === undefined) return { acl };
  if (finding.trim() === 'limit') {
    throw new Error(`it holds more than ${INSPECTION_LIMIT} entries to check`);
  }
  const match = /^(owner|link)\t(.+)$/.exec(finding);
  if (match === null) throw new Error('PowerShell reported an unexpected result');
  return { acl, untrusted: { kind: match[1] as 'owner' | 'link', path: match[2]! } };
}

/**
 * Give `path` a protected DACL for the user, SYSTEM and Administrators,
 * inherited by everything inside. Replacing grants keeps other principals'
 * explicit entries, so `remove` names those to drop as well.
 */
export function restrictWindowsDirectory(
  path: string,
  user: string,
  remove: readonly string[] = [],
): void {
  execFileSync(
    system32Path('icacls.exe'),
    [
      path,
      '/inheritance:r',
      '/grant:r',
      `*${user}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
      ...(remove.length > 0 ? ['/remove:g', ...remove.map((sid) => `*${sid}`)] : []),
    ],
    { windowsHide: true, timeout: 10_000, stdio: 'ignore' },
  );
}

/** The current user's SID, from whoami. */
export function currentWindowsUserSid(): string {
  const output = execFileSync(system32Path('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
    timeout: 10_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return whoamiSid(output);
}

/** currentWindowsUserSid without blocking the event loop (the desktop's main process). */
export function readCurrentWindowsUserSid(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      system32Path('whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 10_000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(whoamiSid(stdout));
        } catch (err) {
          reject(err as Error);
        }
      },
    );
  });
}

/** `"host\user","S-1-5-21-…"` */
function whoamiSid(output: string): string {
  const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(output.trim())?.[1];
  if (!sid) throw new Error('whoami did not report a user SID');
  return sid;
}

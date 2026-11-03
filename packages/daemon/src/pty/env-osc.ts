/**
 * OSC 7733 — puddle's captured-env side-channel (SPEC §4).
 *
 * Session shells carry an injected prompt hook that reports exported-variable
 * changes and their current directory as OSC sequences:
 *
 *   ESC ] 7733 ; set ; b64(name) ; b64(value) BEL|ST     (ST = ESC \)
 *   ESC ] 7733 ; unset ; b64(name) BEL|ST
 *   ESC ] 7733 ; cwd ; b64(absolute-path) BEL|ST
 *
 * The filter strips these from the PTY byte stream BEFORE the stream is
 * recorded or broadcast, so values (potential secrets) never reach terminal
 * logs, replay buffers, or viewers. Everything else passes through untouched.
 * One instance per PTY: sequences may arrive split across onData chunks, so a
 * carry buffer holds partial state between pushes.
 */

import { normaliseHostPath } from '@puddle/shared';

export interface EnvDelta {
  op: 'set' | 'unset';
  name: string;
  /** Present for 'set'; may be the empty string (`export FOO=""` is legal). */
  value?: string;
}

export interface CwdReport {
  op: 'cwd';
  path: string;
}

export type ShellReport = EnvDelta | CwdReport;

const ESC = '\u001b';
const BEL = '\u0007';
const INTRODUCER = `${ESC}]7733;`;

/** Variable names per POSIX; anything else in a sequence is dropped. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_NAME_BYTES = 256;
/** b64 of a 32 KiB value ≈ 44 KiB plus headers; beyond this the sequence is discarded. */
export const MAX_SEQ_BYTES = 64 * 1024;
/** A run of unterminated 7733 bytes longer than this hard-resets to passthrough. */
const MAX_DISCARD_BYTES = 1024 * 1024;

type State = 'pass' | 'in-seq' | 'discard';

export class EnvOscFilter {
  private state: State = 'pass';
  private carry = '';
  private discarded = 0;

  /** `platform` decides which cwd reports are absolute paths (see hostCwd). */
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** Filter a chunk: returns cleaned text plus any complete shell reports parsed from it. */
  push(chunk: string): { data: string; deltas: ShellReport[] } {
    let s = this.carry + chunk;
    this.carry = '';
    let out = '';
    const deltas: ShellReport[] = [];

    while (s.length > 0) {
      if (this.state === 'pass') {
        const at = s.indexOf(INTRODUCER);
        if (at === -1) {
          // Keep the longest suffix that is a proper prefix of the introducer —
          // it may be the head of a sequence split across chunks.
          const keep = trailingPrefixLength(s, INTRODUCER);
          out += s.slice(0, s.length - keep);
          this.carry = s.slice(s.length - keep);
          s = '';
        } else {
          out += s.slice(0, at);
          s = s.slice(at + INTRODUCER.length);
          this.state = 'in-seq';
        }
      } else if (this.state === 'in-seq') {
        const end = findTerminator(s);
        if (end === null) {
          if (s.length > MAX_SEQ_BYTES) {
            this.state = 'discard';
            this.discarded = s.length;
            s = '';
          } else {
            this.carry = s;
            s = '';
          }
        } else {
          const delta = parsePayload(s.slice(0, end.at), this.platform);
          if (delta) deltas.push(delta);
          s = s.slice(end.at + end.len);
          this.state = 'pass';
        }
      } else {
        // discard: our own protocol bytes, possibly holding secrets — never emitted.
        const end = findTerminator(s);
        if (end === null) {
          this.discarded += s.length;
          if (this.discarded > MAX_DISCARD_BYTES) this.state = 'pass';
          else this.carry = lastCharIfEsc(s); // keep a trailing lone ESC for a chunk-split ST
          s = '';
        } else {
          s = s.slice(end.at + end.len);
          this.state = 'pass';
        }
      }
    }
    return { data: out, deltas };
  }
}

/** Index and length of the first BEL or ST terminator, or null (a trailing lone ESC stays unconsumed). */
function findTerminator(s: string): { at: number; len: number } | null {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === BEL) return { at: i, len: 1 };
    if (c === ESC && s[i + 1] === '\\') return { at: i, len: 2 };
  }
  return null;
}

/** Length of the longest suffix of `s` that is a proper prefix of `token`. */
function trailingPrefixLength(s: string, token: string): number {
  const max = Math.min(token.length - 1, s.length);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(token.slice(0, n))) return n;
  }
  return 0;
}

/** In in-seq state a trailing lone ESC could be half an ST split across chunks. */
function lastCharIfEsc(s: string): string {
  return s.endsWith(ESC) ? ESC : '';
}

/** Parse a private shell report; anything malformed is dropped (null). */
function parsePayload(payload: string, platform: NodeJS.Platform): ShellReport | null {
  const parts = payload.split(';');
  const op = parts[0];
  if (op === 'set' && parts.length === 3) {
    const name = decodeB64(parts[1]!);
    const value = decodeB64(parts[2]!);
    if (name === null || value === null || !validName(name)) return null;
    return { op: 'set', name, value };
  }
  if (op === 'unset' && parts.length === 2) {
    const name = decodeB64(parts[1]!);
    if (name === null || !validName(name)) return null;
    return { op: 'unset', name };
  }
  if (op === 'cwd' && parts.length === 2) {
    const decoded = decodeB64(parts[1]!);
    const path = decoded === null ? null : hostCwd(decoded, platform);
    if (path === null || path.includes('\0')) return null;
    if (Buffer.byteLength(path) > MAX_SEQ_BYTES / 2) return null;
    return { op: 'cwd', path };
  }
  return null;
}

/**
 * A reported directory as an absolute host path, or null. POSIX accepts
 * `/`-rooted paths only. Windows accepts drive-absolute (`C:\x`, `C:/x`) and
 * UNC (`\\server\share`, `//server/share`) paths, never a rootless `\x`, and
 * translates the MSYS drive form Git Bash reports when `pwd -W` is missing
 * (`/c/x` is `C:\x`); other MSYS paths (`/tmp`, `/usr`) are unknowable here.
 */
function hostCwd(path: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') return path.startsWith('/') ? path : null;
  const msys = /^\/([A-Za-z])(\/.*)?$/.exec(path);
  const native = msys ? `${msys[1]}:${msys[2] ?? '\\'}` : path.replace(/^\/\/(?=[^/])/, '\\\\');
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(native) ? normaliseHostPath(native) : null;
}

function validName(name: string): boolean {
  return ENV_NAME_RE.test(name) && Buffer.byteLength(name) <= MAX_NAME_BYTES;
}

/** Strict-ish base64 decode; the empty string decodes to '' (empty values are legal). */
function decodeB64(b64: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

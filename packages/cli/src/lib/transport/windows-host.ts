import type { ExecResult } from './transport.js';

/**
 * How a Windows host gives itself away when it is sent a POSIX command
 * (docs/windows.md, decision 4): cmd.exe's "not recognized" (status 9009),
 * PowerShell's CommandNotFoundException (both shells' default for Windows
 * OpenSSH), install.sh naming a Git Bash, MSYS or Cygwin kernel, or the
 * POSIX helper stage run by a Windows node.exe (a Git Bash default shell,
 * which passes `true`). SshTransport confirms a match with its PowerShell
 * probe before treating the host as Windows.
 */
const WINDOWS_SIGNATURES = [
  /is not recognized as an internal or external command/i,
  /CommandNotFoundException/,
  /\b(?:MINGW(?:32|64)|MSYS|CYGWIN)_NT/,
  /process\.getuid is not a function/,
];

export function isWindowsHostFailure(result: ExecResult): boolean {
  if (result.code === 0) return false;
  if (result.code === 9009) return true;
  const output = `${result.stderr}\n${result.stdout}`;
  return WINDOWS_SIGNATURES.some((signature) => signature.test(output));
}

/** cmd.exe's answer to `true`: these two lines. */
const CMD_FIRST = "'true' is not recognized as an internal or external command,";
const CMD_SECOND = 'operable program or batch file.';
/** Windows PowerShell's error record (and PowerShell 7's with `$ErrorView = 'NormalView'`). */
const POWERSHELL_FIRST = "true : The term 'true' is not recognized as ";
const POWERSHELL_LAST = /^\s*\+ FullyQualifiedErrorId : CommandNotFoundException\s*$/;
/** PowerShell 7's concise view: the message's two lines. */
const PWSH_FIRST = "true: The term 'true' is not recognized as ";
const PWSH_LAST =
  /^Check the spelling of the name, or if a path was included, verify that the path is correct and try again\.\s*$/;
const PROBE_ERROR_STARTS = [CMD_FIRST, POWERSHELL_FIRST, PWSH_FIRST].map((start) =>
  Buffer.from(start, 'latin1'),
);
const LF = 0x0a;
const ESC = 0x1b;

/**
 * A line's text without SGR colour sequences (PowerShell 7 may colour its
 * errors); a sequence still incomplete at the end is left out.
 */
function plainLine(bytes: Buffer): Buffer {
  const kept: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== ESC) {
      kept.push(bytes[i]!);
      continue;
    }
    let j = i + 1;
    if (j < bytes.length && bytes[j] !== 0x5b) {
      kept.push(ESC);
      continue;
    }
    j += 1;
    while (j < bytes.length && ((bytes[j]! >= 0x30 && bytes[j]! <= 0x39) || bytes[j] === 0x3b)) {
      j += 1;
    }
    if (j < bytes.length && bytes[j] !== 0x6d) {
      kept.push(ESC);
      continue;
    }
    i = j;
  }
  return Buffer.from(kept);
}

/** Whether a line's start is a Windows shell's answer to `true`, may still become one, or is not. */
function lineStart(bytes: Buffer): 'probe-error' | 'undecided' | 'other' {
  const text = plainLine(bytes);
  if (PROBE_ERROR_STARTS.some((start) => text.subarray(0, start.length).equals(start))) {
    return 'probe-error';
  }
  return PROBE_ERROR_STARTS.some((start) => start.subarray(0, text.length).equals(text))
    ? 'undecided'
    : 'other';
}

/** Raw lines, each with its line feed (the last may have none). */
function rawLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let from = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== LF) continue;
    lines.push(bytes.subarray(from, i + 1));
    from = i + 1;
  }
  if (from < bytes.length) lines.push(bytes.subarray(from));
  return lines;
}

/**
 * How many of `lines` (each as plain text, without its line ending) make
 * up a Windows shell's answer to `true`, from the first: 0 when they are
 * not exactly one, which then stays visible.
 */
function probeErrorLength(lines: string[]): number {
  const first = lines[0] ?? '';
  // PowerShell follows its record with a line holding a space.
  const withBlank = (n: number) => (lines[n] !== undefined && /^\s*$/.test(lines[n]) ? n + 1 : n);
  if (first.startsWith(CMD_FIRST)) return lines[1]?.trimEnd() === CMD_SECOND ? 2 : 0;
  if (first.startsWith(POWERSHELL_FIRST)) {
    const last = lines.slice(1, 12).findIndex((line) => POWERSHELL_LAST.test(line));
    return last === -1 ? 0 : withBlank(last + 2);
  }
  if (first.startsWith(PWSH_FIRST)) return PWSH_LAST.test(lines[1] ?? '') ? withBlank(2) : 0;
  return 0;
}

/** `bytes` without the Windows shell's answer to `true` it starts with. */
function withoutProbeError(bytes: Buffer): Buffer {
  const lines = rawLines(bytes);
  const plain = lines.map((line) =>
    plainLine(line)
      .toString('utf8')
      .replace(/\r?\n$/, ''),
  );
  return Buffer.concat(lines.slice(probeErrorLength(plain)));
}

/**
 * The standard error of a Windows client's `ssh host true` (docs/windows.md,
 * decision 19), relayed to the user's terminal as it arrives, without the
 * lines a Windows host's default shell answers `true` with: cmd.exe's
 * "'true' is not recognized" and PowerShell's CommandNotFoundException
 * record (English hosts; any other text stays visible).
 *
 * Every byte passes through at once, except a line that begins as such an
 * answer would: from there on everything waits for `end`. A host's shell
 * runs `true` only once authentication is over, so nothing held can precede
 * a prompt (ssh asks on the console, never on standard error). `end(true)`,
 * once the host has proved to be Windows, drops exactly the answer's lines
 * and passes the rest; `end(false)`, for any other host, passes everything
 * held unchanged, so a POSIX host's standard error arrives byte for byte.
 */
export class ProbeStderrRelay {
  /** The current line's bytes, held while it may still begin an answer to `true`; null mid-line. */
  private pending: Buffer | null = Buffer.alloc(0);
  /** An answer to `true` and everything after it, until `end`. */
  private held: Buffer[] | null = null;
  private ended = false;

  constructor(private readonly out: (chunk: Buffer) => void) {}

  write(chunk: Buffer): void {
    if (this.ended) return this.emit(chunk);
    if (this.held !== null) {
      this.held.push(chunk);
      return;
    }
    let from = 0; // chunk[from..] is neither passed on nor held yet
    for (let i = 0; i < chunk.length; i += 1) {
      if (this.pending === null) {
        if (chunk[i] !== LF) continue;
        // The next byte starts a line.
        this.emit(chunk.subarray(from, i + 1));
        from = i + 1;
        this.pending = Buffer.alloc(0);
        continue;
      }
      const line = Buffer.concat([this.pending, chunk.subarray(from, i + 1)]);
      const verdict = lineStart(line);
      if (verdict === 'undecided') continue;
      if (verdict === 'probe-error') {
        this.pending = null;
        this.held = [line, chunk.subarray(i + 1)];
        return;
      }
      this.emit(line);
      from = i + 1;
      this.pending = chunk[i] === LF ? Buffer.alloc(0) : null;
    }
    const rest = chunk.subarray(from);
    if (this.pending === null) this.emit(rest);
    else this.pending = Buffer.concat([this.pending, rest]);
  }

  /** The host's answer is known: `windows` when it proved to be a Windows host. */
  end(windows: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (this.held !== null) {
      const held = Buffer.concat(this.held);
      this.held = null;
      this.emit(windows ? withoutProbeError(held) : held);
    } else if (this.pending !== null) this.emit(this.pending);
    this.pending = null;
  }

  private emit(bytes: Buffer): void {
    if (bytes.length > 0) this.out(bytes);
  }
}

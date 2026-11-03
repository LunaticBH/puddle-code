import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { getEnv, system32Path, type Environment } from './environment.js';
import { findExecutable } from './executables.js';

/**
 * Spawning on Windows (docs/windows.md, decision 9). CreateProcess runs only
 * real executables, and since CVE-2024-27980 Node refuses to start a `.cmd` or
 * `.bat` without a shell. npm-style shims are therefore unwrapped into
 * `node.exe <script>`, so arguments never pass through cmd.exe; any other
 * batch file runs through `cmd.exe /d /s /c` with strict quoting, and
 * arguments that cmd.exe cannot carry faithfully are refused.
 */

export interface ResolveSpawnOptions {
  platform?: NodeJS.Platform;
  /** Supplies PATH, PATHEXT, ComSpec and NODE_PATH; `process.env` by default. */
  env?: Environment;
}

export interface ResolvedSpawn {
  file: string;
  args: string[];
  /** Pass through to `spawn`: the cmd.exe command line is already quoted. */
  windowsVerbatimArguments?: boolean;
  /**
   * Variables the unwrapped shim would have set (pnpm's NODE_PATH), already
   * combined with the given environment. Apply them with `setEnv`.
   */
  env?: Record<string, string>;
}

/** An argument (or the batch file's own path) that cmd.exe cannot carry safely. */
export class UnsafeCmdArgumentError extends Error {
  readonly code = 'unsafe_cmd_argument';
  constructor(
    /** Index into the arguments, or `'file'` for the batch file's path. */
    readonly position: number | 'file',
    readonly reason: string,
  ) {
    super(
      `${position === 'file' ? 'The batch file path' : `Argument ${position + 1}`} cannot be ` +
        `passed to cmd.exe safely: it contains ${reason}`,
    );
    this.name = 'UnsafeCmdArgumentError';
  }
}

/**
 * How to spawn `file` with `args` without a shell. Identity on POSIX. On
 * Windows a bare name is first resolved with `findExecutable` (PATHEXT-aware,
 * never the working directory); `.exe`/`.com` and unknown kinds then spawn
 * directly, recognised shims become `node <script>`, and other `.cmd`/`.bat`
 * files run through `%ComSpec%`. Throws `UnsafeCmdArgumentError` for the
 * latter when an argument cannot be quoted for cmd.exe. Like
 * `findExecutable`, files are located with the native `path`.
 */
export function resolveSpawn(
  file: string,
  args: readonly string[],
  opts: ResolveSpawnOptions = {},
): ResolvedSpawn {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { file, args: [...args] };
  const env = opts.env ?? process.env;
  const resolved = findExecutable(file, { platform, env }) ?? file;
  const extension = extname(resolved).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') return { file: resolved, args: [...args] };
  const shim = readNodeShim(resolved, env);
  if (shim) {
    return {
      file: shim.node,
      args: [...shim.flags, shim.script, ...args],
      ...(shim.env ? { env: shim.env } : {}),
    };
  }
  return viaCmd(resolved, args, env);
}

/** `%ComSpec% /d /s /c "<quoted command line>"`; AutoRun commands are disabled. */
function viaCmd(file: string, args: readonly string[], env: Environment): ResolvedSpawn {
  const unsafe = unsafeCharacter(file);
  if (unsafe) throw new UnsafeCmdArgumentError('file', unsafe);
  const line = [`"${file}"`, ...args.map((arg, index) => quoteCmdArgument(arg, index))];
  return {
    file: getEnv(env, 'ComSpec', 'win32') ?? system32Path('cmd.exe', env),
    args: ['/d', '/s', '/c', `"${line.join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Quotes one argument for a batch file's command line, after the BatBadBut
 * guidance (CVE-2024-24576 and its siblings). cmd.exe treats `&|<>()^`, the
 * argument delimiters ` ,;=` and tab as literal only inside double quotes, so
 * every argument that is not plain ASCII from a known-inert set is quoted.
 * Trailing backslashes are doubled so a program reached through the batch
 * file's `%*` (with Microsoft C runtime parsing, as node.exe uses) does not
 * read the closing quote as escaped. What cmd.exe cannot carry at all is
 * refused rather than escaped; see `unsafeCharacter`.
 */
export function quoteCmdArgument(arg: string, index = 0): string {
  const unsafe = unsafeCharacter(arg);
  if (unsafe) throw new UnsafeCmdArgumentError(index, unsafe);
  // Inert characters stay bare, backslashes too unless one ends the argument.
  if (/^[\w#$*+\-./:?@\\]*[\w#$*+\-./:?@]$/.test(arg)) return arg;
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Characters with no faithful quoting for cmd.exe:
 * - NUL, CR, LF and other control characters (tab aside): a line break ends
 *   the command, and the remainder would be dropped or run as a new command;
 * - `%`: environment expansion happens before quotes are considered, and has
 *   no escape inside them;
 * - `!`: expanded inside quotes too when delayed expansion is enabled, by the
 *   registry default or by a batch file's own `setlocal`;
 * - `"`: cmd.exe toggles quoting on every quote, and no batch-file convention
 *   recovers an embedded one (doubling survives into `%~1`).
 */
function unsafeCharacter(value: string): string | null {
  for (const character of value) {
    if (character === '%' || character === '!' || character === '"') return `'${character}'`;
    const code = character.charCodeAt(0);
    if (code < 0x20 && character !== '\t') {
      return `a control character (U+${code.toString(16).toUpperCase().padStart(4, '0')})`;
    }
  }
  return null;
}

// --- npm, pnpm and Yarn cmd shims --------------------------------------------

interface NodeShim {
  node: string;
  flags: string[];
  script: string;
  env?: Record<string, string>;
}

/** Shims are a few hundred bytes; anything larger is not one. */
const SHIM_MAX_BYTES = 16 * 1024;

/**
 * Lines of the shim templates that need no interpretation: npm's cmd-shim
 * (the `GOTO start` / `:find_dp0` / `%_prog%` form and its older
 * `@IF EXIST "%~dp0\node.exe"` form, which Yarn's global bin also writes) and
 * pnpm's @zkochan/cmd-shim, whose NODE_PATH lines are interpreted below.
 * Any other line means the batch file may do more than start node, so it
 * runs through cmd.exe instead.
 */
const INERT_LINES = [
  /^@?echo off$/i,
  /^goto start$/i,
  /^:find_dp0$/i,
  /^set dp0=%~dp0$/i,
  /^exit \/b(?: %errorlevel%)?$/i,
  /^:start$/i,
  /^@?setlocal$/i,
  /^@?endlocal$/i,
  /^call :find_dp0$/i,
  /^@?if exist "(?:%~dp0|%dp0%)\\node\.exe" \($/i,
  /^\) else \($/i,
  /^\)$/,
  /^@?set pathext=%pathext:;\.js;=;%$/i,
  /^@?if not defined node_path \($/i,
  /^set "_prog=(?:%dp0%\\node\.exe|node)"$/i,
];

/** `[endLocal & … &] <program> [flags] "%~dp0\<script>" %*` */
const INVOCATION =
  /^@?(?:endlocal\s*&\s*goto\s+#_undefined_#\s+2>nul\s*\|\|\s*title\s+%comspec%\s*&\s*)?("[^"]+"|node)\s+((?:-{1,2}[A-Za-z0-9][\w.=:,+-]*\s+)*)"(?:%~dp0|%dp0%)\\?([^"%!]+)"\s+%\*$/i;

const NODE_PATH_LINE = /^@?set "node_path=([^"%!]+?)(;%node_path%)?"$/i;

/** How the templates name node: `%_prog%` (set to node above), beside the shim, or bare. */
const RELATIVE_NODE = /^(?:"%_prog%"|"(?:%~dp0|%dp0%)\\node\.exe"|node|"node")$/i;
/** pnpm's `nodeExecPath` option writes an absolute node.exe instead. */
const ABSOLUTE_NODE = /^"([A-Za-z]:\\[^"%!]*\\node\.exe)"$/i;

function readNodeShim(path: string, env: Environment): NodeShim | null {
  const text = readSmallFile(path);
  if (text === null) return null;
  let absoluteNode: string | null = null;
  let flags: string | null = null;
  let script: string | null = null;
  let nodePath: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || INERT_LINES.some((pattern) => pattern.test(line))) continue;
    const assignment = NODE_PATH_LINE.exec(line);
    if (assignment) {
      if (nodePath !== null && nodePath !== assignment[1]) return null;
      nodePath = assignment[1]!;
      continue;
    }
    const invocation = INVOCATION.exec(line);
    if (!invocation) return null;
    const program = invocation[1]!;
    if (/^"%_prog%"$/i.test(program) && !/^\s*set "_prog=/im.test(text)) return null;
    const absolute = ABSOLUTE_NODE.exec(program)?.[1];
    if (!absolute && !RELATIVE_NODE.test(program)) return null;
    if (absolute) absoluteNode = absolute;
    // Every branch of a template must run the same script with the same flags.
    if (script !== null && (script !== invocation[3] || flags !== invocation[2])) return null;
    script = invocation[3]!;
    flags = invocation[2]!;
  }
  if (script === null || flags === null) return null;
  const dir = dirname(path);
  const node = shimNode(dir, absoluteNode, env);
  if (!node) return null;
  const shim: NodeShim = {
    node,
    flags: flags.trim() === '' ? [] : flags.trim().split(/\s+/),
    script: resolve(dir, ...script.split('\\')),
  };
  if (nodePath !== null) {
    const inherited = getEnv(env, 'NODE_PATH', 'win32');
    shim.env = { NODE_PATH: inherited ? `${nodePath};${inherited}` : nodePath };
  }
  return shim;
}

/**
 * The node.exe the shim would choose: an absolute one it names, else one
 * beside the shim, else node on PATH. Never `process.execPath`, which may
 * be Electron.
 */
function shimNode(dir: string, absolute: string | null, env: Environment): string | null {
  if (absolute && existsSync(absolute)) return absolute;
  const beside = join(dir, 'node.exe');
  if (existsSync(beside)) return beside;
  return findExecutable('node', { platform: 'win32', env });
}

function readSmallFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(SHIM_MAX_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > SHIM_MAX_BYTES ? null : buffer.toString('utf8', 0, length);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

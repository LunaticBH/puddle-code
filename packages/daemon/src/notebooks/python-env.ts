import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname, extname, join, win32 } from 'node:path';
import { prependPathEntry, setEnv } from '@puddle/shared/node/platform';

/**
 * The environment a notebook Python (the package probe, pip and the kernel
 * bridge, whose kernels inherit it) runs with, or undefined to inherit the
 * daemon's, as POSIX always does. On Windows:
 *
 * - Python's piped stdio uses the ANSI code page, so UTF-8 is requested for
 *   the JSON the bridge exchanges with the daemon and for pip's messages.
 *   PYTHONIOENCODING changes only the standard streams, never how notebook
 *   code opens files.
 * - A Conda interpreter run without `conda activate` cannot find its DLLs,
 *   and importing zmq or nbconvert then fails or crashes the interpreter.
 *   The prefix's directories go first on PATH, in the order activation uses,
 *   including for a venv created from a Conda base interpreter.
 */
export function pythonEnvironment(
  python: string,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv | undefined {
  if (platform !== 'win32') return undefined;
  const env = { ...base };
  setEnv(env, 'PYTHONIOENCODING', 'utf-8', platform);
  const prefix = condaPrefixOf(python);
  if (prefix) {
    for (const dir of [
      'bin',
      'Scripts',
      join('Library', 'bin'),
      join('Library', 'usr', 'bin'),
      join('Library', 'mingw-w64', 'bin'),
      '',
    ]) {
      prependPathEntry(env, join(prefix, dir), platform);
    }
  }
  return env;
}

/** The Conda prefix `python` belongs to, directly or as a venv's base interpreter. */
export function condaPrefixOf(python: string): string | null {
  const dir = dirname(python);
  if (existsSync(join(dir, 'conda-meta'))) return dir;
  const home = venvHome(dirname(dir));
  return home && existsSync(join(home, 'conda-meta')) ? home : null;
}

/** `home` from a venv's pyvenv.cfg: the directory of the interpreter it was made from. */
function venvHome(root: string): string | null {
  try {
    const config = readFileSync(join(root, 'pyvenv.cfg'), 'utf8');
    return /^\s*home\s*=\s*(.+?)\s*$/m.exec(config)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The shebang and zip a launcher carries are appended, so only its end is read. */
const LAUNCHER_TAIL_BYTES = 64 * 1024;

/**
 * The interpreter behind a Windows console-script launcher such as
 * `Scripts\jupyter-nbconvert.exe`, which has no readable shebang line:
 *
 * - pip/distlib launchers append `#!<python>` and a zip archive to the exe;
 * - setuptools and Conda launchers run a sibling `<name>-script.py`, which
 *   may carry a shebang, and otherwise start the interpreter one directory
 *   up (`<prefix>\python.exe` beside `<prefix>\Scripts`);
 * - a venv keeps `python.exe` beside its scripts.
 */
export function launcherPython(launcher: string): string | null {
  const candidates = [
    appendedShebang(launcher),
    scriptShebang(launcher.replace(/\.exe$/i, '-script.py')),
    join(dirname(launcher), 'python.exe'),
    join(dirname(dirname(launcher)), 'python.exe'),
  ];
  return (
    candidates.find(
      (python): python is string =>
        python !== null && win32.isAbsolute(python) && isWindowsPython(python),
    ) ?? null
  );
}

function appendedShebang(launcher: string): string | null {
  let tail: string;
  let fd: number | null = null;
  try {
    fd = openSync(launcher, 'r');
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, LAUNCHER_TAIL_BYTES));
    const read = readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    tail = bytes.subarray(0, read).toString('latin1');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  // `#!C:\Python312\python.exe`, a line break, then the zip's first local header.
  const header = 'PK\x03\x04';
  for (let at = tail.indexOf(header); at >= 0; at = tail.indexOf(header, at + 1)) {
    if (tail[at - 1] !== '\n') continue;
    const start = tail.lastIndexOf('#!', at);
    return start < 0 ? null : shebangProgram(tail.slice(start + 2, at));
  }
  return null;
}

function scriptShebang(script: string): string | null {
  try {
    const line = readFileSync(script, 'utf8').split(/\r?\n/, 1)[0] ?? '';
    return line.startsWith('#!') ? shebangProgram(line.slice(2)) : null;
  } catch {
    return null;
  }
}

/** The program a shebang names: quoted when its path has spaces, else up to whitespace. */
function shebangProgram(line: string): string | null {
  const text = line.trim();
  const program = text.startsWith('"') ? /^"([^"]+)"/.exec(text)?.[1] : text.split(/\s/)[0];
  return program || null;
}

/**
 * Whether Windows can start `path` as a Python interpreter: an `.exe`, or an
 * App Execution Alias (the Microsoft Store's Python) other than the App
 * Installer's redirector stub, which only offers to install Python. Aliases
 * cannot be stat'ed (EACCES), so they are recognised by their link target.
 */
export function isWindowsPython(path: string): boolean {
  if (extname(path).toLowerCase() !== '.exe') return false;
  try {
    return statSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES') return false;
  }
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    const target = win32.basename(readlinkSync(path)).toLowerCase();
    return target !== 'appinstallerpythonredirector.exe';
  } catch {
    return false;
  }
}

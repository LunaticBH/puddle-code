import { posix, win32 } from 'node:path';

/** Match the executable or a direct Node/Bun entry point, never prompt arguments. */
export function matchesAgentProcess(
  command: string,
  binary: string,
  entryPoints: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return matchesWindowsProcess(command, binary, entryPoints);
  // ps does not preserve argv boundaries. Accept ordinary/quoted paths and
  // fail conservatively for ambiguous unquoted paths containing spaces.
  const words = command.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) ?? [];
  const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/, '$2');
  const executable = posix.basename(unquote(words[0] ?? ''));
  if (executable === binary) return true;
  if (!['node', 'nodejs', 'bun'].includes(executable)) return false;
  const script = unquote(words[1] ?? '');
  if (!script || script.startsWith('-')) return false;
  return (
    posix.basename(script) === binary || entryPoints.some((entry) => script.endsWith(`/${entry}`))
  );
}

/**
 * A Windows process: its full command line (`"C:\…\claude.exe" --resume x`,
 * `node.exe C:\…\node_modules\@openai\codex\bin\codex.js`), or only its image
 * name when Windows withholds the command line. Programs compare without
 * their extension and case-insensitively (docs/windows.md, decision 8), and
 * entry points by `/`-normalised suffix.
 */
function matchesWindowsProcess(
  command: string,
  binary: string,
  entryPoints: readonly string[],
): boolean {
  const words = windowsArgv(command);
  const program = (word: string) =>
    win32
      .basename(word)
      .replace(/\.(?:exe|com|cmd|bat)$/i, '')
      .toLowerCase();
  const executable = program(words[0] ?? '');
  const name = binary.toLowerCase();
  if (executable === name) return true;
  if (!['node', 'bun'].includes(executable)) return false;
  const script = words[1] ?? '';
  if (!script || script.startsWith('-')) return false;
  const normalised = script.replaceAll('\\', '/').toLowerCase();
  return (
    win32.basename(script).toLowerCase() === name ||
    entryPoints.some((entry) => normalised.endsWith(`/${entry.toLowerCase()}`))
  );
}

/**
 * Splits a command line as CommandLineToArgvW does: only double quotes group,
 * so `C:\Users\O'Neil` stays one word. The program name ends at its closing
 * quote or first whitespace; later arguments follow the C runtime's
 * backslash rules (2n backslashes before a quote give n and a toggle, 2n+1
 * give n and a literal quote).
 */
export function windowsArgv(line: string): string[] {
  const args: string[] = [];
  let index = line.search(/\S/);
  if (index === -1) return args;
  if (line[index] === '"') {
    const close = line.indexOf('"', index + 1);
    args.push(line.slice(index + 1, close === -1 ? undefined : close));
    index = close === -1 ? line.length : close + 1;
  } else {
    const end = line.slice(index).search(/\s/);
    args.push(end === -1 ? line.slice(index) : line.slice(index, index + end));
    index = end === -1 ? line.length : index + end;
  }
  let current: string | null = null;
  let quoted = false;
  while (index < line.length) {
    const character = line[index]!;
    if (!quoted && /\s/.test(character)) {
      if (current !== null) args.push(current);
      current = null;
      index++;
      continue;
    }
    if (character === '\\') {
      let run = 0;
      while (line[index + run] === '\\') run++;
      if (line[index + run] === '"') {
        current = (current ?? '') + '\\'.repeat(Math.floor(run / 2));
        if (run % 2 === 1) current += '"';
        else quoted = !quoted;
        index += run + 1;
      } else {
        current = (current ?? '') + '\\'.repeat(run);
        index += run;
      }
      continue;
    }
    if (character === '"') {
      current ??= '';
      quoted = !quoted;
    } else current = (current ?? '') + character;
    index++;
  }
  if (current !== null) args.push(current);
  return args;
}

import { ApiError } from '../http/errors.js';

const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '>', '>>', '<', '<<']);

/**
 * Parse one human-editable command without invoking a shell. POSIX follows
 * sh quoting: `\` escapes outside single quotes. Windows paths are full of
 * backslashes (`C:\Tools\gcc.exe`), so there `\` is always literal and only
 * quotes group words; a quote character is written inside the other kind.
 */
export function parseCommandTemplate(
  template: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const escapes = platform !== 'win32';
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  const push = () => {
    if (!started) return;
    if (SHELL_OPERATORS.has(word)) {
      throw ApiError.badRequest(
        'invalid_compilation_command',
        'Compilation commands run without a shell; pipes, redirects and command chaining are unsupported',
      );
    }
    words.push(word);
    word = '';
    started = false;
  };

  for (const char of template) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
      continue;
    }
    if (escapes && char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) push();
    else {
      word += char;
      started = true;
    }
  }
  if (escaped || quote !== null) {
    throw ApiError.badRequest(
      'invalid_compilation_command',
      'Compilation command has an unfinished quote or escape',
    );
  }
  push();
  if (words.length === 0 || words[0] === '') {
    throw ApiError.badRequest('invalid_compilation_command', 'Compilation command is empty');
  }
  return words;
}

export function expandCommandTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  const words = parseCommandTemplate(template, platform).map((word) =>
    word.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_match, name: string) => {
      const value = values[name];
      if (value === undefined) {
        throw ApiError.badRequest(
          'invalid_compilation_command',
          `Unknown compilation command placeholder {{${name}}}`,
        );
      }
      return value;
    }),
  );
  return { file: words[0]!, args: words.slice(1) };
}

/** Render discovered argv as an editable command while preserving token boundaries. */
export function commandTemplate(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const quote = platform === 'win32' ? quoteWindowsCommandWord : quoteCommandWord;
  return [file, ...args].map(quote).join(' ');
}

function quoteCommandWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./{}-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Windows grammar: backslashes need no quoting, and `"` is the familiar quote. */
function quoteWindowsCommandWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\{}-]+$/.test(word)) return word;
  if (!word.includes('"')) return `"${word}"`;
  if (!word.includes("'")) return `'${word}'`;
  // Both quote kinds: adjacent quoted segments form one word.
  return word
    .split('"')
    .map((part) => `"${part}"`)
    .join(`'"'`);
}

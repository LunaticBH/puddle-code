/**
 * Literal quoting for the shells agent CLIs run hook commands through on
 * Windows. The POSIX hook commands keep their long-standing
 * `JSON.stringify` quoting and never use these.
 */

/**
 * A PowerShell single-quoted literal: nothing inside expands, and a quote is
 * escaped by doubling it. PowerShell also closes such a string on the
 * typographic single quotes U+2018 to U+201B, so those are doubled too.
 */
export function powershellLiteral(value: string): string {
  return `'${value.replace(/['\u2018-\u201b]/g, (quote) => quote + quote)}'`;
}

/**
 * A bash single-quoted literal for Git Bash, with forward slashes: Git Bash
 * accepts `C:/…` paths, and Claude Code's status-line guidance asks for
 * them. A quote closes the literal, is escaped, and reopens it.
 */
export function gitBashPathLiteral(path: string): string {
  return `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
}

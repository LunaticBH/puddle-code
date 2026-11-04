/**
 * PowerShell literals for the Windows agent hook and status-line commands
 * and the PowerShell session hook. The POSIX hook commands keep their
 * long-standing `JSON.stringify` quoting and never use these.
 */

/**
 * A PowerShell single-quoted literal: nothing inside expands, and a quote is
 * escaped by doubling it. PowerShell also closes such a string on the
 * typographic single quotes U+2018 to U+201B, so those are doubled too.
 */
export function powershellLiteral(value: string): string {
  return `'${value.replace(/['\u2018-\u201b]/g, (quote) => quote + quote)}'`;
}

import { execPath } from 'node:process';
import { powershellLiteral } from '../shell-quote.js';

/**
 * A Gemini CLI command hook running the daemon's Node on a helper script.
 *
 * POSIX: `"<node>" "<helper>" <args>`, run by `bash -c`.
 *
 * Windows: Gemini CLI runs every command hook through PowerShell
 * (`pwsh.exe -NoProfile -Command`, else `powershell.exe -NoProfile
 * -NonInteractive -Command`, or a PowerShell `ComSpec`), per
 * getShellConfiguration and HookRunner in gemini-cli's core package (main
 * branch read 2026-11; not run live, as no Gemini CLI was installed on the
 * port machine). PowerShell needs the `&` call operator before a quoted
 * program, and single-quoted literals keep a `$` in a path from expanding.
 */
export function geminiHookCommand(
  script: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    return [JSON.stringify(execPath), JSON.stringify(script), ...args].join(' ');
  }
  return ['&', powershellLiteral(execPath), powershellLiteral(script), ...args].join(' ');
}

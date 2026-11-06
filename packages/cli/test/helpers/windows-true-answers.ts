/**
 * What each Windows OpenSSH default shell writes to standard error for the
 * client's `ssh host true` probe (English hosts), byte for byte.
 */

/** cmd.exe (`cmd.exe /c true`). */
export const CMD_TRUE_ANSWER =
  "'true' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";

/** Windows PowerShell 5.1 (`powershell.exe -c true`, standard error piped), as captured. */
export const POWERSHELL_TRUE_ANSWER =
  "true : The term 'true' is not recognized as the name of a cmdlet, function, script file, or operable program. Check \r\n" +
  'the spelling of the name, or if a path was included, verify that the path is correct and try again.\r\n' +
  'At line:1 char:1\r\n' +
  '+ true\r\n' +
  '+ ~~~~\r\n' +
  '    + CategoryInfo          : ObjectNotFound: (true:String) [], CommandNotFoundException\r\n' +
  '    + FullyQualifiedErrorId : CommandNotFoundException\r\n' +
  ' \r\n';

/** PowerShell 7's concise error view, coloured. */
export const PWSH_TRUE_ANSWER =
  "\x1b[31;1mtrue: \x1b[31;1mThe term 'true' is not recognized as a name of a cmdlet, function, script file, or executable program.\x1b[0m\r\n" +
  '\x1b[31;1mCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.\x1b[0m\r\n';

/** ssh's own line before authentication, on standard error. */
export const HOST_KEY_WARNING =
  "Warning: Permanently added 'winbox' (ED25519) to the list of known hosts.\r\n";

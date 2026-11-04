/**
 * `@puddle/shared/node/platform`: the operating-system seams of the Windows
 * port (docs/windows.md). Each helper takes an injectable `platform`, so both
 * branches are testable on any OS, and leaves POSIX behaviour unchanged.
 */
export {
  deleteEnv,
  envKey,
  getEnv,
  pathListDelimiter,
  prependPathEntry,
  setEnv,
  system32Path,
  type Environment,
} from './environment.js';
export {
  DEFAULT_PATHEXT,
  disableCurrentDirectorySearch,
  findExecutable,
  restoreCurrentDirectorySearch,
  windowsExtensions,
  type FindExecutableOptions,
} from './executables.js';
export { isPidAlive, killProcessTree, type KillProcessTreeOptions } from './processes.js';
export { renameWithRetry, renameWithRetrySync } from './rename.js';
export {
  quoteCmdArgument,
  resolveSpawn,
  UnsafeCmdArgumentError,
  type ResolvedSpawn,
  type ResolveSpawnOptions,
} from './windows-spawn.js';
export {
  listWindowsProcesses,
  WindowsProcessTable,
  type WindowsProcess,
  type WindowsProcessTableOptions,
} from './windows-process-table.js';

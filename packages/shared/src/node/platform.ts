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
  isWindowsArch,
  peImage,
  peMachine,
  windowsArchFromProcessor,
  windowsHostArch,
  type PeImage,
  type PeMachine,
  type WindowsArch,
  type WindowsHostArchOptions,
} from './windows-arch.js';
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
export {
  createWindowsProcess,
  registerWindowsTask,
  runWindowsPowerShell,
  startWindowsTask,
  unregisterWindowsTask,
  windowsTaskState,
  windowsTaskXml,
  type PowerShellResult,
  type PowerShellRunner,
  type WindowsTaskAction,
  type WindowsTaskDefinition,
  type WindowsTaskOptions,
  type WindowsTaskRegistration,
  type WindowsTaskStart,
  type WindowsTaskState,
} from './windows-tasks.js';
export {
  connectorPipeSquatted,
  connectorPipeState,
  controlPipeState,
  requestDaemonShutdown,
  supervisorRequest,
  type ControlPipeState,
  type ShutdownOutcome,
  type SupervisorAnswer,
} from './windows-pipes.js';
export {
  canonicalWindowsHome,
  connectorSupervisedMarker,
  DAEMON_ALREADY_ACTIVE_EXIT,
  daemonEnvironment,
  LOG_ROTATE_BYTES,
  openRotated,
  registerSupervisorTask,
  shipsSupervisor,
  startWindowsSupervisor,
  superviseWindowsConnector,
  supervisorCommandLine,
  supervisorPaths,
  supervisorTaskDefinition,
  supervisorTaskName,
  unschedulableHome,
  waitForSupervisor,
  WINDOWLESS_LAUNCHER,
  type StartSupervisorOptions,
  type SupervisorStart,
} from './windows-supervision.js';
export { currentWindowsUserSid, readCurrentWindowsUserSid } from './windows-acl.js';

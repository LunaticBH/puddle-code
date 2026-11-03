/**
 * The embedder seam (SPEC §10): everything a non-terminal shell needs to run
 * a puddle cockpit in-process. The `puddle` bin and the desktop app
 * (`packages/desktop`) are both thin consumers of these exports — one
 * codebase, two downstream builds. Nothing here touches the process
 * (no console, no TTY, no process.exit); loggers and behaviour are injected.
 *
 * Keep this surface deliberate: adding an export here is a commitment that
 * both shells (and future ones) can build on it.
 */

export { startLocal, type StartOptions } from './connection/start.js';
export { connectRemote, type ConnectOptions } from './connection/connect.js';
export type { RunningCockpit } from './connection/cockpit.js';
export {
  daemonUpgradeMessage,
  type ConfirmDaemonUpgrade,
  type DaemonUpgradeRequest,
} from './connection/handshake.js';
export { CliError, silentLogger, type CliErrorCode, type CliEvent, type Logger } from './types.js';
export { cliVersion, pinnedDaemonVersion } from './version.js';
export { clientHome } from './paths.js';
export {
  componentProtocolForVersion,
  formatComponentVersions,
  installedComponentVersions,
  recordDesktopInstallation,
  type DesktopInstallation,
  type InstalledComponentVersion,
  type SpeakingProtocol,
} from './installation/component-versions.js';
export {
  applyDesktopUpdate,
  checkForDesktopUpdate,
  findInstalledDesktopApp,
  isDesktopAppRunning,
  pruneDesktopUpdateCache,
  stageDesktopUpdate,
  type DesktopUpdate,
  type StagedDesktopUpdate,
} from './installation/desktop-update.js';

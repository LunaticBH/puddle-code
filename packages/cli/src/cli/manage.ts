import { upgradeCli, removeCli } from './manage-cli.js';
import { acquireAuthority } from '../lib/auth/connection-authority.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session } from '@puddle/shared';
import { installedVersion } from '../lib/installation/bootstrap.js';
import {
  componentProtocolForVersion,
  recordDesktopInstallation,
} from '../lib/installation/component-versions.js';
import { DaemonClient, readDaemonPort } from '../lib/connection/daemon-client.js';
import {
  applyDesktopUpdate,
  checkForDesktopUpdate,
  desktopAppInstallPath,
  desktopUpdateAt,
  findInstalledDesktopApp,
  isDesktopAppRunning,
  isNewerVersion,
  pruneDesktopUpdateCache,
  stageDesktopUpdate,
  uninstallWindowsDesktop,
} from '../lib/installation/desktop-update.js';
import { waitForHttp } from '../lib/transport/net.js';
import { latestReleaseVersion } from '../lib/installation/releases.js';
import { removeDaemon, sweepDirtyWorktrees } from '../lib/installation/remove-daemon.js';
import { checkCockpit, readCockpitRecord, removeCockpitRecord } from '../lib/registry.js';
import { openTunnel } from '../lib/transport/tunnel.js';
import { LocalTransport } from '../lib/transport/local.js';
import { SshTransport } from '../lib/transport/ssh.js';
import type { Transport } from '../lib/transport/transport.js';
import { CliError, type Logger } from '../lib/types.js';
import { upgradeDaemon } from '../lib/installation/upgrade.js';
import { cliVersion, pinnedDaemonVersion } from '../lib/version.js';
import type { Command, Component } from './args.js';
import { terminateCockpit } from './detach.js';
import { ask, confirm } from './prompt.js';

/**
 * `puddle install / upgrade / remove` — component management (SPEC §10).
 * install ensures a component is present (at a version); upgrade moves it to
 * the newest release (or the named one), installing it when absent; remove
 * uninstalls after confirmation. The daemon is the only component that lives
 * on remote hosts; cli and desktop are client-machine artefacts.
 */

/** cli/desktop refuse a user@host target rather than half-support remote surgery. */
function assertLocal(what: Component, host: string | undefined, verb: string): void {
  if (host === undefined || host === 'local') return;
  throw new CliError(
    'bad_arguments',
    `puddle ${verb} ${what} runs on the machine it ${verb}s`,
    `ssh into ${host} and run it there — user@host targets the daemon only`,
  );
}

async function openTransport(host: string | undefined): Promise<Transport> {
  const transport: Transport =
    host === undefined || host === 'local' ? new LocalTransport() : new SshTransport(host);
  if (transport instanceof SshTransport) await transport.open();
  return transport;
}

/**
 * The daemon release a versionless install/upgrade lands on: the newest
 * published release, resolved client-side so messages can name it up front —
 * falling back to the CLI's own version train when the release API is
 * unreachable (still a correct daemon; the note says which train it came from).
 */
async function resolveDaemonVersion(logger: Logger): Promise<string> {
  try {
    return await latestReleaseVersion();
  } catch (e) {
    const pinned = pinnedDaemonVersion();
    logger.warn(
      `cannot resolve the newest release (${e instanceof Error ? e.message : String(e)}) — using this CLI's version train v${pinned}`,
    );
    return pinned;
  }
}

/**
 * An explicit @version can pin the daemon across a protocol major from this
 * CLI — which the next `puddle launch` would auto-upgrade straight back (the
 * forced-upgrade mechanism working as designed). Only the CLI's own version
 * is guaranteed skew-free, so anything else earns the warning.
 */
function pinWarning(logger: Logger, version: string): void {
  if (version === cliVersion()) return;
  logger.warn(
    `pinning the daemon to v${version} while this CLI is v${cliVersion()} — if the two speak ` +
      `different protocol majors, the next \`puddle launch\` will upgrade the daemon back (or refuse). ` +
      `Pin the CLI too (puddle upgrade cli@v${version}) or launch with --no-upgrade.`,
  );
}

// ---------------------------------------------------------------------------
// install

export async function runInstall(
  cmd: Extract<Command, { cmd: 'install' }>,
  logger: Logger,
): Promise<number> {
  if (cmd.what === 'desktop') {
    assertLocal('desktop', cmd.host, 'install');
    if (cmd.tarball !== undefined) {
      throw new CliError('bad_arguments', '--tarball applies to the daemon only');
    }
    return setDesktop({ version: cmd.version, verb: 'install' }, logger);
  }

  const transport = await openTransport(cmd.host);
  try {
    const installed = await installedVersion(transport);
    // install = ensure present: an installed daemon with no version named is
    // exactly what was asked for.
    if (installed !== null && cmd.version === undefined) {
      logger.info(
        `puddled v${installed} is already installed on ${transport.label} — ` +
          `\`puddle upgrade daemon\` moves it to the newest release`,
      );
      return 0;
    }
    if (installed !== null && installed === cmd.version) {
      logger.info(`puddled v${installed} is already installed on ${transport.label}`);
      return 0;
    }
    return installDaemonAt(transport, cmd.version, cmd.tarball, logger);
  } finally {
    transport.dispose();
  }
}

/** Resolve the version (explicit → tarball-derived → newest), warn, install. */
async function installDaemonAt(
  transport: Transport,
  explicit: string | undefined,
  tarball: string | undefined,
  logger: Logger,
): Promise<number> {
  // A tarball names its own version (install.sh derives it from the file name).
  const version =
    explicit ?? (tarball !== undefined ? undefined : await resolveDaemonVersion(logger));
  if (explicit !== undefined) pinWarning(logger, explicit);
  const result = await upgradeDaemon(transport, {
    ...(version !== undefined ? { version } : {}),
    ...(tarball !== undefined ? { tarball } : {}),
    logger,
  });
  logger.info(`puddled ${result.from ?? '(fresh install)'} → ${result.to} on ${transport.label}`);
  return 0;
}

// ---------------------------------------------------------------------------
// upgrade

export async function runUpgrade(
  cmd: Extract<Command, { cmd: 'upgrade' }>,
  logger: Logger,
): Promise<number> {
  if (cmd.what !== undefined) {
    if (cmd.what !== 'daemon' && cmd.tarball !== undefined) {
      throw new CliError('bad_arguments', '--tarball applies to the daemon only');
    }
    switch (cmd.what) {
      case 'cli':
        assertLocal('cli', cmd.host, 'upgrade');
        return upgradeCli(cmd.version, logger);
      case 'desktop':
        assertLocal('desktop', cmd.host, 'upgrade');
        return setDesktop({ version: cmd.version, verb: 'upgrade' }, logger);
      case 'daemon': {
        const transport = await openTransport(cmd.host);
        try {
          return await installDaemonAt(transport, cmd.version, cmd.tarball, logger);
        } finally {
          transport.dispose();
        }
      }
    }
  }

  // Bare upgrade: every component installed on the target. A remote target
  // hosts only a daemon (cli and desktop are client-machine artefacts).
  if (cmd.host !== undefined && cmd.host !== 'local') {
    logger.info(`${cmd.host} hosts the daemon only — upgrading it`);
    const transport = await openTransport(cmd.host);
    try {
      return await installDaemonAt(transport, cmd.version, cmd.tarball, logger);
    } finally {
      transport.dispose();
    }
  }

  const transport = new LocalTransport();
  const daemonInstalled = (await installedVersion(transport)) !== null;
  // An installed macOS app or Windows per-user install upgrades in place.
  const inPlaceDesktop = process.platform === 'darwin' || process.platform === 'win32';
  const desktopInstalled = inPlaceDesktop && (await findInstalledDesktopApp()) !== null;

  // Daemon and desktop first; the CLI LAST — its upgrade replaces the code
  // that is running this very command, so nothing may run after it but us
  // exiting. The already-loaded process finishes fine; a re-entry would not.
  if (daemonInstalled) await installDaemonAt(transport, cmd.version, cmd.tarball, logger);
  else logger.info('no daemon installed on this machine — skipping (puddle install daemon)');
  if (desktopInstalled) await setDesktop({ version: cmd.version, verb: 'upgrade' }, logger);
  else if (inPlaceDesktop) logger.info('no desktop app installed — skipping');
  return upgradeCli(cmd.version, logger);
}

// ---------------------------------------------------------------------------
// desktop (shared by install and upgrade)

/**
 * Put the desktop app at a version: the newest (upgrade semantics), or the
 * named one — downgrades included, naming a version is the point. Runs the
 * same check → stage → swap pipeline the app's own update toast uses, inline
 * while the app is closed (a running app must update from its toast: the
 * swap waits for the process to exit, which from here would hang).
 */
async function setDesktop(
  opts: { version?: string; verb: 'install' | 'upgrade' },
  logger: Logger,
): Promise<number> {
  // Linux: no conventional AppImage location exists, so install ASKS for one
  // (upgrades stay in-app — the running app knows its own $APPIMAGE path).
  if (process.platform === 'linux') {
    if (opts.verb !== 'install') {
      throw new CliError(
        'not_installed',
        'AppImages upgrade from inside the app (its toast knows $APPIMAGE)',
        'to place a fresh copy: puddle install desktop',
      );
    }
    return installDesktopAppImage(opts.version, logger);
  }
  const windows = process.platform === 'win32';
  const installed = await findInstalledDesktopApp();
  // A first Windows installation goes wherever the per-user installer puts it.
  const targetPath = installed?.appPath ?? (windows ? '' : await desktopAppInstallPath());
  if (targetPath === null) {
    // Linux branched off above; this is the no-such-platform case.
    throw new CliError('not_installed', 'the desktop app ships for macOS, Windows and Linux only');
  }
  if (installed !== null && (await isDesktopAppRunning(installed.appPath))) {
    throw new CliError(
      'already_running',
      'Puddle is running — use its update toast, or quit it and rerun',
    );
  }
  if (opts.verb === 'install' && installed !== null && opts.version === undefined) {
    logger.info(
      `Puddle ${installed.version} is already installed at ${installed.appPath} — ` +
        '`puddle upgrade desktop` moves it to the newest release',
    );
    return 0;
  }
  if (installed !== null && installed.version === opts.version) {
    logger.info(`Puddle ${installed.version} is already installed at ${installed.appPath}`);
    return 0;
  }

  const update =
    opts.version !== undefined
      ? await desktopUpdateAt(opts.version)
      : await checkForDesktopUpdate(installed?.version ?? '0.0.0');
  if (update === null) {
    if (opts.version !== undefined) {
      throw new CliError(
        'not_installed',
        `release v${opts.version} has no desktop build for this platform/architecture`,
      );
    }
    if (installed === null) {
      throw new CliError(
        'not_installed',
        `no Puddle desktop release is available for this ${windows ? 'Windows' : 'macOS'} architecture`,
      );
    }
    logger.info(`Puddle ${installed.version} is already the latest release`);
    return 0;
  }
  const move =
    installed === null
      ? `installing Puddle ${update.version}`
      : `Puddle ${installed.version} → ${update.version}` +
        (isNewerVersion(update.version, installed.version) ? '' : ' (a downgrade)');
  logger.info(move);
  // A signed installed Puddle.exe accepts only an installer from the same publisher.
  const staged = await stageDesktopUpdate(update, {
    logger,
    ...(windows && installed !== null ? { currentApp: installed.appPath } : {}),
  });
  await applyDesktopUpdate(staged, { targetPath, detach: false, relaunch: false, logger });
  const installedPath = windows ? (await findInstalledDesktopApp())?.appPath : targetPath;
  if (installedPath === undefined) {
    throw new CliError(
      'not_installed',
      'the Puddle installer finished without registering the app',
    );
  }
  const protocol = componentProtocolForVersion(update.version);
  recordDesktopInstallation({
    path: installedPath,
    version: update.version,
    ...(protocol ? { protocol } : {}),
  });
  logger.info(`Puddle ${update.version} installed at ${installedPath}`);
  return 0;
}

/**
 * Linux `install desktop`: download + verify the AppImage and place it where
 * the user says (there is no /Applications convention to assume). The file
 * keeps the stable name Puddle.AppImage so launchers point at a path the
 * app's own in-app updater can keep swapping. Afterwards the directory opens
 * in the file manager (best-effort) so the app is right there to run or drag
 * into a launcher.
 */
async function installDesktopAppImage(
  version: string | undefined,
  logger: Logger,
): Promise<number> {
  const update =
    version !== undefined ? await desktopUpdateAt(version) : await checkForDesktopUpdate('0.0.0');
  if (update === null) {
    throw new CliError(
      'not_installed',
      version !== undefined
        ? `release v${version} has no AppImage for this architecture`
        : 'no Puddle desktop release is available for this Linux architecture',
    );
  }
  const dir = expandHome(await ask('Where should the AppImage be stored?', '~/puddle'));
  const target = join(dir, 'Puddle.AppImage');
  if (existsSync(target) && version === undefined) {
    logger.info(`${target} already exists — the app updates itself in-app (its update toast)`);
    return 0;
  }
  logger.info(`installing Puddle ${update.version} to ${target}`);
  const staged = await stageDesktopUpdate(update, { logger });
  await mkdir(dir, { recursive: true });
  await rm(target, { force: true });
  try {
    await rename(staged.stagedPath, target); // same filesystem
  } catch {
    await copyFile(staged.stagedPath, target); // cache and target on different mounts
    await chmod(target, 0o755);
  }
  await rm(staged.dir, { recursive: true, force: true });
  const protocol = componentProtocolForVersion(update.version);
  recordDesktopInstallation({
    path: target,
    version: update.version,
    ...(protocol ? { protocol } : {}),
  });
  logger.info(`installed — run it directly (${target}) or add it to your launcher`);
  // Show the file where it landed; a headless box just skips this.
  const opener = spawn('xdg-open', [dir], { stdio: 'ignore', detached: true });
  opener.on('error', () => undefined);
  opener.unref();
  return 0;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

// ---------------------------------------------------------------------------
// remove

export async function runRemove(
  cmd: Extract<Command, { cmd: 'remove' }>,
  logger: Logger,
): Promise<number> {
  switch (cmd.what) {
    case 'cli':
      assertLocal('cli', cmd.host, 'remove');
      return removeCli(cmd.yes, logger);
    case 'desktop':
      assertLocal('desktop', cmd.host, 'remove');
      return removeDesktop(cmd.yes, logger);
    case 'daemon':
      return removeDaemonCmd(cmd, logger);
  }
}

async function removeDesktop(yes: boolean, logger: Logger): Promise<number> {
  if (process.platform === 'win32') return removeWindowsDesktop(yes, logger);
  if (process.platform !== 'darwin') {
    throw new CliError(
      'not_installed',
      'desktop removal is macOS-only',
      'an AppImage carries no fixed path — delete the file where you put it (puddle install desktop defaults to ~/puddle/Puddle.AppImage)',
    );
  }
  const installed = await findInstalledDesktopApp();
  if (installed === null) {
    logger.info('no Puddle.app in /Applications or ~/Applications — nothing to remove');
    return 0;
  }
  if (await isDesktopAppRunning(installed.appPath)) {
    throw new CliError('already_running', 'Puddle is running — quit it first');
  }
  const proceed = await confirm(
    `Delete ${installed.appPath} (Puddle ${installed.version})? Daemons and their sessions ` +
      `are untouched.`,
    { skip: yes },
  );
  if (!proceed) {
    logger.info('nothing removed');
    return 0;
  }
  await rm(installed.appPath, { recursive: true, force: true });
  await pruneDesktopUpdateCache([]);
  logger.info(`deleted ${installed.appPath} (recent hosts kept in ~/.puddle/recent-hosts.json)`);
  return 0;
}

/** Windows: the per-user installer's own uninstaller, run silently. */
async function removeWindowsDesktop(yes: boolean, logger: Logger): Promise<number> {
  const installed = await findInstalledDesktopApp();
  if (installed === null) {
    logger.info('no Puddle installation is registered for this Windows user — nothing to remove');
    return 0;
  }
  if (await isDesktopAppRunning(installed.appPath)) {
    throw new CliError('already_running', 'Puddle is running — quit it first');
  }
  const proceed = await confirm(
    `Uninstall Puddle ${installed.version} from ${dirname(installed.appPath)}? Daemons and ` +
      `their sessions are untouched.`,
    { skip: yes },
  );
  if (!proceed) {
    logger.info('nothing removed');
    return 0;
  }
  await uninstallWindowsDesktop(installed);
  await pruneDesktopUpdateCache([]);
  logger.info(
    `uninstalled Puddle ${installed.version} (recent hosts kept in ~/.puddle/recent-hosts.json)`,
  );
  return 0;
}

async function removeDaemonCmd(
  cmd: Extract<Command, { cmd: 'remove' }>,
  logger: Logger,
): Promise<number> {
  const target = cmd.host ?? 'local';
  const transport = await openTransport(cmd.host);
  let tunnel: Awaited<ReturnType<typeof openTunnel>> | null = null;
  try {
    const installed = await installedVersion(transport);
    if (installed === null) {
      logger.info(
        `no bootstrap-managed daemon on ${transport.label} — nothing to remove` +
          ` (its data, if any, stays under ~/.puddle)`,
      );
      return 0;
    }

    // Best-effort inventory: what this removal interrupts and whose data
    // stays behind. A daemon that is down simply lists as unknown.
    let live: Session[] | null = null;
    let profileNames: string[] | null = null;
    try {
      const authority = await acquireAuthority(transport);
      try {
        let port = await readDaemonPort(transport);
        if (transport instanceof SshTransport) {
          tunnel = await openTunnel(transport, port, {
            ready: (localPort) => waitForHttp(`http://127.0.0.1:${localPort}/api/version`, 8000),
          });
          port = tunnel.localPort;
        }
        const client = new DaemonClient(port, authority);
        live = await client.liveSessions();
        profileNames = (await client.profiles()).map((p) => p.name);
      } finally {
        authority.close();
      }
    } catch {
      // Daemon down or unreachable — the removal proceeds either way.
    }

    logger.info(`puddled v${installed} on ${transport.label}`);
    if (live !== null && live.length > 0) {
      logger.warn(`${live.length} running session(s) will be interrupted:`);
      for (const s of live) {
        logger.warn(`  ${s.id.slice(0, 8)}  ${s.status}  ${s.title ?? '(untitled)'}`);
      }
    }
    if (profileNames !== null && profileNames.length > 0) {
      logger.info(`profiles on this daemon: ${profileNames.join(', ')}`);
    }

    const proceed = await confirm(
      `Stop puddled v${installed} on ${transport.label}, unregister its supervisor, and ` +
        `uninstall it?`,
      { skip: cmd.yes },
    );
    if (!proceed) {
      logger.info('nothing removed');
      return 0;
    }

    // The purge decision: --purge asks for it outright; interactively it is
    // its own question, defaulting to NO so the data survives by default.
    let purge = cmd.purge;
    if (!purge && !cmd.yes) {
      purge = await confirm(
        `Also delete ~/.puddle on ${transport.label} — profiles, session history, agent ` +
          `credentials, and WORKTREES?`,
      );
    }
    if (purge) {
      const dirty = await sweepDirtyWorktrees(transport);
      if (dirty.length > 0) {
        logger.warn('these worktrees carry uncommitted or unpushed work:');
        for (const path of dirty) logger.warn(`  ${path}`);
        const anyway = cmd.yes
          ? true // --yes --purge: explicit flags, warned above
          : await confirm('Delete them anyway?');
        if (!anyway) {
          purge = false;
          logger.info('keeping ~/.puddle — only the install is removed');
        }
      }
    }

    // A cockpit for this target dies with its daemon.
    const record = readCockpitRecord(target);
    if (record !== null) {
      if ((await checkCockpit(record)) === 'dead') removeCockpitRecord(target);
      else {
        await terminateCockpit(record);
        logger.info(`stopped the cockpit for ${target}`);
      }
    }
    await tunnel?.close();
    tunnel = null;

    await removeDaemon(transport, { purge, logger });
    logger.info(
      purge
        ? `puddled removed from ${transport.label}; ~/.puddle deleted`
        : `puddled removed from ${transport.label}; data kept — \`puddle launch\` reinstalls and resumes`,
    );
    return 0;
  } finally {
    await tunnel?.close();
    transport.dispose();
  }
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  isWindowsArch,
  peImage,
  setEnv,
  system32Path,
  windowsHostArch,
} from '@puddle/shared/node/platform';
import { clientHome } from '../paths.js';
import { CliError, type Logger, silentLogger } from '../types.js';
import { repoSlug } from '../version.js';

/**
 * Self-update for the DESKTOP APP — the CLI-style alternative to Squirrel
 * (SPEC §10). Squirrel refuses unsigned bundles; this path has no such
 * requirement because nothing here goes through Gatekeeper: assets are
 * fetched the way install.sh fetches daemon tarballs (no quarantine
 * attribute), verified against the release's SHA256SUMS, and swapped in by a
 * detached helper script once the app has quit. Trust model is therefore
 * identical to the daemon bootstrap: the GitHub release is the root of
 * trust, the checksum guards transport integrity.
 *
 * Three phases, deliberately separable: `checkForDesktopUpdate` (cheap,
 * pollable), `stageDesktopUpdate` (download + verify + unpack, idempotent
 * per version), `applyDesktopUpdate` (spawn the swap helper; the caller
 * quits the app). The shell owns scheduling and UX.
 */

export interface DesktopUpdate {
  version: string;
  asset: { name: string; url: string };
  sumsUrl: string;
}

export interface StagedDesktopUpdate {
  version: string;
  kind: 'mac-app' | 'appimage' | 'nsis';
  /**
   * The unpacked .app bundle (mac), the verified AppImage file (linux) or the
   * verified one-click NSIS installer (windows).
   */
  stagedPath: string;
  /** The per-version staging directory, removed by the helper after a swap. */
  dir: string;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface CheckOptions {
  platform?: NodeJS.Platform;
  /**
   * The architecture whose build to pick. On Windows it defaults to the
   * operating system's (`hostArch`), so an x64 Puddle.exe or CLI emulated on
   * Arm moves to the native arm64 installer; elsewhere to `process.arch`.
   */
  arch?: string;
  /** Injectable for tests; defaults to `windowsHostArch()`. Windows only. */
  hostArch?: () => Promise<string>;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  logger?: Logger;
}

/** Strictly-newer x.y.z comparison; anything unparseable is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * The release asset for this platform/arch, or null when the release carries
 * none (e.g. darwin-x64, which the release workflow does not build).
 * electron-builder's names: `Puddle-<v>-arm64-mac.zip` / `Puddle-<v>-mac.zip`
 * and `Puddle-<v>-arm64.AppImage` / `Puddle-<v>.AppImage` — the arch token is
 * present exactly when the build is not x64. Windows installers always carry
 * it (`Puddle-<v>-x64-setup.exe`, `Puddle-<v>-arm64-setup.exe`: the NSIS
 * artifactName in electron-builder.yml), chosen by the OS architecture.
 */
export function pickDesktopAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | null {
  if (platform === 'win32') return pickWindowsInstaller(assets, arch);
  const suffix = platform === 'darwin' ? '-mac.zip' : platform === 'linux' ? '.AppImage' : null;
  if (suffix === null) return null;
  // electron-builder omits the arch token exactly when the build is x64, so
  // the `-arm64` marker's presence must equal "this machine is arm64".
  return (
    assets.find(
      (a) => a.name.endsWith(suffix) && a.name.includes('-arm64') === (arch === 'arm64'),
    ) ?? null
  );
}

/** The installer built for this machine's architecture; Windows on Arm never takes the x64 build. */
function pickWindowsInstaller(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  if (!isWindowsArch(arch)) return null;
  return assets.find((a) => a.name.endsWith(`-${arch}-setup.exe`)) ?? null;
}

/** The `<sha256>  <filename>` map from a SHA256SUMS document. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!);
  }
  return sums;
}

/**
 * Ask GitHub for the latest release and return the update this machine
 * should install, or null when already current (or nothing is published for
 * this platform). Throws on network/API failure — pollers catch and retry.
 */
export async function checkForDesktopUpdate(
  currentVersion: string,
  opts: CheckOptions = {},
): Promise<DesktopUpdate | null> {
  const slug = repoSlug();
  if (slug === undefined) return null; // dev build: no release source, nothing to offer
  const fetchFn = opts.fetchFn ?? fetch;
  const response = await fetchFn(`https://api.github.com/repos/${slug}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'puddle-desktop' },
  });
  if (!response.ok) {
    throw new CliError('not_installed', `release lookup failed (HTTP ${response.status})`);
  }
  const release = (await response.json()) as { tag_name?: string; assets?: ReleaseAsset[] };
  const version = (release.tag_name ?? '').replace(/^v/, '');
  if (!isNewerVersion(version, currentVersion)) return null;
  return updateFromRelease(version, release.assets ?? [], opts);
}

/**
 * The desktop update for a SPECIFIC release (`puddle install/upgrade
 * desktop@version`, SPEC §10) — downgrades included: naming a version is the
 * point. Throws when the tag does not exist; null when the release carries
 * nothing for this platform.
 */
export async function desktopUpdateAt(
  version: string,
  opts: CheckOptions = {},
): Promise<DesktopUpdate | null> {
  const slug = repoSlug();
  if (slug === undefined) {
    throw new CliError(
      'not_installed',
      'no release source is configured for this build',
      'set PUDDLE_REPO=owner/repo',
    );
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const response = await fetchFn(`https://api.github.com/repos/${slug}/releases/tags/v${version}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'puddle-desktop' },
  });
  if (response.status === 404) {
    throw new CliError('not_installed', `no release v${version} exists in ${slug}`);
  }
  if (!response.ok) {
    throw new CliError('not_installed', `release lookup failed (HTTP ${response.status})`);
  }
  const release = (await response.json()) as { assets?: ReleaseAsset[] };
  return updateFromRelease(version, release.assets ?? [], opts);
}

/** The platform asset + checksums of one release, as a stageable update. */
async function updateFromRelease(
  version: string,
  assets: ReleaseAsset[],
  opts: CheckOptions,
): Promise<DesktopUpdate | null> {
  const platform = opts.platform ?? process.platform;
  const arch =
    opts.arch ?? (platform === 'win32' ? await (opts.hostArch ?? windowsHostArch)() : process.arch);
  const asset = pickDesktopAsset(assets, platform, arch);
  const sums = assets.find((a) => a.name === 'SHA256SUMS');
  if (asset === null || sums === undefined) return null; // released, but not for this machine
  return {
    version,
    asset: { name: asset.name, url: asset.browser_download_url },
    sumsUrl: sums.browser_download_url,
  };
}

export interface StageOptions {
  cacheDir?: string;
  fetchFn?: typeof fetch;
  logger?: Logger;
  platform?: NodeJS.Platform;
  /**
   * Windows: the Puddle.exe the installer will replace (the running app, or
   * the installed one for `puddle upgrade desktop`). When it carries an
   * Authenticode signature, the staged installer must be validly signed by
   * the same publisher; an unsigned app keeps checksum-only trust.
   */
  currentApp?: string;
  /** Injectable for tests: runs a Windows PowerShell script and returns its stdout. */
  powershell?: PowerShellRunner;
}

/**
 * Download the asset into ~/.puddle/cache/desktop/<version>/, verify it
 * against the release's SHA256SUMS, and unpack it ready to swap. Any failure
 * removes the staging directory — a stage either completes or leaves nothing.
 */
export async function stageDesktopUpdate(
  update: DesktopUpdate,
  opts: StageOptions = {},
): Promise<StagedDesktopUpdate> {
  const logger = opts.logger ?? silentLogger;
  const platform = opts.platform ?? process.platform;
  const fetchFn = opts.fetchFn ?? fetch;
  const dir = join(opts.cacheDir ?? join(clientHome(), 'cache', 'desktop'), update.version);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    logger.info(`downloading ${update.asset.name}`);
    const archive = join(dir, update.asset.name);
    const response = await fetchFn(update.asset.url, {
      headers: { 'user-agent': 'puddle-desktop' },
    });
    if (!response.ok || response.body === null) {
      throw new CliError('not_installed', `download failed (HTTP ${response.status})`);
    }
    // The DOM-typed body IS a node web stream at runtime; the lib types just
    // disagree about pipeThrough's generics.
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      createWriteStream(archive),
    );

    const sumsResponse = await fetchFn(update.sumsUrl, {
      headers: { 'user-agent': 'puddle-desktop' },
    });
    if (!sumsResponse.ok) {
      throw new CliError('not_installed', `SHA256SUMS fetch failed (HTTP ${sumsResponse.status})`);
    }
    const expected = parseSums(await sumsResponse.text()).get(update.asset.name);
    if (expected === undefined) {
      throw new CliError('not_installed', `${update.asset.name} is not in SHA256SUMS`);
    }
    const actual = await fileSha256(archive);
    if (actual !== expected) {
      throw new CliError(
        'not_installed',
        `checksum mismatch for ${update.asset.name}`,
        `expected ${expected}, got ${actual}`,
      );
    }

    if (platform === 'win32') {
      // The verified installer is the whole update: it unpacks itself.
      if (!update.asset.name.endsWith('.exe')) {
        throw new CliError('not_installed', `${update.asset.name} is not a Windows installer`);
      }
      if (opts.currentApp !== undefined) {
        await assertSamePublisher(
          opts.currentApp,
          archive,
          opts.powershell ?? runWindowsPowerShell,
        );
      }
      logger.info(`staged ${update.version} at ${archive}`);
      return { version: update.version, kind: 'nsis', stagedPath: archive, dir };
    }
    if (update.asset.name.endsWith('.zip')) {
      // ditto preserves the bundle's symlinks, permissions and extended
      // attributes — unzip(1) historically has not, and a subtly broken
      // Electron .app fails codesign-less launch in odd ways.
      const extractDir = join(dir, 'extract');
      await run('/usr/bin/ditto', ['-x', '-k', archive, extractDir]);
      const bundle = (await readdir(extractDir)).find((name) => name.endsWith('.app'));
      if (bundle === undefined) {
        throw new CliError('not_installed', 'the update zip contains no .app bundle');
      }
      logger.info(`staged ${update.version} at ${join(extractDir, bundle)}`);
      return {
        version: update.version,
        kind: 'mac-app',
        stagedPath: join(extractDir, bundle),
        dir,
      };
    }
    await chmod(archive, 0o755);
    logger.info(`staged ${update.version} at ${archive}`);
    return { version: update.version, kind: 'appimage', stagedPath: archive, dir };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Remove staged-update directories that can no longer be applied: everything
 * under the cache except the versions in `keep` (pass the just-staged version
 * after a stage; nothing at app boot — a stage always re-downloads into a
 * clean dir, so a leftover is dead weight even when its version is current).
 * Successive releases otherwise accumulate one full download per version,
 * forever. Fails soft: a cache that cannot be pruned is a nuisance, not an
 * error worth surfacing.
 */
export async function pruneDesktopUpdateCache(
  keep: string[] = [],
  opts: { cacheDir?: string } = {},
): Promise<void> {
  const dir = opts.cacheDir ?? join(clientHome(), 'cache', 'desktop');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // no cache yet
  }
  await Promise.all(
    entries
      .filter((name) => !keep.includes(name))
      .map((name) => rm(join(dir, name), { recursive: true, force: true }).catch(() => {})),
  );
}

export interface ApplyOptions {
  /**
   * What to replace: the installed .app bundle (mac) or AppImage path
   * (linux). On Windows, the installed Puddle.exe; the installer itself
   * chooses where a first installation goes.
   */
  targetPath: string;
  /**
   * Wait for this process to exit before swapping — the in-app flow passes
   * its own pid and quits; the CLI flow (app not running) omits it.
   */
  waitPid?: number;
  /**
   * Detach the helper and return immediately (the in-app flow — the swap
   * outlives the app). false runs it to completion and throws on failure
   * (the CLI flow).
   */
  detach?: boolean;
  relaunch: boolean;
  logger?: Logger;
}

/**
 * Run the swap helper script. Detached (default), it is fire-and-forget and
 * the CALLER must then quit the app: the helper waits for `waitPid` to die,
 * moves the old install aside, moves the staged one in (falling back to a
 * copy across volumes), relaunches, and cleans up — restoring the old
 * install if the swap fails halfway.
 */
export async function applyDesktopUpdate(
  staged: StagedDesktopUpdate,
  opts: ApplyOptions,
): Promise<void> {
  const logger = opts.logger ?? silentLogger;
  if (staged.kind === 'nsis') return applyNsisUpdate(staged, opts, logger);
  const script = swapScript(staged, opts);
  const scriptPath = join(staged.dir, 'apply.sh');
  await writeFile(scriptPath, script, { mode: 0o755 });
  logger.info(`applying ${staged.version} via ${scriptPath}`);
  if (opts.detach ?? true) {
    const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  await run('/bin/sh', [scriptPath]);
}

/**
 * electron-builder's one-click installer replaces the per-user install
 * itself. `--updated` makes it wait for (then close) a running app instead of
 * asking, and keeps the shortcuts; `--force-run` relaunches after a silent
 * install. These are electron-updater's own arguments (NsisUpdater.doInstall).
 */
export function nsisInstallerArguments(update: boolean, relaunch: boolean): string[] {
  return [...(update ? ['--updated'] : []), '/S', ...(relaunch ? ['--force-run'] : [])];
}

async function applyNsisUpdate(
  staged: StagedDesktopUpdate,
  opts: ApplyOptions,
  logger: Logger,
): Promise<void> {
  const args = nsisInstallerArguments(existsSync(opts.targetPath), opts.relaunch);
  logger.info(`applying ${staged.version} via ${staged.stagedPath}`);
  if (opts.detach ?? true) {
    // The next boot's cache prune removes the installer, which cannot delete itself.
    const child = spawn(staged.stagedPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (e) => logger.warn(`could not start the installer: ${e.message}`));
    child.unref();
    return;
  }
  await run(staged.stagedPath, args);
  await rm(staged.dir, { recursive: true, force: true });
}

/** POSIX single-quoting, as bootstrap.ts quotes installer arguments. */
const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

function swapScript(staged: StagedDesktopUpdate, opts: ApplyOptions): string {
  const wait =
    opts.waitPid === undefined
      ? []
      : [
          `i=0`,
          `while kill -0 ${opts.waitPid} 2>/dev/null; do`,
          `  i=$((i+1)); [ "$i" -gt 600 ] && exit 1`,
          `  sleep 0.1`,
          `done`,
        ];
  if (staged.kind === 'mac-app') {
    return [
      `#!/bin/sh`,
      `# Puddle desktop update ${staged.version} — swap once the app exits`,
      ...wait,
      `target=${q(opts.targetPath)}`,
      `target_dir=${q(dirname(opts.targetPath))}`,
      `staged=${q(staged.stagedPath)}`,
      `mkdir -p "$target_dir" || exit 1`,
      `rm -rf "$target.old"`,
      `had_old=0`,
      `if [ -e "$target" ]; then`,
      `  mv "$target" "$target.old" || exit 1`,
      `  had_old=1`,
      `fi`,
      `if mv "$staged" "$target" 2>/dev/null || /usr/bin/ditto "$staged" "$target"; then`,
      // Defence in depth: the normal path never quarantines (node's fetch is
      // not a quarantine-opted-in app, and ditto only propagates what the
      // zip already carries), but if the bundle ever acquires the attribute
      // the swap must not resurrect the Gatekeeper prompt.
      `  /usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null`,
      `  rm -rf "$target.old" ${q(staged.dir)}`,
      ...(opts.relaunch ? [`  open "$target"`] : []),
      `else`,
      `  rm -rf "$target"`,
      `  [ "$had_old" -eq 0 ] || mv "$target.old" "$target"`,
      `  exit 1`,
      `fi`,
      ``,
    ].join('\n');
  }
  return [
    `#!/bin/sh`,
    `# Puddle desktop update ${staged.version} — swap once the app exits`,
    ...wait,
    `target=${q(opts.targetPath)}`,
    `cp -f ${q(staged.stagedPath)} "$target" || exit 1`,
    `chmod +x "$target"`,
    `rm -rf ${q(staged.dir)}`,
    ...(opts.relaunch ? [`"$target" >/dev/null 2>&1 &`] : []),
    ``,
  ].join('\n');
}

export interface DesktopAppLocationOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  systemApplicationsDir?: string;
  /** Injectable permission probe for tests. */
  canWrite?: (path: string) => Promise<boolean>;
  /** Injectable Windows registry read for tests. */
  readRegistry?: () => Promise<WindowsDesktopRegistration | null>;
}

export interface InstalledDesktopApp {
  appPath: string;
  version: string;
  /** Windows: the uninstaller command line the installer registered. */
  uninstallString?: string;
}

/**
 * The installed desktop app this machine could upgrade — macOS, and
 * Windows through the per-user NSIS registration. An AppImage can live
 * anywhere, so on Linux discovery is the app's own job (the in-app updater
 * knows its $APPIMAGE) and the CLI declines.
 */
export async function findInstalledDesktopApp(
  opts: DesktopAppLocationOptions = {},
): Promise<InstalledDesktopApp | null> {
  if ((opts.platform ?? process.platform) === 'win32') {
    return windowsInstalledApp(await (opts.readRegistry ?? readWindowsRegistration)());
  }
  if ((opts.platform ?? process.platform) !== 'darwin') return null;
  const { readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const systemApplications = opts.systemApplicationsDir ?? '/Applications';
  const home = opts.homeDir ?? homedir();
  for (const appPath of [
    join(systemApplications, 'Puddle.app'),
    join(home, 'Applications', 'Puddle.app'),
  ]) {
    try {
      const plist = await readFile(join(appPath, 'Contents/Info.plist'), 'utf8');
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
        plist,
      );
      if (match) return { appPath, version: match[1]! };
    } catch {
      // not installed here — try the next location
    }
  }
  return null;
}

/**
 * Where a fresh `puddle upgrade desktop` should install on macOS. Prefer the
 * conventional system Applications directory when this user can write it;
 * otherwise create and use the user's own ~/Applications directory. Linux
 * AppImages have no conventional install location, so return null there.
 */
export async function desktopAppInstallPath(
  opts: DesktopAppLocationOptions = {},
): Promise<string | null> {
  if ((opts.platform ?? process.platform) !== 'darwin') return null;
  const { homedir } = await import('node:os');
  const systemApplications = opts.systemApplicationsDir ?? '/Applications';
  const canWrite =
    opts.canWrite ??
    (async (path: string) => {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (await canWrite(systemApplications)) return join(systemApplications, 'Puddle.app');

  const userApplications = join(opts.homeDir ?? homedir(), 'Applications');
  await mkdir(userApplications, { recursive: true });
  return join(userApplications, 'Puddle.app');
}

/** Whether the installed app is currently running (its swap must wait). */
export function isDesktopAppRunning(
  appPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === 'win32') return isWindowsDesktopRunning(appPath);
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/pgrep', ['-f', `${appPath}/Contents/MacOS/`], {
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// ---------------------------------------------------------------------------
// Windows: the per-user one-click NSIS installation

/**
 * electron-builder's NSIS GUID for appId code.puddle.desktop (UUID v5 in its
 * namespace), pinned as `nsis.guid` in packages/desktop/electron-builder.yml.
 * It names both per-user registry keys the installer writes.
 */
export const WINDOWS_DESKTOP_GUID = '21877822-4423-5e9b-90ab-0b75b071b1b1';

export interface WindowsDesktopRegistration {
  version?: string | null;
  installLocation?: string | null;
  uninstallString?: string | null;
}

/** Puddle.exe inside the registered install directory, or null when absent. */
export function windowsInstalledApp(
  registration: WindowsDesktopRegistration | null,
): InstalledDesktopApp | null {
  const { version, installLocation, uninstallString } = registration ?? {};
  if (!version || !installLocation) return null;
  return {
    appPath: win32.join(installLocation, 'Puddle.exe'),
    version,
    ...(uninstallString ? { uninstallString } : {}),
  };
}

/**
 * `"C:\…\Uninstall Puddle.exe" /currentuser` → the program and its
 * arguments, run without a shell. Null for anything not in that shape.
 */
export function parseUninstallString(command: string): { file: string; args: string[] } | null {
  const match = /^"([^"]+\.exe)"\s*(.*)$/i.exec(command.trim());
  if (!match) return null;
  return { file: match[1]!, args: match[2]!.split(/\s+/).filter((arg) => arg !== '') };
}

/**
 * Reads HKCU's uninstall entry (version, uninstaller) and install key
 * (location) through Windows PowerShell, whose UTF-8 JSON keeps non-ASCII
 * profile paths intact (reg.exe prints in the OEM code page).
 */
function readWindowsRegistration(): Promise<WindowsDesktopRegistration | null> {
  const script = [
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
    `$u = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${WINDOWS_DESKTOP_GUID}' -ErrorAction SilentlyContinue`,
    `$i = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\${WINDOWS_DESKTOP_GUID}' -ErrorAction SilentlyContinue`,
    'if ($u) { [pscustomobject]@{ version = $u.DisplayVersion; installLocation = $i.InstallLocation; uninstallString = $u.UninstallString } | ConvertTo-Json -Compress }',
  ].join('\n');
  return new Promise((resolve) => {
    const child = spawn(
      system32Path('WindowsPowerShell\\v1.0\\powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        resolve(output.trim() === '' ? null : (JSON.parse(output) as WindowsDesktopRegistration));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Run the registered uninstaller silently and wait for the registration to
 * go: an NSIS uninstaller relaunches itself from %TEMP% and its first
 * process exits at once, so its exit code alone proves nothing.
 */
export async function uninstallWindowsDesktop(
  installed: InstalledDesktopApp,
  opts: {
    readRegistry?: () => Promise<WindowsDesktopRegistration | null>;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const uninstaller =
    installed.uninstallString === undefined
      ? null
      : parseUninstallString(installed.uninstallString);
  if (uninstaller === null) {
    throw new CliError(
      'not_installed',
      'the Puddle uninstaller is not registered',
      'remove Puddle from Settings → Apps → Installed apps',
    );
  }
  await run(uninstaller.file, [...uninstaller.args, '/S']);
  const readRegistry = opts.readRegistry ?? readWindowsRegistration;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  while (windowsInstalledApp(await readRegistry()) !== null) {
    if (Date.now() > deadline) {
      throw new CliError('not_installed', 'the Puddle uninstaller did not finish in time');
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 500));
  }
}

/** Runs a Windows PowerShell script with extra environment variables; resolves its stdout. */
export type PowerShellRunner = (script: string, env: Record<string, string>) => Promise<string>;

export interface AuthenticodeSignature {
  /** Get-AuthenticodeSignature's Status: Valid, NotSigned, HashMismatch, NotTrusted… */
  status: string;
  /** The signer certificate's subject (`CN=…, O=…, C=…`), or null when unsigned. */
  publisher: string | null;
}

/**
 * One Windows PowerShell call for every file. The paths travel in the
 * environment, so none is ever parsed as PowerShell; the output is UTF-8
 * JSON, which keeps a non-ASCII profile path or publisher intact.
 */
const AUTHENTICODE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Plain text on stderr: an -EncodedCommand error record would arrive as CLIXML.
  'trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  '[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
  '$signatures = @(foreach ($file in ($env:PUDDLE_AUTHENTICODE_FILES -split "`n")) {',
  '  $signature = Get-AuthenticodeSignature -LiteralPath $file',
  '  $publisher = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }',
  '  [pscustomobject]@{ status = [string]$signature.Status; publisher = $publisher }',
  '})',
  'ConvertTo-Json -InputObject $signatures -Compress',
].join('\n');

export async function readAuthenticodeSignatures(
  files: string[],
  powershell: PowerShellRunner = runWindowsPowerShell,
): Promise<AuthenticodeSignature[]> {
  const output = await powershell(AUTHENTICODE_SCRIPT, {
    PUDDLE_AUTHENTICODE_FILES: files.join('\n'),
  });
  const parsed = JSON.parse(output) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length !== files.length) throw new Error('Get-AuthenticodeSignature skipped a file');
  return rows.map((row) => {
    const { status, publisher } = (row ?? {}) as { status?: unknown; publisher?: unknown };
    return {
      status: typeof status === 'string' ? status : 'UnknownError',
      publisher: typeof publisher === 'string' && publisher !== '' ? publisher : null,
    };
  });
}

/**
 * A signed Puddle.exe accepts only an installer that Windows reports as
 * validly signed by the same publisher (the certificate subject: Azure
 * Trusted Signing renews its certificates every few days, so thumbprints
 * change between releases). The PE header shows whether the app is signed
 * without starting PowerShell, so an unsigned app keeps today's
 * checksum-only path; a signed one fails closed when the check cannot run.
 */
async function assertSamePublisher(
  currentApp: string,
  installer: string,
  powershell: PowerShellRunner,
): Promise<void> {
  if (peImage(currentApp)?.signed !== true) return;
  const name = win32.basename(installer);
  let signatures: AuthenticodeSignature[];
  try {
    signatures = await readAuthenticodeSignatures([currentApp, installer], powershell);
  } catch (e) {
    throw new CliError(
      'not_installed',
      `could not check the Authenticode signature of ${name}`,
      `Windows PowerShell must be able to run Get-AuthenticodeSignature (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const [current, staged] = signatures as [AuthenticodeSignature, AuthenticodeSignature];
  if (current.publisher === null) return;
  if (staged.status !== 'Valid' || staged.publisher !== current.publisher) {
    throw new CliError(
      'not_installed',
      staged.status !== 'Valid'
        ? `${name} is not validly signed (${staged.status}); this Puddle is signed by ${current.publisher}`
        : `${name} is signed by ${staged.publisher ?? 'nobody'}, not by ${current.publisher}`,
      'refusing the update; install from the official release page if you trust the new publisher',
    );
  }
}

function runWindowsPowerShell(script: string, extra: Record<string, string>): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extra)) setEnv(env, key, value, 'win32');
  return new Promise((resolve, reject) => {
    const child = spawn(
      system32Path('WindowsPowerShell\\v1.0\\powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, timeout: 60_000 },
    );
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    child.stderr.on('data', (chunk: string) => (errors += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(plainText(errors) || `powershell.exe exited with ${code ?? 'a signal'}`),
          ),
    );
  });
}

/**
 * Windows PowerShell's stderr without the CLIXML progress records that
 * -EncodedCommand adds ("Preparing modules for first use").
 */
function plainText(stderr: string): string {
  return stderr
    .replace(/<Objs\b[\s\S]*?<\/Objs>/g, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && line.trim() !== '#< CLIXML')
    .join('\n');
}

/** This user's Puddle.exe processes, from tasklist (the installer's own check). */
function isWindowsDesktopRunning(appPath: string): Promise<boolean> {
  const image = win32.basename(appPath);
  const user = process.env.USERNAME;
  return new Promise((resolve) => {
    const child = spawn(
      system32Path('tasklist.exe'),
      [
        '/FI',
        `IMAGENAME eq ${image}`,
        ...(user ? ['/FI', `USERNAME eq ${user}`] : []),
        '/FO',
        'CSV',
        '/NH',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    child.on('error', () => resolve(false));
    child.on('close', () =>
      resolve(
        output
          .split(/\r?\n/)
          .some((line) => line.toLowerCase().startsWith(`"${image.toLowerCase()}"`)),
      ),
    );
  });
}

function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  return pipeline(createReadStream(path), hash).then(() => hash.digest('hex'));
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new CliError('not_installed', `${command} exited with ${code ?? 'signal'}`)),
    );
  });
}

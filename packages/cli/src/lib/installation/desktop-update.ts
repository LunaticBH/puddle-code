import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
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
  kind: 'mac-app' | 'appimage';
  /** The unpacked .app bundle (mac) or the verified AppImage file (linux). */
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
  arch?: string;
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
 * present exactly when the build is not x64.
 */
export function pickDesktopAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | null {
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
function updateFromRelease(
  version: string,
  assets: ReleaseAsset[],
  opts: CheckOptions,
): DesktopUpdate | null {
  const asset = pickDesktopAsset(
    assets,
    opts.platform ?? process.platform,
    opts.arch ?? process.arch,
  );
  const sums = assets.find((a) => a.name === 'SHA256SUMS');
  if (asset === null || sums === undefined) return null; // released, but not for this machine
  return {
    version,
    asset: { name: asset.name, url: asset.browser_download_url },
    sumsUrl: sums.browser_download_url,
  };
}

/**
 * Download the asset into ~/.puddle/cache/desktop/<version>/, verify it
 * against the release's SHA256SUMS, and unpack it ready to swap. Any failure
 * removes the staging directory — a stage either completes or leaves nothing.
 */
export async function stageDesktopUpdate(
  update: DesktopUpdate,
  opts: { cacheDir?: string; fetchFn?: typeof fetch; logger?: Logger } = {},
): Promise<StagedDesktopUpdate> {
  const logger = opts.logger ?? silentLogger;
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
  /** What to replace: the installed .app bundle (mac) or AppImage path (linux). */
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
}

/**
 * The installed desktop app this machine could upgrade — macOS only: an
 * AppImage can live anywhere, so on Linux discovery is the app's own job
 * (the in-app updater knows its $APPIMAGE) and the CLI declines.
 */
export async function findInstalledDesktopApp(
  opts: DesktopAppLocationOptions = {},
): Promise<{ appPath: string; version: string } | null> {
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
export function isDesktopAppRunning(appPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/pgrep', ['-f', `${appPath}/Contents/MacOS/`], {
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
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

import { CliError } from '../types.js';
import { repoSlug } from '../version.js';

/** A component the release workflow publishes as a self-contained archive. */
export type ReleaseArchive = 'puddled' | 'puddle-cli';

/**
 * The `<platform>-<arch>` token of release archives (docs/windows.md §14).
 * Windows arm64 is not published yet; Windows on Arm runs the x64 build
 * under emulation.
 */
export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'win32-x64';
  return `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

/**
 * `puddled-v<v>-<target>.tar.gz`, or `.zip` on Windows, matching
 * scripts/build-tarball.mjs and build-cli-tarball.mjs; SHA256SUMS lists the
 * same names.
 */
export function releaseArchiveName(
  component: ReleaseArchive,
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  return `${component}-v${version}-${releaseTarget(platform, arch)}.${extension}`;
}

/** The download URL of one asset of the `v<version>` release. */
export function releaseAssetUrl(slug: string, version: string, asset: string): string {
  return `https://github.com/${slug}/releases/download/v${version}/${asset}`;
}

/**
 * Release-version resolution for `puddle install`/`upgrade` (SPEC §10):
 * "newest" means the repository's latest published release, resolved
 * client-side so messages and pin warnings can name the version before any
 * installer runs. install.sh can resolve latest itself, but only after the
 * CLI has already committed to running it.
 */
export async function latestReleaseVersion(opts: { fetchFn?: typeof fetch } = {}): Promise<string> {
  const slug = repoSlug();
  if (slug === undefined) {
    throw new CliError(
      'not_installed',
      'no release source is configured for this build',
      'name a version and pass --tarball, or set PUDDLE_REPO=owner/repo',
    );
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`https://api.github.com/repos/${slug}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'puddle-cli' },
  });
  if (!res.ok) {
    throw new CliError(
      'not_installed',
      `release lookup failed (HTTP ${res.status})`,
      'name a version explicitly, e.g. puddle install daemon@v0.0.32',
    );
  }
  const tag = ((await res.json()) as { tag_name?: string }).tag_name ?? '';
  const version = tag.replace(/^v/, '');
  if (version === '') throw new CliError('not_installed', `${slug} has no published releases`);
  return version;
}

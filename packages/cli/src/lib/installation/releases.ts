import { CliError } from '../types.js';
import { repoSlug } from '../version.js';

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
